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
 *   bun run desk --host http://localhost:4312
 */

import React from 'react'
import { render } from 'ink'
import { DeskCliApp } from './ui/cli/DeskCliApp.js'

const args = process.argv.slice(2)
const host = (() => {
  const idx = args.indexOf('--host')
  return idx !== -1 ? args[idx + 1] ?? 'http://localhost:4312' : 'http://localhost:4312'
})()

const { unmount } = render(<DeskCliApp baseUrl={host} />, {
  exitOnCtrlC: false,
})

process.on('SIGTERM', () => {
  unmount()
  process.exit(0)
})
