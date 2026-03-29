#!/usr/bin/env bun
/**
 * CLI runner for Seashell Desk tools.
 *
 * Usage:
 *   bun run tool-call <tool_name> [json_input]
 *   bun run tool-call <tool_name> --help
 *
 * Examples:
 *   bun run tool-call gmail_search '{"query": "is:unread in:inbox"}'
 *   bun run tool-call create_task '{"title": "Pay AT&T balance", "project": "finance", "urgency": "high"}'
 *   bun run tool-call gcal_list_calendars
 */

import { GmailService } from './services/gmail.js'
import { CalendarService } from './services/calendar.js'
import { GoogleAuth } from './services/google-auth.js'
import { runGmailTool, gmailTools, type GmailToolName } from './tools/gmail.js'
import { runCalendarTool, calendarTools, type CalendarToolName } from './tools/calendar.js'
import { runTaskTool, taskTools, type TaskToolName } from './tools/tasks.js'
import { runFilesystemTool, filesystemTools, type FilesystemToolName } from './tools/filesystem.js'

const allTools = [...filesystemTools, ...taskTools, ...gmailTools, ...calendarTools]

function printHelp(toolName?: string) {
  if (toolName) {
    const tool = allTools.find((t) => t.name === toolName)
    if (!tool) {
      console.error(`Unknown tool: ${toolName}`)
      process.exit(1)
    }
    console.log(`\n${tool.name}`)
    console.log(`  ${tool.description}\n`)
    console.log('Input schema:')
    console.log(JSON.stringify(tool.input_schema, null, 2))
    return
  }

  console.log('\nUsage: bun run tool-call <tool_name> [json_input]')
  console.log('\nAvailable tools:\n')
  const groups = [
    { label: 'Filesystem', tools: filesystemTools },
    { label: 'Tasks', tools: taskTools },
    { label: 'Gmail', tools: gmailTools },
    { label: 'Google Calendar', tools: calendarTools },
  ]
  for (const group of groups) {
    console.log(`  ${group.label}`)
    for (const t of group.tools) {
      console.log(`    ${t.name.padEnd(28)} ${t.description.split('.')[0]}`)
    }
    console.log()
  }
}

// --- Parse args ---

const args = process.argv.slice(2)

if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  printHelp()
  process.exit(0)
}

const [toolName, rawInput] = args

if (rawInput === '--help' || rawInput === '-h') {
  printHelp(toolName)
  process.exit(0)
}

let input: unknown = {}
if (rawInput) {
  try {
    input = JSON.parse(rawInput)
  } catch {
    console.error(`Invalid JSON input: ${rawInput}`)
    process.exit(1)
  }
}

// --- Route and run ---

const gmailToolNames = gmailTools.map((t) => t.name)
const calendarToolNames = calendarTools.map((t) => t.name)
const taskToolNames = taskTools.map((t) => t.name)
const filesystemToolNames = filesystemTools.map((t) => t.name)

let result: unknown

if (filesystemToolNames.includes(toolName as FilesystemToolName)) {
  result = await runFilesystemTool(toolName as FilesystemToolName, input)
} else if (gmailToolNames.includes(toolName as GmailToolName)) {
  const auth = GoogleAuth.fromEnv()
  const service = new GmailService(auth)
  result = await runGmailTool(service, toolName as GmailToolName, input)
} else if (calendarToolNames.includes(toolName as CalendarToolName)) {
  const auth = GoogleAuth.fromEnv()
  const service = new CalendarService(auth)
  result = await runCalendarTool(service, toolName as CalendarToolName, input)
} else if (taskToolNames.includes(toolName as TaskToolName)) {
  result = await runTaskTool(toolName as TaskToolName, input)
} else {
  console.error(`Unknown tool: ${toolName}\n`)
  printHelp()
  process.exit(1)
}

// Exit non-zero if the tool returned an error
if (result && typeof result === 'object' && 'error' in result) {
  console.error(JSON.stringify(result, null, 2))
  process.exit(1)
}

console.log(JSON.stringify(result, null, 2))
