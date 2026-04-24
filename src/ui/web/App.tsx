import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useDeskConnection } from '../shared/useDeskConnection.js'
import type { DeskEvent } from '../shared/protocol.js'
import { AgentTreePanel } from './AgentTreePanel.js'
import { ConversationPanel, type LogLine } from './ConversationPanel.js'
import { RightPanel, type RightPanelView } from './RightPanel.js'

function normalizeRoot(deskRoot: string): string {
  return deskRoot.replace(/\\/g, '/').replace(/\/+$/, '')
}

function agentAbsolutePath(deskRoot: string, relPath: string): string {
  const root = normalizeRoot(deskRoot)
  const rel = relPath.replace(/^\/+|\/+$/g, '')
  return rel ? `${root}/${rel}/AGENT.md` : `${root}/AGENT.md`
}

/** Reverse of `agentAbsolutePath`: absolute AGENT.md → relative agent path. */
function agentRelativePath(absPath: string, deskRoot: string): string | null {
  const root = normalizeRoot(deskRoot)
  const abs = absPath.replace(/\\/g, '/')
  if (abs === `${root}/AGENT.md`) return ''
  if (!abs.startsWith(`${root}/`)) return null
  if (!abs.endsWith('/AGENT.md')) return null
  return abs.slice(root.length + 1, -'/AGENT.md'.length)
}

/** True if `candidate` is `base` or nested under it (in the agent tree). */
function isDescendantOrSelf(candidate: string, base: string): boolean {
  if (base === '') return true
  if (candidate === base) return true
  return candidate.startsWith(`${base}/`)
}

const PREFIX_KINDS: ReadonlyArray<[string, LogLine['kind']]> = [
  ['[user]', 'user'],
  ['[agent]', 'agent'],
  ['[tool]', 'tool'],
  ['[error]', 'error'],
  ['[info]', 'info'],
]

function classifyMessage(raw: string): { kind: LogLine['kind']; body: string } {
  for (const [prefix, kind] of PREFIX_KINDS) {
    if (raw.startsWith(prefix)) {
      return { kind, body: raw.slice(prefix.length).replace(/^\s+/, '') }
    }
  }
  return { kind: 'info', body: raw }
}

let logSeqCounter = 0
const nextSeq = () => ++logSeqCounter
const nextLogId = () => `${Date.now()}-${logSeqCounter}`

function toLogLines(raw: string, agentRelPath: string): LogLine[] {
  // Preserve each logical message as a single entry so multi-line agent
  // responses (and their markdown structure) survive intact. Splitting on
  // newlines here would both shred markdown and re-classify every subsequent
  // line as 'info' because only the first line carries the '[agent]' prefix.
  if (!raw || raw.trim().length === 0) return []
  const { kind, body } = classifyMessage(raw)
  if (body.length === 0) return []
  const seq = nextSeq()
  return [{ id: nextLogId(), body, kind, seq, agentRelPath }]
}

