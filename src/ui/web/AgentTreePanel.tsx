import React, { useEffect, useMemo, useState } from 'react'
import type { DeskSnapshot } from '../shared/protocol.js'

interface AgentStatus {
  active: boolean
  waiting: boolean
}

interface TreeNode {
  name: string
  relPath: string
  isAgent: boolean
  children: TreeNode[]
}

interface Props {
  snapshot: DeskSnapshot
  selectedAgentPath: string | null
  onSelect: (relPath: string) => void
  /**
   * Map of agent relative path → list of queued input files to show nested
   * beneath that agent in the tree. Currently only populated for the triage
   * agent (key = `"input"`), but keyed by agent so other agents can opt in.
   */
  filesByAgent?: Record<string, string[]>
}

function relAgentPath(absAgentMdPath: string, deskRoot: string): string | null {
  const root = deskRoot.replace(/\\/g, '/').replace(/\/+$/, '')
  const abs = absAgentMdPath.replace(/\\/g, '/')
  if (!abs.startsWith(`${root}/`)) return null
  const rel = abs.slice(root.length + 1)
  if (!rel.endsWith('/AGENT.md')) return null
  return rel.slice(0, -'/AGENT.md'.length)
}

function buildTree(agentPaths: string[]): TreeNode {
  const agentSet = new Set(agentPaths)
  const root: TreeNode = {
    name: 'desk',
    relPath: '',
    isAgent: agentSet.has(''),
    children: [],
  }

  for (const p of agentPaths) {
    if (p === '') continue
    const segments = p.split('/').filter(Boolean)
    let cursor = root
    let accum = ''
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!
      accum = accum ? `${accum}/${seg}` : seg
      let child = cursor.children.find((c) => c.name === seg)
      if (!child) {
        child = {
          name: seg,
          relPath: accum,
          isAgent: agentSet.has(accum),
          children: [],
        }
        cursor.children.push(child)
      } else if (agentSet.has(accum)) {
        child.isAgent = true
      }
      cursor = child
    }
  }

  const sortRec = (node: TreeNode) => {
    node.children.sort((a, b) => a.name.localeCompare(b.name))
    node.children.forEach(sortRec)
  }
  sortRec(root)
  return root
}

function collectAncestors(relPath: string): string[] {
  if (!relPath) return ['']
  const segments = relPath.split('/').filter(Boolean)
  const result: string[] = ['']
  let accum = ''
  for (const seg of segments) {
    accum = accum ? `${accum}/${seg}` : seg
    result.push(accum)
  }
  return result
}

export function AgentTreePanel({ snapshot, selectedAgentPath, onSelect, filesByAgent }: Props) {
  const tree = useMemo(() => buildTree(snapshot.agentPaths), [snapshot.agentPaths])

  const [openDirs, setOpenDirs] = useState<Set<string>>(() => {
    const initial = new Set<string>(['', 'projects'])
    for (const rel of collectAncestors(selectedAgentPath ?? '')) initial.add(rel)
    // Auto-expand any agent that currently has queued input files so the
    // files appear without requiring an extra click.
    if (filesByAgent) {
      for (const [rel, files] of Object.entries(filesByAgent)) {
        if (files.length > 0) initial.add(rel)
      }
    }
    return initial
  })

  const statusByPath = useMemo(() => {
    const map = new Map<string, AgentStatus>()
    const triageRel = relAgentPath(snapshot.triage.path, snapshot.deskRoot)
    if (triageRel !== null) {
      map.set(triageRel, { active: snapshot.triage.active, waiting: snapshot.triage.waiting })
    }
    if (snapshot.project) {
      const projectRel = relAgentPath(snapshot.project.path, snapshot.deskRoot)
      if (projectRel !== null) {
        map.set(projectRel, { active: snapshot.project.active, waiting: snapshot.project.waiting })
      }
    }
    return map
  }, [snapshot.deskRoot, snapshot.triage, snapshot.project])

  const toggleDir = (relPath: string) => {
    setOpenDirs((prev) => {
      const next = new Set(prev)
      if (next.has(relPath)) next.delete(relPath)
      else next.add(relPath)
      return next
    })
  }

  // Auto-expand any agent that newly receives queued input files so the user
  // sees them appear without having to click. Collapsing remains manual.
  useEffect(() => {
    if (!filesByAgent) return
    setOpenDirs((prev) => {
      let changed = false
      const next = new Set(prev)
      for (const [rel, files] of Object.entries(filesByAgent)) {
        if (files.length > 0 && !next.has(rel)) {
          next.add(rel)
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [filesByAgent])

  const renderNode = (node: TreeNode, depth: number): React.ReactNode => {
    const isOpen = openDirs.has(node.relPath)
    const hasChildren = node.children.length > 0
    const files = filesByAgent?.[node.relPath] ?? []
    const hasFiles = files.length > 0
    const isExpandable = hasChildren || hasFiles
    const status = statusByPath.get(node.relPath)
    const isSelected = selectedAgentPath === node.relPath
    const statusClass = status?.active
      ? status.waiting ? 'status-dot waiting' : 'status-dot ok'
      : 'status-dot'

    const onRowClick = () => {
      if (isExpandable) toggleDir(node.relPath)
      if (node.isAgent) onSelect(node.relPath)
    }

    const displayName = hasChildren ? `${node.name}/` : node.name

    return (
      <div key={node.relPath || '__root__'} className="agent-tree-node">
        <div
          className={`agent-row${isSelected ? ' selected' : ''}${node.isAgent ? ' is-agent' : ''}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={onRowClick}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              onRowClick()
            }
          }}
        >
          <span className="agent-row-caret">
            {isExpandable ? (isOpen ? '▾' : '▸') : ' '}
          </span>
          <span className="agent-row-name">{displayName}</span>
          {node.isAgent && <span className={statusClass} title={status?.active ? (status.waiting ? 'waiting' : 'active') : 'idle'} />}
        </div>
        {isExpandable && isOpen && (
          <div className="agent-tree-children">
            {node.children.map((child) => renderNode(child, depth + 1))}
            {files.map((f) => (
              <div
                key={`file:${node.relPath}:${f}`}
                className="agent-tree-file-row"
                style={{ paddingLeft: 8 + (depth + 1) * 14 }}
                title={`${node.relPath ? `${node.relPath}/` : ''}${f}`}
              >
                <span className="agent-row-caret">·</span>
                <span className="agent-tree-file-name">{f}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <aside className="agent-tree-panel">
      <div className="panel-header">
        <span className="panel-title">Agents</span>
      </div>
      <div className="agent-tree">
        {renderNode(tree, 0)}
      </div>
    </aside>
  )
}
