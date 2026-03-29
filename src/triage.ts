#!/usr/bin/env bun
/**
 * Triage runner — runs the input triage agent autonomously.
 *
 * Reads desk/input/AGENT.md as the system prompt, equips the agent with all
 * available tools (filesystem, tasks, Gmail, Calendar), then runs the agent
 * loop until it finishes processing all files in desk/input/.
 *
 * Usage:
 *   bun run triage              # run triage
 *   bun run triage --verbose    # log each tool call and response
 *   bun run triage --dry-run    # print system prompt and tool list, then exit
 */

import path from 'path'
import { runAgent, type ToolDefinition } from './runner.js'
import { buildSystemPrompt } from './prompt.js'
import { GoogleAuth } from './services/google-auth.js'
import { GmailService } from './services/gmail.js'
import { CalendarService } from './services/calendar.js'
import { gmailTools, runGmailTool, type GmailToolName } from './tools/gmail.js'
import { calendarTools, runCalendarTool, type CalendarToolName } from './tools/calendar.js'
import { taskTools, runTaskTool, type TaskToolName } from './tools/tasks.js'
import { filesystemTools, runFilesystemTool, type FilesystemToolName } from './tools/filesystem.js'

const DESK_ROOT = path.join(import.meta.dirname, '..', 'desk')
const AGENT_MD = path.join(DESK_ROOT, 'input', 'AGENT.md')

// ---------------------------------------------------------------------------
// Parse args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const logLevel = args.includes('--verbose') || args.includes('-v')
  ? 'verbose'
  : args.includes('--silent')
    ? 'silent'
    : 'normal'

// ---------------------------------------------------------------------------
// System prompt — assembled via SYSTEM.md cascade + AGENT.md + TOOLS.md
// ---------------------------------------------------------------------------

const systemPrompt = buildSystemPrompt(AGENT_MD)

// ---------------------------------------------------------------------------
// All tools
// ---------------------------------------------------------------------------

const allTools: ToolDefinition[] = [
  ...filesystemTools,
  ...taskTools,
  ...gmailTools,
  ...calendarTools,
]

if (dryRun) {
  console.log('=== System Prompt ===\n')
  console.log(systemPrompt)
  console.log('\n=== Tools ===\n')
  for (const t of allTools) {
    console.log(`  ${t.name.padEnd(28)} ${t.description.split('.')[0]}`)
  }
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Tool executor — routes by name to the right service
// ---------------------------------------------------------------------------

const gmailToolNames = new Set<string>(gmailTools.map((t) => t.name))
const calendarToolNames = new Set<string>(calendarTools.map((t) => t.name))
const taskToolNames = new Set<string>(taskTools.map((t) => t.name))
const filesystemToolNames = new Set<string>(filesystemTools.map((t) => t.name))

// Lazy-init Google services — only created if the model calls a Google tool
let googleAuth: GoogleAuth | null = null
let gmailService: GmailService | null = null
let calendarService: CalendarService | null = null

function getGoogleAuth(): GoogleAuth {
  if (!googleAuth) googleAuth = GoogleAuth.fromEnv()
  return googleAuth
}

function getGmailService(): GmailService {
  if (!gmailService) gmailService = new GmailService(getGoogleAuth())
  return gmailService
}

function getCalendarService(): CalendarService {
  if (!calendarService) calendarService = new CalendarService(getGoogleAuth())
  return calendarService
}

async function toolExecutor(toolName: string, input: unknown): Promise<unknown> {
  // The has() checks gate the casts — ToolName types are narrow unions of the
  // tool names defined in each module, and we've verified membership above.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  if (filesystemToolNames.has(toolName)) {
    return runFilesystemTool(toolName as any, input)
  }
  if (taskToolNames.has(toolName)) {
    return runTaskTool(toolName as any, input)
  }
  if (gmailToolNames.has(toolName)) {
    return runGmailTool(getGmailService(), toolName as any, input)
  }
  if (calendarToolNames.has(toolName)) {
    return runCalendarTool(getCalendarService(), toolName as any, input)
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return { error: `Unknown tool: ${toolName}` }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

if (logLevel !== 'silent') {
  process.stderr.write(`[triage] Starting — ${new Date().toISOString()}\n`)
  process.stderr.write(`[triage] desk: ${DESK_ROOT}\n`)
  process.stderr.write(`[triage] tools: ${allTools.length} available\n\n`)
}

const result = await runAgent({
  systemPrompt,
  tools: allTools,
  toolExecutor,
  message: 'Process all files in desk/input/ according to your instructions.',
  logLevel: logLevel as 'normal' | 'verbose' | 'silent',
  maxRounds: 80,
})

if (logLevel !== 'silent') {
  process.stderr.write('\n')
  if (result.hitLimit) {
    process.stderr.write(`[triage] ⚠ Hit round limit (${result.rounds} rounds) — triage may be incomplete\n`)
  }
  process.stderr.write(`[triage] Done — ${result.rounds} round(s), ${new Date().toISOString()}\n`)
}

// Print the agent's final summary to stdout
if (result.response) {
  console.log(result.response)
}