export function App() {
  const baseUrl = `${window.location.protocol}//${window.location.host}`

  const [logsByAgent, setLogsByAgent] = useState<Record<string, LogLine[]>>({})
  const [selectedAgentPath, setSelectedAgentPath] = useState<string | null>(null)
  const [rightPanelView, setRightPanelView] = useState<RightPanelView>('closed')
  // Bumped whenever the server reports that any system-level agent file
  // (AGENT.md / SCOPE.md / SYSTEM.md / MEMORY.md / JOURNAL.md) changed on disk.
  // ConversationPanel watches this and refetches its tabs.
  const [agentFilesVersion, setAgentFilesVersion] = useState(0)

  const appendLogs = useCallback((agentPath: string, incoming: LogLine[]) => {
    if (incoming.length === 0) return
    setLogsByAgent((prev) => {
      const current = prev[agentPath] ?? []
      const MAX = 2000
      const next = [...current, ...incoming]
      return {
        ...prev,
        [agentPath]: next.length > MAX ? next.slice(-MAX) : next,
      }
    })
  }, [])

  const appendToLog = useCallback((agentPath: string, logId: string, delta: string) => {
    setLogsByAgent((prev) => {
      const current = prev[agentPath]
      if (!current) return prev
      // Streaming deltas almost always target the most recent entry, so walk
      // backwards for O(1) in the common case.
      for (let i = current.length - 1; i >= 0; i--) {
        if (current[i]?.id === logId) {
          const updated = current.slice()
          const line = updated[i]!
          updated[i] = { ...line, body: line.body + delta }
          return { ...prev, [agentPath]: updated }
        }
      }
      return prev
    })
  }, [])

  const deskRootRef = useRef<string | null>(null)

  const handleEvent = useCallback((event: DeskEvent) => {
    const deskRoot = deskRootRef.current
    if (!deskRoot) return
    const toRel = (absAgentPath: string): string => agentRelativePath(absAgentPath, deskRoot) ?? ''

    if (event.type === 'agent:log') {
      appendLogs(event.agentPath, toLogLines(event.message, toRel(event.agentPath)))
      return
    }
    if (event.type === 'agent:stream:start') {
      // Use the streamId as the LogLine id so deltas can find their target
      // without threading extra state through React.
      appendLogs(event.agentPath, [{
        id: event.streamId,
        body: '',
        kind: 'agent',
        seq: nextSeq(),
        agentRelPath: toRel(event.agentPath),
      }])
      return
    }
    if (event.type === 'agent:stream:delta') {
      appendToLog(event.agentPath, event.streamId, event.delta)
      return
    }
    if (event.type === 'agent:stream:end') {
      // Nothing to finalize: the accumulated body is already on the log line.
      return
    }
    if (event.type === 'user:message') {
      appendLogs(event.agentPath, [{
        id: nextLogId(),
        body: event.message,
        kind: 'user',
        seq: nextSeq(),
        agentRelPath: toRel(event.agentPath),
      }])
      return
    }
    if (event.type === 'agent:done') {
      // The agent's final text already arrived via `agent:stream:*`. Only
      // surface metadata here (e.g. the round-limit notice) to avoid dupes.
      if (event.hitLimit) {
        appendLogs(event.agentPath, [{
          id: nextLogId(),
          body: `hit round limit after ${event.rounds} rounds`,
          kind: 'info',
          seq: nextSeq(),
          agentRelPath: toRel(event.agentPath),
        }])
      }
      return
    }
    if (event.type === 'agent:error') {
      appendLogs(event.agentPath, [{
        id: nextLogId(),
        body: event.error,
        kind: 'error',
        seq: nextSeq(),
        agentRelPath: toRel(event.agentPath),
      }])
      return
    }
    if (event.type === 'agent-files:changed') {
      setAgentFilesVersion((v) => v + 1)
      return
    }
  }, [appendLogs, appendToLog])

  const {
    snapshot,
    connected,
    error,
    sendMessage,
    updateTask,
    getTaskFile,
    getAgentFiles,
    uploadInputPhoto,
    detectScannerDocument,
    scanScannerDocument,
    saveScannerBounds,
    clearScannerBounds,
  } = useDeskConnection({ baseUrl, onEvent: handleEvent })

  useEffect(() => {
    if (!snapshot) return
    // Keep deskRootRef in sync so handleEvent can resolve absolute→relative
    // agent paths without re-creating the callback (and tearing down the
    // WebSocket subscription) every time the snapshot reference changes.
    deskRootRef.current = snapshot.deskRoot
    if (selectedAgentPath !== null) return
    const preferred = snapshot.agentPaths.includes('')
      ? ''
      : snapshot.agentPaths.includes('input')
        ? 'input'
        : snapshot.agentPaths[0] ?? null
    if (preferred !== null) setSelectedAgentPath(preferred)
  }, [snapshot, selectedAgentPath])

  const selectedLogs = useMemo(() => {
    if (!snapshot || selectedAgentPath === null) return []
    // Merge in logs from the selected agent and every descendant so users can
    // see subordinate agent chatter while focused on a parent.
    const merged: LogLine[] = []
    for (const [absPath, lines] of Object.entries(logsByAgent)) {
      const rel = agentRelativePath(absPath, snapshot.deskRoot)
      if (rel === null) continue
      if (!isDescendantOrSelf(rel, selectedAgentPath)) continue
      for (const line of lines) merged.push(line)
    }
    merged.sort((a, b) => a.seq - b.seq)
    return merged
  }, [snapshot, selectedAgentPath, logsByAgent])

  const handleSend = useCallback(async (message: string) => {
    if (selectedAgentPath === null) return
    await sendMessage(selectedAgentPath, message)
  }, [selectedAgentPath, sendMessage])

  // Stable reference so the tree panel's auto-expand effect only fires when
  // the files themselves actually change, not on every App render.
  const filesByAgent = useMemo(
    () => ({ input: snapshot?.inputFiles ?? [] }),
    [snapshot?.inputFiles],
  )

  if (!snapshot) {
    return (
      <div className="app-shell-loading">
        <h1>Seashell Desk</h1>
        <div className="muted">
          <span className={`status-dot ${connected ? 'ok' : ''}`} />
          {' '}
          {connected ? 'connected' : 'connecting…'}
          {error && <span className="error-text"> {error}</span>}
        </div>
      </div>
    )
  }

  const shellClass = rightPanelView === 'closed' ? 'app-shell' : 'app-shell right-open'

  return (
    <div className={shellClass}>
      <AgentTreePanel
        snapshot={snapshot}
        selectedAgentPath={selectedAgentPath}
        onSelect={setSelectedAgentPath}
        filesByAgent={filesByAgent}
      />
      <ConversationPanel
        snapshot={snapshot}
        selectedAgentPath={selectedAgentPath}
        logs={selectedLogs}
        connected={connected}
        error={error}
        onSend={handleSend}
        getAgentFiles={getAgentFiles}
        agentFilesVersion={agentFilesVersion}
      />
      <RightPanel
        view={rightPanelView}
        onViewChange={setRightPanelView}
        tasks={snapshot.tasks}
        updateTask={updateTask}
        getTaskFile={getTaskFile}
        uploadInputPhoto={uploadInputPhoto}
        detectScannerDocument={detectScannerDocument}
        scanScannerDocument={scanScannerDocument}
        saveScannerBounds={saveScannerBounds}
        clearScannerBounds={clearScannerBounds}
      />
    </div>
  )
}
