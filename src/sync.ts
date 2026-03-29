#!/usr/bin/env bun
/**
 * Gmail sync — fetches emails from Gmail and writes them to desk/input/.
 *
 * Runs once and exits. The file watcher (watch.ts) picks up new files
 * and triggers triage automatically.
 *
 * Usage:
 *   bun run sync                         # fetch up to 20 unprocessed inbox emails
 *   bun run sync --n 50                  # fetch up to 50
 *   bun run sync --after 2026-03-01      # emails after this date
 *   bun run sync --before 2026-03-28     # emails before this date
 *   bun run sync --label STARRED         # filter to a specific label
 *   bun run sync --query "has:attachment" # arbitrary extra Gmail query fragment
 *   bun run sync --all                   # include already-processed emails (no -label:"🐚 desk" filter)
 *   bun run sync --dry-run               # print the query and exit
 *
 * By default, syncs inbox emails not yet labelled "🐚 desk".
 * Applies the "🐚 desk" label to each fetched message so it won't be
 * re-fetched on the next run.
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs'
import path from 'path'
import { GoogleAuth } from './services/google-auth.js'
import { GmailService } from './services/gmail.js'

const DESK_LABEL = '🐚 desk'
const DESK_INPUT_DIR = path.join(import.meta.dirname, '..', 'desk', 'input')

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]) {
  const args = argv.slice(2)
  let n = 20
  let after: string | undefined
  let before: string | undefined
  let label: string | undefined
  let extraQuery: string | undefined
  let includeAll = false
  let dryRun = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--n' || arg === '-n') {
      n = parseInt(args[++i] ?? '20', 10)
    } else if (arg === '--after') {
      after = args[++i]
    } else if (arg === '--before') {
      before = args[++i]
    } else if (arg === '--label') {
      label = args[++i]
    } else if (arg === '--query') {
      extraQuery = args[++i]
    } else if (arg === '--all') {
      includeAll = true
    } else if (arg === '--dry-run') {
      dryRun = true
    } else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    }
  }

  return { n, after, before, label, extraQuery, includeAll, dryRun }
}

function printHelp() {
  console.log(`
Usage: bun run sync [options]

Options:
  --n <number>         Max emails to fetch (default: 20)
  --after <YYYY-MM-DD> Only emails after this date
  --before <YYYY-MM-DD> Only emails before this date
  --label <label>      Filter by label (default: INBOX)
  --query <string>     Extra Gmail query fragment (e.g. "has:attachment")
  --all                Include already-processed emails (skip -label:"🐚 desk" filter)
  --dry-run            Print the query and exit without fetching
  --help               Show this help
`.trim())
}

// ---------------------------------------------------------------------------
// Query builder
// ---------------------------------------------------------------------------

function buildQuery(opts: ReturnType<typeof parseArgs>): string {
  const parts: string[] = []

  // Base: inbox unless a label is specified
  if (opts.label) {
    parts.push(`label:${opts.label}`)
  } else {
    parts.push('in:inbox')
  }

  // Exclude already-processed unless --all
  if (!opts.includeAll) {
    parts.push(`-label:"${DESK_LABEL}"`)
  }

  // Date range — Gmail uses after:YYYY/MM/DD format
  if (opts.after) {
    parts.push(`after:${opts.after.replace(/-/g, '/')}`)
  }
  if (opts.before) {
    parts.push(`before:${opts.before.replace(/-/g, '/')}`)
  }

  // Arbitrary extra fragment
  if (opts.extraQuery) {
    parts.push(opts.extraQuery)
  }

  return parts.join(' ')
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const opts = parseArgs(process.argv)
const query = buildQuery(opts)

if (opts.dryRun) {
  console.log(`Query:     ${query}`)
  console.log(`Max:       ${opts.n}`)
  console.log(`Output:    ${DESK_INPUT_DIR}`)
  process.exit(0)
}

const auth = GoogleAuth.fromEnv()
const service = new GmailService(auth)

process.stderr.write(`[sync] Querying Gmail: ${query}\n`)
process.stderr.write(`[sync] Max: ${opts.n}\n`)

const deskLabel = await service.ensureLabel(DESK_LABEL)
const messages = await service.searchMessages(query, opts.n)

if (messages.length === 0) {
  process.stderr.write(`[sync] No new messages found.\n`)
  process.exit(0)
}

process.stderr.write(`[sync] Found ${messages.length} message(s). Writing to ${DESK_INPUT_DIR}\n\n`)
mkdirSync(DESK_INPUT_DIR, { recursive: true })

let written = 0
let skipped = 0

for (const message of messages) {
  const filename = `${message.id}.json`
  const filepath = path.join(DESK_INPUT_DIR, filename)

  if (existsSync(filepath)) {
    process.stderr.write(`[sync]   skip  ${filename}  (already in input/)\n`)
    skipped++
    continue
  }

  const envelope = {
    type: 'gmail.message',
    source: 'gmail.personal',
    ...message,
  }

  writeFileSync(filepath, JSON.stringify(envelope, null, 2))
  await service.modifyLabels(message.id, [deskLabel.id], [])

  const subject = message.subject?.slice(0, 60) ?? '(no subject)'
  process.stderr.write(`[sync]   wrote ${filename}  ${subject}\n`)
  written++
}

process.stderr.write(`\n[sync] Done — ${written} written, ${skipped} skipped.\n`)
