import React, { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { DeskSnapshot } from '../shared/protocol.js'
import type { AgentFileTab, AgentFilesResponse } from '../shared/useDeskConnection.js'
import { agentDisplayName } from '../shared/reducer.js'

export interface LogLine {
  id: string
  body: string
  kind: 'user' | 'agent' | 'tool' | 'error' | 'info'
  /** Monotonically-increasing insertion order across all agents. */
  seq: number
  /** Relative path (from deskRoot) of the agent this line belongs to. */
  agentRelPath: string
}

const KIND_LABEL: Record<LogLine['kind'], string> = {
  user: 'user',
  agent: 'agent',
  tool: 'tool',
  error: 'error',
  info: 'info',
}

function LogLineContent({ line }: { line: LogLine }) {
  // Render agent output as markdown so headings, lists, code fences, etc. get
  // styled. While streaming, the body is partial markdown; react-markdown
  // tolerates this (it just renders what it has so far).
  if (line.kind === 'agent') {
    return (
      <div className="log-line-markdown">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{line.body}</ReactMarkdown>
      </div>
    )
  }
  return <pre className="mono log-line-text">{line.body}</pre>
}

function agentDepth(agentRelPath: string, base: string): number {
  const agentSegs = agentRelPath === '' ? 0 : agentRelPath.split('/').length
  const baseSegs = base === '' ? 0 : base.split('/').length
  return Math.max(0, agentSegs - baseSegs)
}

interface Props {
  snapshot: DeskSnapshot
  selectedAgentPath: string | null
  logs: LogLine[]
  connected: boolean
  error: string | null
  onSend: (message: string) => Promise<void>
  getAgentFiles: (agentRelPath: string) => Promise<AgentFilesResponse>
  /** Bumps whenever any system-level agent file changes on disk. Triggers a refetch. */
  agentFilesVersion: number
}

function agentAbsolutePath(deskRoot: string, relPath: string): string {
  const root = deskRoot.replace(/\\/g, '/').replace(/\/+$/, '')
  const rel = relPath.replace(/^\/+|\/+$/g, '')
  return rel ? `${root}/${rel}/AGENT.md` : `${root}/AGENT.md`
}

function statusLabel(active: boolean, waiting: boolean): string {
  if (active && waiting) return 'waiting'
  if (active) return 'active'
  return 'idle'
}

export function ConversationPanel({
  snapshot,
  selectedAgentPath,
  logs,
  connected,
  error,
  onSend,
  getAgentFiles,
  agentFilesVersion,
}: Props) {
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)

  const [tabs, setTabs] = useState<AgentFileTab[] | null>(null)
  const [tabsLoading, setTabsLoading] = useState(false)
  const [tabsError, setTabsError] = useState<string | null>(null)
  const [activeTabKey, setActiveTabKey] = useState<string | null>(null)

  const logScrollRef = useRef<HTMLDivElement | null>(null)

  const agentName = useMemo(() => {
    if (selectedAgentPath === null) return null
    if (selectedAgentPath === '') return 'desk'
    return agentDisplayName(agentAbsolutePath(snapshot.deskRoot, selectedAgentPath), snapshot.deskRoot)
  }, [selectedAgentPath, snapshot.deskRoot])

  const agentStatus = useMemo(() => {
    if (!selectedAgentPath && selectedAgentPath !== '') return null
    const abs = agentAbsolutePath(snapshot.deskRoot, selectedAgentPath)
    if (abs === snapshot.triage.path) {
      return statusLabel(snapshot.triage.active, snapshot.triage.waiting)
    }
    if (snapshot.project && abs === snapshot.project.path) {
      return statusLabel(snapshot.project.active, snapshot.project.waiting)
    }
    return 'idle'
  }, [selectedAgentPath, snapshot])

  // Guard against stale responses when rapid refetches overlap (e.g. editor
  // save bursts emit several 'agent-files:changed' events back-to-back).
  const loadRequestId = useRef(0)

  const loadTabs = async () => {
    if (selectedAgentPath === null) return
    const requestId = ++loadRequestId.current
    setTabsLoading(true)
    setTabsError(null)
    try {
      const result = await getAgentFiles(selectedAgentPath)
      if (requestId !== loadRequestId.current) return
      setTabs(result.tabs)
      setActiveTabKey((prev) => (prev && result.tabs.some((t) => t.key === prev) ? prev : null))
    } catch (err) {
      if (requestId !== loadRequestId.current) return
      setTabsError(err instanceof Error ? err.message : String(err))
      setTabs(null)
    } finally {
      if (requestId === loadRequestId.current) setTabsLoading(false)
    }
  }

  // Reset view when switching agents.
  useEffect(() => {
    setTabs(null)
    setTabsError(null)
    setActiveTabKey(null)
    loadRequestId.current++ // cancel any in-flight fetch for the previous agent
    if (selectedAgentPath === null) return
    void loadTabs()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAgentPath])

  // Refetch (debounced) when any system-level file changes on disk, so the
  // tab strip and preview reflect adds/deletes/modifications immediately.
  useEffect(() => {
    if (selectedAgentPath === null) return
    if (agentFilesVersion === 0) return
    const handle = setTimeout(() => { void loadTabs() }, 200)
    return () => clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentFilesVersion])

  useEffect(() => {
    const el = logScrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [logs])

  const activeTab = useMemo(() => {
    if (!tabs || !activeTabKey) return null
    return tabs.find((t) => t.key === activeTabKey) ?? null
  }, [tabs, activeTabKey])

  const handleTabClick = (key: string) => {
    setActiveTabKey((prev) => (prev === key ? null : key))
  }

  const handleSend = async () => {
    if (selectedAgentPath === null) return
    const trimmed = draft.trim()
    if (!trimmed) return
    setSending(true)
    setSendError(null)
    try {
      await onSend(trimmed)
      setDraft('')
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
  }

  if (selectedAgentPath === null) {
    return (
      <section className="conversation-panel">
        <div className="panel-header conversation-header">
          <span className="panel-title">Conversation</span>
          <span className={`status-dot ${connected ? 'ok' : ''}`} title={connected ? 'connected' : 'disconnected'} />
        </div>
        <div className="conversation-empty muted">
          Select an agent from the left panel to start a conversation.
        </div>
      </section>
    )
  }

  const showPendingInput = selectedAgentPath === 'input' && snapshot.inputFiles.length > 0

  return (
    <section className="conversation-panel">
      <div className="panel-header conversation-header">
        <div className="conversation-header-title">
          <span className="panel-title">{agentName}</span>
          <span className="muted mono small">{selectedAgentPath ? selectedAgentPath : 'desk/'}</span>
        </div>
        <div className="conversation-header-status">
          {agentStatus && <span className={`agent-status-pill status-${agentStatus}`}>{agentStatus}</span>}
          <span className={`status-dot ${connected ? 'ok' : ''}`} title={connected ? 'connected' : 'disconnected'} />
          {error && <span className="muted small error-text">{error}</span>}
        </div>
      </div>

      <div className="agent-file-tabs" role="tablist">
        {tabsLoading && tabs === null && (
          <span className="muted small tab-loading">Loading agent files…</span>
        )}
        {tabsError && (
          <span className="error-text small tab-error">{tabsError} <button type="button" className="text-button small" onClick={loadTabs}>Retry</button></span>
        )}
        {tabs?.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={activeTabKey === tab.key}
            className={`agent-file-tab${activeTabKey === tab.key ? ' active' : ''}${tab.key === 'instructions' ? ' instructions' : ''}`}
            onClick={() => handleTabClick(tab.key)}
            title={tab.source}
          >
            {tab.label}
          </button>
        ))}
        {tabs && (
          <button
            type="button"
            className="text-button small agent-file-tabs-refresh"
            onClick={loadTabs}
            disabled={tabsLoading}
            title="Reload file contents from disk"
          >
            {tabsLoading ? 'Refreshing…' : 'Refresh'}
          </button>
        )}
      </div>

      {activeTab && (
        <div className="agent-file-preview">
          <div className="agent-file-preview-header">
            <span className="muted small mono">{activeTab.source}</span>
            <button
              type="button"
              className="text-button small"
              onClick={() => setActiveTabKey(null)}
              aria-label="Close preview"
            >
              ✕
            </button>
          </div>
          <div className="agent-file-preview-text markdown-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{activeTab.content}</ReactMarkdown>
          </div>
        </div>
      )}

      <div className="conversation-log" ref={logScrollRef}>
        {logs.length === 0 ? (
          <div className="muted small conversation-log-empty">
            No messages in this session yet.
          </div>
        ) : (
          logs.map((line) => {
            const depth = agentDepth(line.agentRelPath, selectedAgentPath)
            const fromChild = depth > 0
            const childName = fromChild
              ? agentDisplayName(agentAbsolutePath(snapshot.deskRoot, line.agentRelPath), snapshot.deskRoot)
              : null
            return (
              <div
                key={line.id}
                className={`log-line log-${line.kind}${fromChild ? ' from-child' : ''}`}
                style={fromChild ? { ['--child-depth' as string]: depth } : undefined}
              >
                {childName && (
                  <span className="log-line-agent" title={line.agentRelPath}>{childName}</span>
                )}
                <span className="log-line-kind">{KIND_LABEL[line.kind]}</span>
                <LogLineContent line={line} />
              </div>
            )
          })
        )}
      </div>

      {showPendingInput && (
        <div className="pending-input-strip">
          <span className="muted small">Pending input files:</span>
          <span className="pending-input-names">{snapshot.inputFiles.join(', ')}</span>
        </div>
      )}

      <div className="conversation-input">
        <textarea
          className="text-area conversation-textarea"
          placeholder={`Send a message to ${agentName}… (Enter to send, Shift+Enter for newline)`}
          value={draft}
          onChange={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={handleKeyDown}
          disabled={sending}
        />
        <div className="conversation-input-row">
          {sendError && <span className="error-text small">{sendError}</span>}
          <button
            type="button"
            className="action-button"
            onClick={handleSend}
            disabled={sending || draft.trim().length === 0}
          >
            {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
    </section>
  )
}
