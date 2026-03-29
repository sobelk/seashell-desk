/**
 * System prompt assembly with SYSTEM.md cascade.
 *
 * For a given AGENT.md path, builds the full system prompt by:
 *   1. Walking up the directory tree from the agent's directory to DESK_ROOT
 *   2. Collecting every SYSTEM.md found along the way (outermost first)
 *   3. Appending the agent's own AGENT.md
 *   4. Appending TOOLS.md
 *
 * SYSTEM.md files inform agents — they do not create them. An AGENT.md file
 * is required for a directory to have an agent; a SYSTEM.md alone does nothing.
 *
 * Example — for desk/projects/finance/AGENT.md:
 *   desk/SYSTEM.md              (global conventions, project list)
 *   desk/projects/SYSTEM.md     (if it exists — project-group conventions)
 *   desk/projects/finance/SYSTEM.md  (if it exists — finance-specific overrides)
 *   desk/projects/finance/AGENT.md   (finance agent instructions)
 *   desk/TOOLS.md
 */

import { existsSync, readFileSync } from 'fs'
import path from 'path'

const DESK_ROOT = path.resolve(path.join(import.meta.dirname, '..', 'desk'))
const TOOLS_MD = path.join(DESK_ROOT, 'TOOLS.md')

/**
 * Collect SYSTEM.md files from DESK_ROOT down to agentDir, outermost first.
 */
function collectSystemFiles(agentDir: string): string[] {
  // Build the path segments from DESK_ROOT to agentDir
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

  const sections: string[] = [
    `Today's date is ${today}.`,
    ...systemFiles.map((f) => readFileSync(f, 'utf8')),
    agentMd.trim(),
    toolsMd.trim(),
  ]

  // Join with separators, then collapse any doubled separators that arise
  // when an AGENT.md already ends with '---'
  return sections
    .join('\n\n---\n\n')
    .replace(/---\s*\n\n---/g, '---')
}
