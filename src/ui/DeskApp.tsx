import React, { useEffect, useState, useCallback } from 'react'
import { Box, Text, useApp, useStdout, useInput } from 'ink'
import path from 'path'
import { readdirSync, existsSync } from 'fs'
import { DeskWatcher, type FileChange } from '../watcher-core.js'
import { QueuePanel } from './QueuePanel.js'
import { TaskPanel } from './TaskPanel.js'
import { AgentRow } from './AgentRow.js'
import { InputBar } from './InputBar.js'

interface AgentState {
  path: string
  name: string
  logs: string[]
  active: boolean
  waiting: boolean
}

const MAX_LOG_LINES = 2000
const MAX_CHANGES_PER_AGENT = 20

export function agentDisplayName(agentMdPath: string, deskRoot: string): string {
  const rel = path.relative(deskRoot, agentMdPath)
  if (rel === path.join('input', 'AGENT.md')) return 'triage'
  const parts = rel.split(path.sep)
  return parts[parts.length - 2] ?? rel
}

function isTriage(agentMdPath: string, deskRoot: string): boolean {
  return agentMdPath === path.join(deskRoot, 'input', 'AGENT.md')
}

function appendLog(logs: string[], line: string): string[] {
  // Normalize: split on newlines so no entry ever contains \n
  const incoming = line.split('\n').filter((l) => l.length > 0)
  const next = [...logs, ...incoming]
  return next.length > MAX_LOG_LINES ? next.slice(-MAX_LOG_LINES) : next
}

function loadInputFiles(deskRoot: string): string[] {
  const inputDir = path.join(deskRoot, 'input')
  if (!existsSync(inputDir)) return []
  try {
    return readdirSync(inputDir).filter(
      (f) => f !== 'AGENT.md' && f !== 'TRIAGE_LOG.md' && !f.startsWith('.'),
    )
  } catch { return [] }
}

interface Props {
  watcher: DeskWatcher
}

