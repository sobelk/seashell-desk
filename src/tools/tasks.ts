/**
 * Task management tools for LLM tool-call workflows (Anthropic tool_use format).
 *
 * Each task lives in exactly one owning agent directory:
 *   - desk/{owner_path}/tasks/{id}.md
 *
 * The owner is the closest directory containing an AGENT.md file.
 */

import { z } from 'zod'
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs'
import path from 'path'

const DESK_ROOT = path.join(import.meta.dirname, '..', '..', 'desk')

type TaskPriority = 'critical' | 'high' | 'medium' | 'low'
type TaskStatus = 'open' | 'done' | 'ignored'

// ---------------------------------------------------------------------------
// Tool definitions (Anthropic tool_use format)
// ---------------------------------------------------------------------------

export const taskTools = [
  {
    name: 'create_task',
    description:
      'Create an actionable task for Kieran inside the owning agent directory. Use for anything Kieran needs to do or decide.',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: {
          type: 'string',
          description: 'Short, action-oriented title starting with a verb. E.g. "Pay AT&T balance of $96.30".',
        },
        owner_path: {
          type: 'string',
          description: 'Path to the owning agent directory relative to desk/, e.g. "projects/finance" or "input". Must contain an AGENT.md file.',
        },
        project: {
          type: 'string',
          description: 'Legacy alias for the project directory name under desk/projects/. Prefer owner_path.',
        },
        priority: {
          type: 'string',
          enum: ['critical', 'high', 'medium', 'low'],
          description:
            'critical = needs attention today; high = this week; medium = this month; low = whenever.',
        },
        urgency: {
          type: 'string',
          enum: ['critical', 'high', 'medium', 'low'],
          description: 'Legacy alias for priority. Prefer priority.',
        },
        due: {
          type: 'string',
          description: 'Optional due date in YYYY-MM-DD format.',
        },
        notes: {
          type: 'string',
          description: 'Context, relevant details, or suggested next steps.',
        },
      },
      required: ['title'],
    },
  },
  {
    name: 'update_task',
    description:
      'Update structured task fields on an existing task. Use to change status or priority while leaving title/body edits to write_file.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'Path to the task markdown file relative to desk/, e.g. "projects/finance/tasks/pay-att-balance-2026-03-28.md".',
        },
        id: {
          type: 'string',
          description: 'Legacy lookup field: task id (filename without .md). Use with project when path is omitted.',
        },
        project: {
          type: 'string',
          description: 'Legacy lookup field: project directory name under desk/projects/. Use with id when path is omitted.',
        },
        status: {
          type: 'string',
          enum: ['open', 'done', 'ignored'],
          description: 'Task status. Use done for completed work and ignored for intentionally closed work.',
        },
        priority: {
          type: 'string',
          enum: ['critical', 'high', 'medium', 'low'],
          description: 'Updated task priority.',
        },
        urgency: {
          type: 'string',
          enum: ['critical', 'high', 'medium', 'low'],
          description: 'Legacy alias for priority. Prefer priority.',
        },
      },
      required: [],
    },
  },
] as const

export type TaskToolName = (typeof taskTools)[number]['name']

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const CreateTaskInput = z.object({
  title: z.string().min(1),
  owner_path: z.string().min(1).optional(),
  project: z.string().min(1).optional(),
  priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  urgency: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  due: z.string().optional(),
  notes: z.string().optional(),
}).refine((input) => Boolean(input.owner_path || input.project), {
  message: 'owner_path or project is required',
})

const UpdateTaskInput = z.object({
  path: z.string().min(1).optional(),
  id: z.string().min(1).optional(),
  project: z.string().min(1).optional(),
  status: z.enum(['open', 'done', 'ignored']).optional(),
  priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  urgency: z.enum(['critical', 'high', 'medium', 'low']).optional(),
}).refine(
  (input) => Boolean(input.path || (input.id && input.project)),
  { message: 'path or id+project is required' },
).refine(
  (input) => Boolean(input.status || input.priority || input.urgency),
  { message: 'at least one of status or priority is required' },
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50)
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
}

function resolveOwnerPath(ownerPath?: string, project?: string): string {
  if (ownerPath) return normalizeRelativePath(ownerPath)
  return `projects/${project!}`
}

function resolvePriority(priority?: TaskPriority, urgency?: TaskPriority): TaskPriority {
  return priority ?? urgency ?? 'medium'
}

function resolvePriorityPatch(priority?: TaskPriority, urgency?: TaskPriority): TaskPriority | undefined {
  return priority ?? urgency
}

function taskAbsolutePath(relativePath: string): string {
  return path.join(DESK_ROOT, normalizeRelativePath(relativePath))
}

function ensureAgentOwnerPath(ownerPath: string): string {
  const normalized = normalizeRelativePath(ownerPath)
  const agentPath = path.join(DESK_ROOT, normalized, 'AGENT.md')
  if (!existsSync(agentPath)) {
    throw new Error(`Owner path does not contain an AGENT.md: ${normalized}`)
  }
  return normalized
}

function splitTaskDocument(content: string): { frontmatter: Record<string, string>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---(?:\n([\s\S]*))?$/)
  if (!match) return { frontmatter: {}, body: content }

  const frontmatter: Record<string, string> = {}
  const frontmatterBlock = match[1] ?? ''
  for (const line of frontmatterBlock.split('\n')) {
    const separator = line.indexOf(':')
    if (separator === -1) continue
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '')
    if (key) frontmatter[key] = value
  }

  return {
    frontmatter,
    body: match[2] ?? '',
  }
}

