import type { TaskItem, TaskPriority, TaskStatus } from './protocol.js'

const PRIORITY_ORDER: Record<TaskPriority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
}

const PRIORITY_WEIGHT: Record<TaskPriority, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
}

function basename(fileName: string): string {
  const normalized = fileName.replace(/\\/g, '/')
  const parts = normalized.split('/')
  return parts[parts.length - 1] ?? fileName
}

function stripQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, '')
}

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---(?:\n|$)/)
  if (!match) return {}

  const frontmatter: Record<string, string> = {}
  const frontmatterBlock = match[1] ?? ''
  for (const line of frontmatterBlock.split('\n')) {
    const separator = line.indexOf(':')
    if (separator === -1) continue
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()
    if (key) frontmatter[key] = stripQuotes(value)
  }
  return frontmatter
}

function parsePriority(value: string | undefined): TaskPriority {
  if (value === 'critical' || value === 'high' || value === 'medium' || value === 'low') return value
  return 'medium'
}

function parseStatus(value: string | undefined): TaskStatus {
  if (value === 'done' || value === 'ignored') return value
  return 'open'
}

function ownerPathFromRelativePath(relativePath: string): string | null {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '')
  const marker = '/tasks/'
  const markerIndex = normalized.indexOf(marker)
  if (markerIndex <= 0) return null
  return normalized.slice(0, markerIndex)
}

export function parseTaskContent(relativePath: string, content: string, options?: { includeClosed?: boolean }): TaskItem | null {
  const frontmatter = parseFrontmatter(content)
  const title = frontmatter.title?.trim()
  if (!title) return null

  const status = parseStatus(frontmatter.status)
  if (!options?.includeClosed && status !== 'open') return null

  const ownerPath = frontmatter.owner_path?.trim() || ownerPathFromRelativePath(relativePath)
  if (!ownerPath) return null

  const created = frontmatter.created?.trim()
  const due = frontmatter.due?.trim()
  const priority = parsePriority(frontmatter.priority?.trim() || frontmatter.urgency?.trim())

  return {
    id: basename(relativePath).replace(/\.md$/i, ''),
    title,
    priority,
    status,
    created: created && /^\d{4}-\d{2}-\d{2}/.test(created) ? created : '',
    due: due && /^\d{4}-\d{2}-\d{2}/.test(due) ? due : '',
    ownerPath,
    relativePath: relativePath.replace(/\\/g, '/'),
  }
}

function compareIsoDateDescending(a: string, b: string): number {
  if (a === b) return 0
  if (!a) return 1
  if (!b) return -1
  return a < b ? 1 : -1
}

export function sortTasksByCreatedDesc(tasks: TaskItem[]): TaskItem[] {
  return [...tasks].sort((a, b) => {
    const createdCmp = compareIsoDateDescending(a.created, b.created)
    if (createdCmp !== 0) return createdCmp

    const priorityCmp = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]
    if (priorityCmp !== 0) return priorityCmp

    return a.title.localeCompare(b.title)
  })
}

export function priorityWeight(priority: TaskPriority): number {
  return PRIORITY_WEIGHT[priority]
}

