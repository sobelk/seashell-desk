import React, { useMemo, useState } from 'react'
import { useDeskConnection } from '../shared/useDeskConnection.js'
import { urgencyBadge } from '../shared/presentation.js'
import { agentDisplayName } from '../shared/reducer.js'
import { ActionButton, Card, Label, NavButton, Page, Row, TextArea, TextInput, TopNav } from './components.js'

type Route = 'overview' | 'agents' | 'tasks' | 'input'

function useRoute(): [Route, (next: Route) => void] {
  const getCurrent = (): Route => {
    const hash = window.location.hash.replace('#', '')
    if (hash === 'agents' || hash === 'tasks' || hash === 'input') return hash
    return 'overview'
  }

  const [route, setRoute] = React.useState<Route>(getCurrent)
  React.useEffect(() => {
    const onHash = () => setRoute(getCurrent())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const go = (next: Route) => {
    window.location.hash = next
    setRoute(next)
  }

  return [route, go]
}

function ConnectionLine({ connected, error, deskRoot }: { connected: boolean; error: string | null; deskRoot: string }) {
  return (
    <Row className="muted">
      <span className={`status-dot ${connected ? 'ok' : ''}`} />
      <span>{connected ? 'connected' : 'disconnected'}</span>
      <span>desk: {deskRoot}</span>
      {error && <span style={{ color: '#ad1d1d' }}>{error}</span>}
    </Row>
  )
}

export function App() {
  const baseUrl = `${window.location.protocol}//${window.location.host}`
  const { snapshot, connected, error, sendMessage } = useDeskConnection({ baseUrl })
  const [route, setRoute] = useRoute()
  const [agentRelPath, setAgentRelPath] = useState('input')
  const [message, setMessage] = useState('')
  const [sendState, setSendState] = useState<string | null>(null)

  const allAgents = useMemo(() => {
    if (!snapshot) return []
    const fromPaths = snapshot.agentPaths.map((p) => ({ path: p, name: p }))
    const triage = {
      path: snapshot.triage.path,
      name: 'triage',
      active: snapshot.triage.active,
      waiting: snapshot.triage.waiting,
      logs: snapshot.triage.logs,
    }
    const project = snapshot.project
      ? {
          path: snapshot.project.path,
          name: snapshot.project.name,
          active: snapshot.project.active,
          waiting: snapshot.project.waiting,
          logs: snapshot.project.logs,
        }
      : null

    return fromPaths.map((entry) => {
      const absPath = `${snapshot.deskRoot}/${entry.path}/AGENT.md`
      if (absPath === triage.path) return triage
      if (project && project.path === absPath) return project
      return { path: absPath, name: agentDisplayName(absPath, snapshot.deskRoot), active: false, waiting: false, logs: [] as string[] }
    })
  }, [snapshot])

  const onSend = async () => {
    const trimmed = message.trim()
    if (!trimmed) return
    try {
      await sendMessage(agentRelPath.trim() || 'input', trimmed)
      setMessage('')
      setSendState('sent')
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      setSendState(text)
    }
  }

  if (!snapshot) {
    return (
      <Page>
        <h1>Seashell Desk</h1>
        <ConnectionLine connected={connected} error={error} deskRoot="(connecting)" />
      </Page>
    )
  }

  return (
    <Page>
      <h1>Seashell Desk</h1>
      <ConnectionLine connected={connected} error={error} deskRoot={snapshot.deskRoot} />

      <TopNav>
        <NavButton onClick={() => setRoute('overview')}>Overview</NavButton>
        <NavButton onClick={() => setRoute('agents')}>Agents</NavButton>
        <NavButton onClick={() => setRoute('tasks')}>Tasks</NavButton>
        <NavButton onClick={() => setRoute('input')}>Input</NavButton>
      </TopNav>

      {route === 'overview' && (
        <div className="grid">
          <Card>
            <h3>Queue</h3>
            <p className="muted">running: {snapshot.queueRunning ? agentDisplayName(snapshot.queueRunning, snapshot.deskRoot) : 'idle'}</p>
            <ul className="list">
              {snapshot.queueWaiting.map((q) => (
                <li key={q}>{agentDisplayName(q, snapshot.deskRoot)}</li>
              ))}
            </ul>
          </Card>
          <Card>
            <h3>Tasks ({snapshot.tasks.length})</h3>
            <ul className="list">
              {snapshot.tasks.slice(0, 8).map((task) => (
                <li key={task.id}>{urgencyBadge(task.urgency)} {task.title}</li>
              ))}
            </ul>
          </Card>
          <Card>
            <h3>Triage</h3>
            <div className="muted">active: {String(snapshot.triage.active)} / waiting: {String(snapshot.triage.waiting)}</div>
            <pre className="mono">{snapshot.triage.logs.slice(-8).join('\n')}</pre>
          </Card>
          <Card>
            <h3>Project Agent</h3>
            {snapshot.project ? (
              <>
                <div className="muted">{snapshot.project.name}</div>
                <pre className="mono">{snapshot.project.logs.slice(-8).join('\n')}</pre>
              </>
            ) : <p className="muted">(none yet)</p>}
          </Card>
        </div>
      )}

      {route === 'agents' && (
        <div className="stack">
          {allAgents.map((agent) => (
            <Card key={agent.path}>
              <Row><strong>{agent.name}</strong><span className="muted">{agent.path}</span></Row>
              <div className="muted">active: {String(agent.active)} / waiting: {String(agent.waiting)}</div>
              <pre className="mono">{agent.logs.length > 0 ? agent.logs.slice(-14).join('\n') : '(no logs in current session view)'}</pre>
            </Card>
          ))}
        </div>
      )}

      {route === 'tasks' && (
        <Card>
          <h3>Tasks</h3>
          <ul className="list">
            {snapshot.tasks.map((task) => (
              <li key={task.id}>{urgencyBadge(task.urgency)} {task.title}</li>
            ))}
          </ul>
        </Card>
      )}

      {route === 'input' && (
        <div className="grid">
          <Card>
            <h3>Pending Input Files</h3>
            <ul className="list">
              {snapshot.inputFiles.map((name) => <li key={name}>{name}</li>)}
            </ul>
          </Card>
          <Card>
            <h3>Send Message</h3>
            <div className="stack">
              <div>
                <Label>Agent relative path</Label>
                <TextInput value={agentRelPath} onChange={(e) => setAgentRelPath(e.currentTarget.value)} />
              </div>
              <div>
                <Label>Message</Label>
                <TextArea value={message} onChange={(e) => setMessage(e.currentTarget.value)} />
              </div>
              <Row>
                <ActionButton onClick={onSend}>Send</ActionButton>
                {sendState && <span className="muted">{sendState}</span>}
              </Row>
            </div>
          </Card>
        </div>
      )}
    </Page>
  )
}