function renderTaskDocument(fields: {
  id: string
  title: string
  priority: TaskPriority
  due?: string
  ownerPath: string
  created: string
  status: TaskStatus
  closed?: string
  body?: string
}): string {
  const lines = [
    '---',
    `id: ${fields.id}`,
    `title: ${JSON.stringify(fields.title)}`,
    `priority: ${fields.priority}`,
    ...(fields.due ? [`due: ${fields.due}`] : []),
    `owner_path: ${fields.ownerPath}`,
    `created: ${fields.created}`,
    `status: ${fields.status}`,
    ...(fields.closed ? [`closed: ${fields.closed}`] : []),
    '---',
  ]
  const frontmatter = lines.join('\n')
  const body = fields.body?.trim()
  return body ? `${frontmatter}\n\n${body}\n` : `${frontmatter}\n`
}

function readTaskTaskDocument(relativePath: string): {
  relativePath: string
  absolutePath: string
  id: string
  title: string
  priority: TaskPriority
  status: TaskStatus
  created: string
  due?: string
  closed?: string
  ownerPath: string
  body: string
} {
  const normalizedPath = normalizeRelativePath(relativePath)
  const absolutePath = taskAbsolutePath(normalizedPath)
  if (!existsSync(absolutePath)) {
    throw new Error(`Task not found: ${normalizedPath}`)
  }

  const content = readFileSync(absolutePath, 'utf8')
  const { frontmatter, body } = splitTaskDocument(content)
  const id = frontmatter.id?.trim() || path.basename(normalizedPath, '.md')
  const title = frontmatter.title?.trim()
  if (!title) {
    throw new Error(`Task is missing a title: ${normalizedPath}`)
  }

  const ownerPath = ensureAgentOwnerPath(frontmatter.owner_path?.trim() || path.dirname(normalizedPath).replace(/\/tasks$/, ''))
  return {
    relativePath: normalizedPath,
    absolutePath,
    id,
    title,
    priority: resolvePriority(frontmatter.priority as TaskPriority | undefined, frontmatter.urgency as TaskPriority | undefined),
    status: (frontmatter.status === 'done' || frontmatter.status === 'ignored' ? frontmatter.status : 'open') as TaskStatus,
    created: frontmatter.created?.trim() || new Date().toISOString().slice(0, 10),
    due: frontmatter.due?.trim(),
    closed: frontmatter.closed?.trim() || frontmatter.completed?.trim(),
    ownerPath,
    body,
  }
}

function resolveTaskPath(input: { path?: string; id?: string; project?: string }): string {
  if (input.path) return normalizeRelativePath(input.path)
  return normalizeRelativePath(`projects/${input.project!}/tasks/${input.id!}.md`)
}

export function updateTaskAtRelativePath(
  relativePath: string,
  updates: { status?: TaskStatus; priority?: TaskPriority },
): { id: string; path: string; paths: string[]; status: TaskStatus; priority: TaskPriority } {
  const task = readTaskTaskDocument(relativePath)
  const nextStatus = updates.status ?? task.status
  const nextPriority = updates.priority ?? task.priority
  const closed = nextStatus === 'open'
    ? undefined
    : (task.status === nextStatus ? task.closed : undefined) ?? new Date().toISOString().slice(0, 10)
  const content = renderTaskDocument({
    id: task.id,
    title: task.title,
    priority: nextPriority,
    due: task.due,
    ownerPath: task.ownerPath,
    created: task.created,
    status: nextStatus,
    closed,
    body: task.body,
  })
  writeFileSync(task.absolutePath, content)
  return {
    id: task.id,
    path: task.relativePath,
    paths: [task.relativePath],
    status: nextStatus,
    priority: nextPriority,
  }
}

// ---------------------------------------------------------------------------
// Tool executor
// ---------------------------------------------------------------------------

export async function runTaskTool(toolName: TaskToolName, input: unknown): Promise<unknown> {
  try {
    switch (toolName) {
      case 'create_task': {
        const { title, owner_path, project, priority, urgency, due, notes } = CreateTaskInput.parse(input)

        const created = new Date().toISOString().slice(0, 10)
        const id = `${slugify(title)}-${created}`
        const filename = `${id}.md`
        const resolvedOwnerPath = ensureAgentOwnerPath(resolveOwnerPath(owner_path, project))
        const content = renderTaskDocument({
          id,
          title,
          priority: resolvePriority(priority, urgency),
          due,
          ownerPath: resolvedOwnerPath,
          created,
          status: 'open',
          body: notes,
        })
        const tasksDir = path.join(DESK_ROOT, resolvedOwnerPath, 'tasks')
        mkdirSync(tasksDir, { recursive: true })
        writeFileSync(path.join(tasksDir, filename), content)
        const relativePath = `${resolvedOwnerPath}/tasks/${filename}`

        return {
          id,
          path: relativePath,
          paths: [relativePath],
          owner_path: resolvedOwnerPath,
        }
      }

      case 'update_task': {
        const { path: taskPath, id, project, status, priority, urgency } = UpdateTaskInput.parse(input)
        return updateTaskAtRelativePath(resolveTaskPath({ path: taskPath, id, project }), {
          status,
          priority: resolvePriorityPatch(priority, urgency),
        })
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { error: message }
  }
}
