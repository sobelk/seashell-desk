import React, { useEffect, useMemo, useState } from 'react'
import { priorityBadge } from '../shared/presentation.js'
import type { TaskItem } from '../shared/protocol.js'
import { CameraPanel } from './CameraPanel.js'

export type RightPanelView = 'closed' | 'tasks' | 'camera'

const PRIORITY_ORDER: TaskItem['priority'][] = ['critical', 'high', 'medium', 'low']

interface Props {
  view: RightPanelView
  onViewChange: (view: RightPanelView) => void
  tasks: TaskItem[]
  updateTask: (taskPath: string, updates: { status?: TaskItem['status']; priority?: TaskItem['priority'] }) => Promise<unknown>
  getTaskFile: (taskPath: string) => Promise<{ path: string; content: string }>
  uploadInputPhoto: React.ComponentProps<typeof CameraPanel>['uploadInputPhoto']
  detectScannerDocument: React.ComponentProps<typeof CameraPanel>['detectScannerDocument']
  scanScannerDocument: React.ComponentProps<typeof CameraPanel>['scanScannerDocument']
  saveScannerBounds: React.ComponentProps<typeof CameraPanel>['saveScannerBounds']
  clearScannerBounds: React.ComponentProps<typeof CameraPanel>['clearScannerBounds']
}

function groupByPriority(tasks: TaskItem[]): Map<TaskItem['priority'], TaskItem[]> {
  const map = new Map<TaskItem['priority'], TaskItem[]>()
  for (const p of PRIORITY_ORDER) map.set(p, [])
  for (const t of tasks) {
    map.get(t.priority)?.push(t)
  }
  for (const [, list] of map) {
    list.sort((a, b) => {
      if (a.due && b.due) return a.due.localeCompare(b.due)
      if (a.due) return -1
      if (b.due) return 1
      return b.created.localeCompare(a.created)
    })
  }
  return map
}

interface TaskListProps {
  tasks: TaskItem[]
  onOpen: (task: TaskItem) => void
  busyPaths: Set<string>
  onQuickUpdate: (task: TaskItem, updates: { status?: TaskItem['status']; priority?: TaskItem['priority'] }) => void
}

