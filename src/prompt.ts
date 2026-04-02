/**
 * System prompt assembly with SYSTEM.md cascade.
 *
 * For a given AGENT.md path, builds the full system prompt by:
 *   1. Walking up the directory tree from the agent's directory to DESK_ROOT
 *   2. Collecting every SYSTEM.md found along the way (outermost first)
 *   3. Appending own SCOPE.md (if present)
 *   4. Appending peer SCOPE.md files (siblings + direct children in the agent tree)
 *   5. Appending the agent's own AGENT.md
 *   6. Appending TOOLS.md
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
 *   desk/projects/finance/AGENT.md   (finance agent instructions)
 *   desk/TOOLS.md
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

  const sections: string[] = [
    `Today's date is ${today}.`,
    ...systemFiles.map((f) => readFileSync(f, 'utf8')),
    ...(ownScope ? [ownScope] : []),
    ...(peerScopeBlock ? [peerScopeBlock] : []),
    agentMd.trim(),
    toolsMd.trim(),
  ]

  return sections
    .join('\n\n---\n\n')
    .replace(/---\s*\n\n---/g, '---')
}
