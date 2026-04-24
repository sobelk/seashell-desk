/**
 * System prompt assembly with SYSTEM.md cascade.
 *
 * For a given AGENT.md path, builds the full system prompt by:
 *   1. Walking up the directory tree from the agent's directory to DESK_ROOT
 *   2. Collecting every SYSTEM.md found along the way (outermost first)
 *   3. Appending own SCOPE.md (if present)
 *   4. Appending peer SCOPE.md files (siblings + direct children in the agent tree)
 *   5. Appending TOOLS.md
 *   6. Appending the agent's own MEMORY.md (if present) under a header naming
 *      its path relative to desk/, so the agent can persist notes across runs.
 *   7. Appending the agent's own AGENT.md under a "# Your AGENT.md file" header
 *      so the session-specific instructions are the final and most salient block.
 *
 * Peer visibility uses the logical agent tree: the "parent" of an agent is the
 * nearest ancestor directory that also contains an AGENT.md (or DESK_ROOT if none).
 * An agent sees the SCOPEs of its siblings (same parent) and its direct children.
 * Grandchild SCOPEs are blocked — the child agent surfaces them if needed.
 *
 * SYSTEM.md files inform agents — they do not create them. An AGENT.md file
 * is required for a directory to have an agent; a SYSTEM.md alone does nothing.
 *
 * Example — for desk/projects/finance/AGENT.md:
 *   desk/SYSTEM.md              (global conventions)
 *   desk/projects/SYSTEM.md     (if it exists — project-group conventions)
 *   desk/projects/finance/SCOPE.md   (own scope)
 *   desk/projects/{x}/SCOPE.md  (sibling project scopes)
 *   desk/TOOLS.md
 *   desk/projects/finance/MEMORY.md  (if it exists — under
 *                                     "# Your memory (projects/finance/MEMORY.md)" header)
 *   desk/projects/finance/AGENT.md   (finance agent instructions, under
 *                                     "# Your AGENT.md file" header)
 */

import { existsSync, readFileSync, readdirSync } from 'fs'
import path from 'path'

const DESK_ROOT = path.resolve(path.join(import.meta.dirname, '..', 'desk'))
const TOOLS_MD = path.join(DESK_ROOT, 'TOOLS.md')

/** Recursively find all directories under root that contain AGENT.md. */
function findAllAgentDirs(root: string): string[] {
  const result: string[] = []
  function scan(dir: string) {
    let entries: import('fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as import('fs').Dirent[]
    } catch { return }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const child = path.join(dir, entry.name as string)
      if (existsSync(path.join(child, 'AGENT.md'))) {
        result.push(child)
      }
      scan(child)
    }
  }
  scan(root)
  return result
}

/**
 * Return the nearest ancestor agent directory (or DESK_ROOT if none).
 * This defines the "logical parent" in the agent tree.
 */
function logicalParent(agentDir: string, allAgentDirs: string[]): string {
  const ancestors = allAgentDirs.filter(
    (d) => agentDir.startsWith(d + path.sep) && d !== agentDir,
  )
  if (ancestors.length === 0) return DESK_ROOT
  // Nearest = longest path
  return ancestors.sort((a, b) => b.length - a.length)[0]!
}

/**
 * Collect SCOPE.md content for agents visible to agentDir:
 *   - siblings (same logical parent, different dir)
 *   - direct children (logical parent === agentDir)
 * Excludes self and agents with no SCOPE.md.
 */
