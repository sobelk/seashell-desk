#!/usr/bin/env bun
/**
 * desk — interactive TUI for Seashell Desk.
 *
 * Three-column layout:
 *   Left   — triage agent input and output
 *   Middle — most recent or currently running project agent
 *   Right  — open tasks and current desk/input/ contents
 *
 * Usage:
 *   bun run desk
 *   bun run desk --verbose
 *   bun run desk --debounce 3000
 */

import React from 'react'
import { render } from 'ink'
import { DeskWatcher } from './watcher-core.js'
import { DeskApp } from './ui/DeskApp.js'

const args = process.argv.slice(2)
const debounceMs = (() => {
  const idx = args.indexOf('--debounce')
  return idx !== -1 ? parseInt(args[idx + 1] ?? '2000', 10) : 2000
})()
const logLevel = args.includes('--verbose') ? 'verbose' : 'normal'

const watcher = new DeskWatcher({ debounceMs, logLevel })

const { unmount } = render(<DeskApp watcher={watcher} />, {
  exitOnCtrlC: false,  // we handle it ourselves in DeskApp
})

watcher.start()

process.on('SIGTERM', () => {
  watcher.stop()
  unmount()
  process.exit(0)
})
