/**
 * Task management tools for LLM tool-call workflows (Anthropic tool_use format).
 *
 * Tasks are written to two locations:
 *   - desk/projects/{project}/tasks/{id}.md  (project-level)
 *   - desk/tasks/{id}.md                     (top-level consolidated view)
 *
 * Both files are identical. The top-level desk/tasks/ is the single place
 * to browse all open tasks across projects, sorted however you like.
 */

import { z } from 'zod'
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs'
import path from 'path'

const DESK_ROOT = path.join(import.meta.dirname, '..', '..', 'desk')
const TASKS_DIR = path.join(DESK_ROOT, 'tasks')

// ---------------------------------------------------------------------------
// Tool definitions (Anthropic tool_use format)
// ---------------------------------------------------------------------------

export const taskTools = [
  {
    name: 'complete_task',
    description:
      'Mark a task as done. Updates the status field in both the project-level and top-level task files. Use when Kieran has completed a task or when triage determines a task is no longer relevant.',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: {
          type: 'string',
          description: 'Task ID (the filename without .md extension, e.g. "pay-att-balance-2026-03-28").',
        },
        project: {
          type: 'string',
          description: 'Project the task belongs to. Used to locate the project-level file.',
        },
        resolution: {
          type: 'string',
          description: 'Optional one-line note on how the task was completed or why it was closed.',
        },
      },
      required: ['id', 'project'],
    },
  },
  {
    name: 'create_task',
    description:
      'Create an actionable task for Kieran. Writes to both the project\'s own tasks/ directory and the top-level desk/tasks/ directory. Use for anything Kieran needs to do or decide — paying a bill, responding to an email, a deadline approaching, etc.',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: {
          type: 'string',
          description: 'Short, action-oriented title starting with a verb. E.g. "Pay AT&T balance of $96.30".',
        },
        project: {
          type: 'string',
          description: 'Project this task belongs to. Must match a directory name under desk/projects/.',
        },
        urgency: {
          type: 'string',
          enum: ['critical', 'high', 'medium', 'low'],
          description:
            'critical = needs attention today; high = this week; medium = this month; low = whenever.',
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
      required: ['title', 'project', 'urgency'],
    },
  },
] as const

export type TaskToolName = (typeof taskTools)[number]['name']

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const CompleteTaskInput = z.object({
  id: z.string().min(1),
  project: z.string().min(1),
  resolution: z.string().optional(),
})

const CreateTaskInput = z.object({
  title: z.string().min(1),
  project: z.string().min(1),
  urgency: z.enum(['critical', 'high', 'medium', 'low']),
  due: z.string().optional(),
  notes: z.string().optional(),
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function completeTaskFile(filePath: string, resolution?: string): void {
  const content = readFileSync(filePath, 'utf8')
  const completed = new Date().toISOString().slice(0, 10)

  // Replace status line and append completed date inside frontmatter
  let updated = content.replace(/^status: open$/m, `status: done\ncompleted: ${completed}`)

  // Append resolution as a body section if provided
  if (resolution) {
    updated = updated.trimEnd() + `\n\nResolution: ${resolution}\n`
  }

  writeFileSync(filePath, updated)
}

function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50)
}

function renderTask(fields: {
  id: string
  title: string
  urgency: string
  due?: string
  project: string
  created: string
  notes?: string
}): string {
  const lines = [
    '---',
    `id: ${fields.id}`,
    `title: "${fields.title}"`,
    `urgency: ${fields.urgency}`,
    ...(fields.due ? [`due: ${fields.due}`] : []),
    `project: ${fields.project}`,
    `created: ${fields.created}`,
    `status: open`,
    '---',
  ]
  const frontmatter = lines.join('\n')
  return fields.notes ? `${frontmatter}\n\n${fields.notes}\n` : `${frontmatter}\n`
}

// ---------------------------------------------------------------------------
// Tool executor
// ---------------------------------------------------------------------------

export async function runTaskTool(toolName: TaskToolName, input: unknown): Promise<unknown> {
  try {
    switch (toolName) {
      case 'complete_task': {
        const { id, project, resolution } = CompleteTaskInput.parse(input)
        const filename = `${id}.md`

        const projectPath = path.join(DESK_ROOT, 'projects', project, 'tasks', filename)
        const topPath = path.join(TASKS_DIR, filename)
        const updated: string[] = []

        if (existsSync(projectPath)) {
          completeTaskFile(projectPath, resolution)
          updated.push(`desk/projects/${project}/tasks/${filename}`)
        }
        if (existsSync(topPath)) {
          completeTaskFile(topPath, resolution)
          updated.push(`desk/tasks/${filename}`)
        }

        if (updated.length === 0) {
          return { error: `Task not found: ${id} (project: ${project})` }
        }

        return { id, status: 'done', updated }
      }

      case 'create_task': {
        const { title, project, urgency, due, notes } = CreateTaskInput.parse(input)

        const created = new Date().toISOString().slice(0, 10)
        const id = `${slugify(title)}-${created}`
        const filename = `${id}.md`
        const content = renderTask({ id, title, urgency, due, project, created, notes })

        const projectTasksDir = path.join(DESK_ROOT, 'projects', project, 'tasks')
        mkdirSync(projectTasksDir, { recursive: true })
        writeFileSync(path.join(projectTasksDir, filename), content)

        mkdirSync(TASKS_DIR, { recursive: true })
        writeFileSync(path.join(TASKS_DIR, filename), content)

        return {
          id,
          paths: [
            `desk/projects/${project}/tasks/${filename}`,
            `desk/tasks/${filename}`,
          ],
        }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { error: message }
  }
}