function TaskList({ tasks, onOpen, busyPaths, onQuickUpdate }: TaskListProps) {
  const groups = useMemo(() => groupByPriority(tasks), [tasks])

  if (tasks.length === 0) {
    return <div className="muted small right-panel-empty">No open tasks.</div>
  }

  return (
    <div className="task-list">
      {PRIORITY_ORDER.map((priority) => {
        const list = groups.get(priority) ?? []
        if (list.length === 0) return null
        return (
          <div key={priority} className="task-group">
            <div className={`task-group-header priority-${priority}`}>
              <span className="task-group-label">{priority}</span>
              <span className="task-group-count">{list.length}</span>
            </div>
            {list.map((task) => {
              const busy = busyPaths.has(task.relativePath)
              return (
                <div key={task.relativePath} className={`task-list-item${busy ? ' busy' : ''}`}>
                  <button
                    type="button"
                    className="task-list-item-title"
                    onClick={() => onOpen(task)}
                    title={task.relativePath}
                  >
                    <span className="task-list-badge">{priorityBadge(task.priority)}</span>
                    <span className="task-list-text">{task.title}</span>
                  </button>
                  <div className="task-list-meta">
                    <span className="muted small">{task.ownerPath}</span>
                    {task.due && <span className="muted small">due {task.due}</span>}
                  </div>
                  <div className="task-list-actions">
                    <button
                      type="button"
                      className="text-button small"
                      disabled={busy}
                      onClick={() => onQuickUpdate(task, { status: 'done' })}
                    >
                      Complete
                    </button>
                    <button
                      type="button"
                      className="text-button small"
                      disabled={busy}
                      onClick={() => onQuickUpdate(task, { status: 'ignored' })}
                    >
                      Ignore
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

interface TaskDetailProps {
  task: TaskItem
  onBack: () => void
  busy: boolean
  onUpdate: (updates: { status?: TaskItem['status']; priority?: TaskItem['priority'] }) => void
  getTaskFile: (taskPath: string) => Promise<{ path: string; content: string }>
}

function TaskDetail({ task, onBack, busy, onUpdate, getTaskFile }: TaskDetailProps) {
  const [content, setContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    setContent(null)
    getTaskFile(task.relativePath)
      .then((result) => {
        if (cancelled) return
        setContent(result.content)
      })
      .catch((err) => {
        if (cancelled) return
        setLoadError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [getTaskFile, task.relativePath])

  const cyclePriority = () => {
    const idx = PRIORITY_ORDER.indexOf(task.priority)
    const next = PRIORITY_ORDER[(idx + 1) % PRIORITY_ORDER.length] ?? 'medium'
    onUpdate({ priority: next })
  }

  return (
    <div className="task-detail">
      <div className="task-detail-header">
        <button type="button" className="text-button" onClick={onBack}>← Back</button>
        <span className="muted small mono">{task.relativePath}</span>
      </div>
      <h3 className="task-detail-title">{task.title}</h3>
      <div className="task-detail-meta">
        <button
          type="button"
          className={`priority-chip priority-${task.priority}`}
          onClick={cyclePriority}
          disabled={busy}
          title="Click to cycle priority"
        >
          {task.priority}
        </button>
        <span className="muted small">owner: {task.ownerPath}</span>
        {task.due && <span className="muted small">due: {task.due}</span>}
        {task.created && <span className="muted small">created: {task.created}</span>}
      </div>
      <div className="task-detail-actions">
        <button type="button" className="action-button" disabled={busy} onClick={() => onUpdate({ status: 'done' })}>
          Complete
        </button>
        <button type="button" className="action-button" disabled={busy} onClick={() => onUpdate({ status: 'ignored' })}>
          Ignore
        </button>
      </div>
      {loading && <p className="muted small">Loading task file…</p>}
      {loadError && <p className="error-text small">{loadError}</p>}
      {content !== null && !loading && !loadError && (
        <pre className="mono task-detail-content">{content}</pre>
      )}
    </div>
  )
}

export function RightPanel({
  view,
  onViewChange,
  tasks,
  updateTask,
  getTaskFile,
  uploadInputPhoto,
  detectScannerDocument,
  scanScannerDocument,
  saveScannerBounds,
  clearScannerBounds,
}: Props) {
  const [openTaskPath, setOpenTaskPath] = useState<string | null>(null)
  const [busyPaths, setBusyPaths] = useState<Set<string>>(new Set())
  const [updateError, setUpdateError] = useState<string | null>(null)

  const openTask = useMemo(() => {
    if (!openTaskPath) return null
    return tasks.find((t) => t.relativePath === openTaskPath) ?? null
  }, [tasks, openTaskPath])

  useEffect(() => {
    if (view !== 'tasks') setOpenTaskPath(null)
  }, [view])

  const runUpdate = async (task: TaskItem, updates: { status?: TaskItem['status']; priority?: TaskItem['priority'] }) => {
    setBusyPaths((prev) => {
      const next = new Set(prev)
      next.add(task.relativePath)
      return next
    })
    setUpdateError(null)
    try {
      await updateTask(task.relativePath, updates)
      if (updates.status === 'done' || updates.status === 'ignored') {
        if (openTaskPath === task.relativePath) setOpenTaskPath(null)
      }
    } catch (err) {
      setUpdateError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyPaths((prev) => {
        const next = new Set(prev)
        next.delete(task.relativePath)
        return next
      })
    }
  }

  return (
    <>
      <div className="right-panel-rail">
        <button
          type="button"
          className={`rail-button${view === 'tasks' ? ' active' : ''}`}
          onClick={() => onViewChange(view === 'tasks' ? 'closed' : 'tasks')}
          title="Tasks"
          aria-label="Tasks"
        >
          <span className="rail-icon" aria-hidden>☰</span>
          <span className="rail-label">Tasks</span>
        </button>
        <button
          type="button"
          className={`rail-button${view === 'camera' ? ' active' : ''}`}
          onClick={() => onViewChange(view === 'camera' ? 'closed' : 'camera')}
          title="Camera"
          aria-label="Camera"
        >
          <span className="rail-icon" aria-hidden>◉</span>
          <span className="rail-label">Camera</span>
        </button>
      </div>

      {view !== 'closed' && (
        <aside className="right-panel">
          <div className="panel-header right-panel-header">
            <span className="panel-title">{view === 'tasks' ? 'Tasks' : 'Camera'}</span>
            <button
              type="button"
              className="text-button small"
              onClick={() => onViewChange('closed')}
              aria-label="Close panel"
            >
              ✕
            </button>
          </div>
          <div className="right-panel-body">
            {view === 'tasks' && (
              openTask ? (
                <TaskDetail
                  task={openTask}
                  onBack={() => setOpenTaskPath(null)}
                  busy={busyPaths.has(openTask.relativePath)}
                  onUpdate={(updates) => runUpdate(openTask, updates)}
                  getTaskFile={getTaskFile}
                />
              ) : (
                <>
                  {updateError && <div className="error-text small">{updateError}</div>}
                  <TaskList
                    tasks={tasks}
                    onOpen={(task) => setOpenTaskPath(task.relativePath)}
                    busyPaths={busyPaths}
                    onQuickUpdate={runUpdate}
                  />
                </>
              )
            )}
            {view === 'camera' && (
              <CameraPanel
                uploadInputPhoto={uploadInputPhoto}
                detectScannerDocument={detectScannerDocument}
                scanScannerDocument={scanScannerDocument}
                saveScannerBounds={saveScannerBounds}
                clearScannerBounds={clearScannerBounds}
              />
            )}
          </div>
        </aside>
      )}
    </>
  )
}