export function DeskApp({ watcher }: Props) {
  const { exit } = useApp()
  const { stdout } = useStdout()

  const [termWidth, setTermWidth] = useState(stdout.columns ?? 120)
  const [termHeight, setTermHeight] = useState(stdout.rows ?? 40)

  const [triage, setTriage] = useState<AgentState>({
    path: path.join(watcher.deskRoot, 'input', 'AGENT.md'),
    name: 'triage',
    logs: [],
    active: false,
    waiting: false,
  })
  const [project, setProject] = useState<AgentState | null>(null)

  // Queue state
  const [inputFocused, setInputFocused] = useState(false)
  const [agentPaths, setAgentPaths] = useState<string[]>(() => watcher.getAgentPaths())

  // Queue state
  const [queueRunning, setQueueRunning] = useState<string | null>(null)
  const [queueWaiting, setQueueWaiting] = useState<string[]>([])
  const [queueChanges, setQueueChanges] = useState<Record<string, FileChange[]>>({})
  const [inputFiles, setInputFiles] = useState<string[]>([])

  // Terminal resize
  useEffect(() => {
    const onResize = () => {
      setTermWidth(stdout.columns ?? 120)
      setTermHeight(stdout.rows ?? 40)
    }
    stdout.on('resize', onResize)
    return () => { stdout.off('resize', onResize) }
  }, [stdout])

  // Poll input files
  useEffect(() => {
    const refresh = () => setInputFiles(loadInputFiles(watcher.deskRoot))
    refresh()
    const timer = setInterval(refresh, 2000)
    return () => clearInterval(timer)
  }, [watcher.deskRoot])

  // Refresh agent paths periodically (they rarely change but can)
  useEffect(() => {
    const t = setInterval(() => setAgentPaths(watcher.getAgentPaths()), 5000)
    return () => clearInterval(t)
  }, [watcher])

  const onAgentStart = useCallback((agentPath: string) => {
    if (isTriage(agentPath, watcher.deskRoot)) {
      setTriage((prev) => ({ ...prev, active: true, waiting: false }))
    } else {
      const name = agentDisplayName(agentPath, watcher.deskRoot)
      setProject({ path: agentPath, name, logs: [], active: true, waiting: false })
    }
  }, [watcher.deskRoot])

  const onAgentLog = useCallback((agentPath: string, message: string) => {
    if (isTriage(agentPath, watcher.deskRoot)) {
      setTriage((prev) => ({ ...prev, logs: appendLog(prev.logs, message) }))
    } else {
      setProject((prev) => {
        if (!prev || prev.path !== agentPath) return prev
        return { ...prev, logs: appendLog(prev.logs, message) }
      })
    }
  }, [watcher.deskRoot])

  const onAgentWaiting = useCallback((agentPath: string, waiting: boolean) => {
    if (isTriage(agentPath, watcher.deskRoot)) {
      setTriage((prev) => ({ ...prev, waiting }))
    } else {
      setProject((prev) => {
        if (!prev || prev.path !== agentPath) return prev
        return { ...prev, waiting }
      })
    }
  }, [watcher.deskRoot])

  const onAgentDone = useCallback((agentPath: string, rounds: number, hitLimit: boolean, response: string) => {
    const suffix = hitLimit ? ` [hit round limit after ${rounds} rounds]` : ''
    if (isTriage(agentPath, watcher.deskRoot)) {
      setTriage((prev) => {
        const logs = response ? appendLog(prev.logs, response + suffix) : prev.logs
        return { ...prev, active: false, waiting: false, logs }
      })
    } else {
      setProject((prev) => {
        if (!prev || prev.path !== agentPath) return prev
        const logs = response ? appendLog(prev.logs, response + suffix) : prev.logs
        return { ...prev, active: false, waiting: false, logs }
      })
    }
  }, [watcher.deskRoot])

  const onAgentError = useCallback((agentPath: string, error: string) => {
    const msg = `[error] ${error}`
    if (isTriage(agentPath, watcher.deskRoot)) {
      setTriage((prev) => ({ ...prev, active: false, waiting: false, logs: appendLog(prev.logs, msg) }))
    } else {
      setProject((prev) => {
        if (!prev || prev.path !== agentPath) return prev
        return { ...prev, active: false, waiting: false, logs: appendLog(prev.logs, msg) }
      })
    }
  }, [watcher.deskRoot])

  const onQueue = useCallback((running: string | null, queued: string[]) => {
    setQueueRunning(running)
    setQueueWaiting(queued)
    setQueueChanges((prev) => {
      const active = new Set([...(running ? [running] : []), ...queued])
      const next: Record<string, FileChange[]> = {}
      for (const k of Object.keys(prev)) {
        if (active.has(k)) next[k] = prev[k] ?? []
      }
      return next
    })
  }, [])

  const onFs = useCallback((change: FileChange, agentPath: string | null, suppressed: boolean) => {
    if (suppressed || !agentPath) return
    setQueueChanges((prev) => {
      const existing = prev[agentPath] ?? []
      const next = [...existing, change]
      return {
        ...prev,
        [agentPath]: next.length > MAX_CHANGES_PER_AGENT ? next.slice(-MAX_CHANGES_PER_AGENT) : next,
      }
    })
  }, [])

  const onUserMessage = useCallback((agentPath: string, message: string) => {
    const line = `[user] ${message}`
    if (isTriage(agentPath, watcher.deskRoot)) {
      setTriage(prev => ({ ...prev, logs: appendLog(prev.logs, line) }))
    } else {
      const name = agentDisplayName(agentPath, watcher.deskRoot)
      setProject(prev => {
        if (!prev || prev.path !== agentPath) {
          return { path: agentPath, name, logs: [line], active: false, waiting: false }
        }
        return { ...prev, logs: appendLog(prev.logs, line) }
      })
    }
  }, [watcher.deskRoot])

  useEffect(() => {
    watcher.on('agent:start', onAgentStart)
    watcher.on('agent:log', onAgentLog)
    watcher.on('agent:waiting', onAgentWaiting)
    watcher.on('agent:done', onAgentDone)
    watcher.on('agent:error', onAgentError)
    watcher.on('queue', onQueue)
    watcher.on('fs', onFs)
    watcher.on('user:message', onUserMessage)
    return () => {
      watcher.off('agent:start', onAgentStart)
      watcher.off('agent:log', onAgentLog)
      watcher.off('agent:waiting', onAgentWaiting)
      watcher.off('agent:done', onAgentDone)
      watcher.off('agent:error', onAgentError)
      watcher.off('queue', onQueue)
      watcher.off('fs', onFs)
      watcher.off('user:message', onUserMessage)
    }
  }, [watcher, onAgentStart, onAgentLog, onAgentWaiting, onAgentDone, onAgentError, onQueue, onFs, onUserMessage])

  useInput((input, key) => {
    if (key.escape || input === 'q' || input === '\x03') {
      watcher.stop()
      exit()
    }
    if (input === '/') {
      setInputFocused(true)
    }
  }, { isActive: !inputFocused })

  const onSend = useCallback((agentRelPath: string, message: string) => {
    setInputFocused(false)
    watcher.sendMessage(agentRelPath, message)
  }, [watcher])

  // Layout heights
  const headerHeight = 1
  const inputBarHeight = 3
  const topHeight = Math.max(8, Math.min(14, Math.floor(termHeight * 0.28)))
  const remaining = termHeight - headerHeight - topHeight - inputBarHeight
  const triageHeight = Math.floor(remaining / 2)
  const agentHeight = remaining - triageHeight

  // Top row: queue takes half, tasks fills the rest
  const topColWidth = Math.floor(termWidth / 2)

  return (
    <Box flexDirection="column" width={termWidth} height={termHeight}>
      {/* Header */}
      <Box>
        <Text bold color="cyan">🐚 Seashell Desk</Text>
        <Text color="gray">  {watcher.deskRoot}  —  press / to message  ·  q to quit</Text>
      </Box>

      {/* Top row: queue (fixed half) + tasks (fills rest) */}
      <Box flexDirection="row" width={termWidth}>
        <QueuePanel
          width={topColWidth}
          height={topHeight}
          inputFiles={inputFiles}
          queueRunning={queueRunning}
          queueWaiting={queueWaiting}
          queueChanges={queueChanges}
          getAgentName={(p) => agentDisplayName(p, watcher.deskRoot)}
        />
        <TaskPanel
          deskRoot={watcher.deskRoot}
          height={topHeight}
        />
      </Box>

      {/* Triage row */}
      <AgentRow
        title="Triage"
        logs={triage.logs}
        width={termWidth}
        height={triageHeight}
        active={triage.active}
        waiting={triage.waiting}
      />

      {/* Project agent row */}
      <AgentRow
        title={project?.name ?? 'agent'}
        logs={project?.logs ?? []}
        width={termWidth}
        height={agentHeight}
        active={project?.active ?? false}
        waiting={project?.waiting ?? false}
      />

      {/* Input bar */}
      <InputBar
        width={termWidth}
        agentPaths={agentPaths}
        isActive={inputFocused}
        onSend={onSend}
      />
    </Box>
  )
}
