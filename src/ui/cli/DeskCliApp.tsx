import React, { useCallback, useState } from 'react'
import { Box, Text, useApp, useInput, useStdout } from 'ink'
import { agentDisplayName } from '../shared/reducer.js'
import { useDeskConnection } from '../shared/useDeskConnection.js'
import { AgentRow } from './AgentRow.js'
import { InputBar } from './InputBar.js'
import { QueuePanel } from './QueuePanel.js'
import { TaskPanel } from './TaskPanel.js'

interface Props {
  baseUrl: string
}

export function DeskCliApp({ baseUrl }: Props) {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const [termWidth, setTermWidth] = useState(stdout.columns ?? 120)
  const [termHeight, setTermHeight] = useState(stdout.rows ?? 40)
  const [inputFocused, setInputFocused] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const { snapshot, connected, error, sendMessage } = useDeskConnection({ baseUrl })

  React.useEffect(() => {
    const onResize = () => {
      setTermWidth(stdout.columns ?? 120)
      setTermHeight(stdout.rows ?? 40)
    }
    stdout.on('resize', onResize)
    return () => { stdout.off('resize', onResize) }
  }, [stdout])

  useInput((input, key) => {
    if (key.escape || input === 'q' || input === '\x03') exit()
    if (input === '/') setInputFocused(true)
  }, { isActive: !inputFocused })

  const onSend = useCallback((agentRelPath: string, message: string) => {
    setInputFocused(false)
    sendMessage(agentRelPath, message)
      .then(() => setSendError(null))
      .catch((err: unknown) => {
        const text = err instanceof Error ? err.message : String(err)
        setSendError(text)
      })
  }, [sendMessage])

  const headerHeight = 2
  const inputBarHeight = 3
  const topHeight = Math.max(8, Math.min(14, Math.floor(termHeight * 0.28)))
  const remaining = termHeight - headerHeight - topHeight - inputBarHeight
  const triageHeight = Math.floor(remaining / 2)
  const agentHeight = remaining - triageHeight
  const topColWidth = Math.floor(termWidth / 2)

  const deskRoot = snapshot?.deskRoot ?? '(connecting)'
  const triage = snapshot?.triage
  const project = snapshot?.project
  const statusText = connected ? 'connected' : 'disconnected'

  return (
    <Box flexDirection="column" width={termWidth} height={termHeight}>
      <Box>
        <Text bold color="cyan">🐚 Seashell Desk</Text>
        <Text color={connected ? 'green' : 'yellow'}>  [{statusText}]</Text>
        <Text color="gray">  {deskRoot}  —  press / to message  ·  q to quit</Text>
      </Box>
      <Box>
        {(error || sendError) && <Text color="red">{error ?? sendError}</Text>}
      </Box>

      <Box flexDirection="row" width={termWidth}>
        <QueuePanel
          width={topColWidth}
          height={topHeight}
          inputFiles={snapshot?.inputFiles ?? []}
          queueRunning={snapshot?.queueRunning ?? null}
          queueWaiting={snapshot?.queueWaiting ?? []}
          queueChanges={snapshot?.queueChanges ?? {}}
          getAgentName={(p) => snapshot ? agentDisplayName(p, snapshot.deskRoot) : p}
        />
        <TaskPanel tasks={snapshot?.tasks ?? []} height={topHeight} />
      </Box>

      <AgentRow
        title="Triage"
        logs={triage?.logs ?? []}
        width={termWidth}
        height={triageHeight}
        active={triage?.active ?? false}
        waiting={triage?.waiting ?? false}
      />

      <AgentRow
        title={project?.name ?? 'agent'}
        logs={project?.logs ?? []}
        width={termWidth}
        height={agentHeight}
        active={project?.active ?? false}
        waiting={project?.waiting ?? false}
      />

      <InputBar
        width={termWidth}
        agentPaths={snapshot?.agentPaths ?? []}
        isActive={inputFocused}
        onSend={onSend}
      />
    </Box>
  )
}