function collectPeerScopes(agentDir: string): { name: string; content: string }[] {
  const allAgentDirs = findAllAgentDirs(DESK_ROOT)
  const myParent = logicalParent(agentDir, allAgentDirs)

  const visible = allAgentDirs.filter((d) => {
    if (d === agentDir) return false
    if (!existsSync(path.join(d, 'SCOPE.md'))) return false
    const theirParent = logicalParent(d, allAgentDirs)
    // Sibling: same logical parent
    if (theirParent === myParent) return true
    // Child: their parent is me
    if (theirParent === agentDir) return true
    return false
  })

  return visible
    .map((d) => ({
      name: path.relative(DESK_ROOT, d),
      content: readFileSync(path.join(d, 'SCOPE.md'), 'utf8').trim(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Collect SYSTEM.md files from DESK_ROOT down to agentDir, outermost first.
 */
function collectSystemFiles(agentDir: string): string[] {
  const rel = path.relative(DESK_ROOT, agentDir)
  const segments = rel === '' ? [] : rel.split(path.sep)

  const dirs: string[] = [DESK_ROOT]
  for (let i = 0; i < segments.length; i++) {
    dirs.push(path.join(DESK_ROOT, ...segments.slice(0, i + 1)))
  }

  return dirs
    .map((d) => path.join(d, 'SYSTEM.md'))
    .filter(existsSync)
}

export interface AgentFile {
  /** Absolute path on disk (or comma-joined list for the SYSTEM.md cascade). */
  source: string
  /** Full textual content as it would appear to the agent. */
  content: string
}

export interface AgentFileSet {
  /** AGENT.md is required — its presence is what makes a directory an agent. */
  agent: AgentFile
  /** Own SCOPE.md (not ancestors'). */
  scope: AgentFile | null
  /** Concatenated SYSTEM.md cascade, outermost first, separated by `\n\n---\n\n`. */
  system: AgentFile | null
  /** Own MEMORY.md. */
  memory: AgentFile | null
  /** Own JOURNAL.md. */
  journal: AgentFile | null
}

/**
 * Collect the per-agent source files (AGENT.md, SCOPE.md, MEMORY.md, JOURNAL.md)
 * plus the inherited SYSTEM.md cascade for this agent. Used by the UI to show
 * individual file contents in a tab bar.
 */
export function collectAgentFiles(agentMdPath: string): AgentFileSet {
  const agentDir = path.dirname(path.resolve(agentMdPath))

  const readIfExists = (filePath: string): AgentFile | null => {
    if (!existsSync(filePath)) return null
    return { source: filePath, content: readFileSync(filePath, 'utf8') }
  }

  const agentContent = readFileSync(agentMdPath, 'utf8')

  const systemFiles = collectSystemFiles(agentDir)
  const system: AgentFile | null = systemFiles.length === 0
    ? null
    : {
        source: systemFiles.join(', '),
        content: systemFiles
          .map((f) => readFileSync(f, 'utf8').trim())
          .join('\n\n---\n\n'),
      }

  return {
    agent: { source: agentMdPath, content: agentContent },
    scope: readIfExists(path.join(agentDir, 'SCOPE.md')),
    system,
    memory: readIfExists(path.join(agentDir, 'MEMORY.md')),
    journal: readIfExists(path.join(agentDir, 'JOURNAL.md')),
  }
}

export function buildSystemPrompt(agentMdPath: string): string {
  const agentDir = path.dirname(path.resolve(agentMdPath))
  const today = new Date().toISOString().slice(0, 10)

  const systemFiles = collectSystemFiles(agentDir)
  const agentMd = readFileSync(agentMdPath, 'utf8')
  const toolsMd = readFileSync(TOOLS_MD, 'utf8')

  // Own SCOPE.md — the agent's public declaration of its own scope
  const ownScopePath = path.join(agentDir, 'SCOPE.md')
  const ownScope = existsSync(ownScopePath)
    ? `## Your scope (SCOPE.md)\n\n${readFileSync(ownScopePath, 'utf8').trim()}`
    : null

  // Peer SCOPEs: siblings + direct children in the agent tree
  const peerScopes = collectPeerScopes(agentDir)
  const peerScopeBlock = peerScopes.length > 0
    ? `## Peer agent scopes\n\n${peerScopes.map((s) => s.content).join('\n\n---\n\n')}`
    : null

  // Own MEMORY.md — persistent notes this agent has written for itself.
  // Headered with the path relative to desk/ so the agent knows exactly
  // which file to read/write when updating its memory.
  const memoryPath = path.join(agentDir, 'MEMORY.md')
  const memoryRel = path.relative(DESK_ROOT, memoryPath).split(path.sep).join('/')
  const memoryBlock = existsSync(memoryPath)
    ? [
        `# Your memory (${memoryRel})`,
        '',
        readFileSync(memoryPath, 'utf8').trim(),
      ].join('\n')
    : null

  const agentHeader = [
    '# Your AGENT.md file',
    '',
    'What follows are specific instructions for this session:',
    '',
    agentMd.trim(),
  ].join('\n')

  const sections: string[] = [
    `Today's date is ${today}.`,
    ...systemFiles.map((f) => readFileSync(f, 'utf8')),
    ...(ownScope ? [ownScope] : []),
    ...(peerScopeBlock ? [peerScopeBlock] : []),
    toolsMd.trim(),
    ...(memoryBlock ? [memoryBlock] : []),
    agentHeader,
  ]

  return sections
    .join('\n\n---\n\n')
    .replace(/---\s*\n\n---/g, '---')
}
