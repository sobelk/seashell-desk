/**
 * send — send a direct message to a desk agent from the command line.
 *
 * Usage:
 *   bun run send [@agentpath] <message>
 *
 * Examples:
 *   bun run send "what tasks are open?"
 *   bun run send @projects/finance "mark the Optimum bill as paid"
 */

import path from 'path'
import { existsSync } from 'fs'
import { buildSystemPrompt } from './prompt.js'
import { runAgent } from './runner.js'
import { filesystemTools, runFilesystemTool, type FilesystemToolName } from './tools/filesystem.js'
import { taskTools, runTaskTool, type TaskToolName } from './tools/tasks.js'
import { gmailTools, runGmailTool, type GmailToolName } from './tools/gmail.js'
import { calendarTools, runCalendarTool, type CalendarToolName } from './tools/calendar.js'
import { cameraTools, runCameraTool, type CameraToolName } from './tools/camera.js'
import { GoogleAuth } from './services/google-auth.js'
import { GmailService } from './services/gmail.js'
import { CalendarService } from './services/calendar.js'

const DESK_ROOT = path.resolve(path.join(import.meta.dirname, '..', 'desk'))

const args = process.argv.slice(2)
let agentRelPath = 'input'
let messageParts: string[] = args

if (args[0]?.startsWith('@')) {
  agentRelPath = args[0].slice(1)
  messageParts = args.slice(1)
}

const userMessage = messageParts.join(' ').trim()
if (!userMessage) {
  process.stderr.write('Usage: bun run send [@agentpath] <message>\n')
  process.exit(1)
}

const agentMdPath = path.join(DESK_ROOT, agentRelPath, 'AGENT.md')
if (!existsSync(agentMdPath)) {
  process.stderr.write(`No AGENT.md found at: ${agentMdPath}\n`)
  process.exit(1)
}

const googleAuth = GoogleAuth.fromEnv()
const gmailService = new GmailService(googleAuth)
const calendarService = new CalendarService(googleAuth)

const gmailToolNames = new Set<string>(gmailTools.map(t => t.name))
const calendarToolNames = new Set<string>(calendarTools.map(t => t.name))
const taskToolNames = new Set<string>(taskTools.map(t => t.name))
const filesystemToolNames = new Set<string>(filesystemTools.map(t => t.name))
const cameraToolNames = new Set<string>(cameraTools.map(t => t.name))

async function toolExecutor(toolName: string, input: unknown): Promise<unknown> {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const name = toolName as any
  if (filesystemToolNames.has(toolName)) return runFilesystemTool(name, input)
  if (taskToolNames.has(toolName)) return runTaskTool(name, input)
  if (gmailToolNames.has(toolName)) return runGmailTool(gmailService, name, input)
  if (calendarToolNames.has(toolName)) return runCalendarTool(calendarService, name, input)
  if (cameraToolNames.has(toolName)) return runCameraTool(toolName as CameraToolName, input)
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return { error: `Unknown tool: ${toolName}` }
}

const systemPrompt = buildSystemPrompt(agentMdPath)
const allTools = [...filesystemTools, ...taskTools, ...gmailTools, ...calendarTools, ...cameraTools]

const result = await runAgent({
  systemPrompt,
  tools: allTools,
  toolExecutor,
  message: userMessage,
  logLevel: 'normal',
  maxRounds: 40,
})

process.stdout.write('\n' + result.response + '\n')
