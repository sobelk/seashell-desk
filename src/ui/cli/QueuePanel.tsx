import React from 'react'
import { Box, Text } from 'ink'
import type { FileChange } from '../shared/protocol.js'

interface Props {
  width: number
  height: number
  inputFiles: string[]
  queueRunning: string | null
  queueWaiting: string[]
  queueChanges: Record<string, FileChange[]>
  getAgentName: (agentPath: string) => string
}

function changeIcon(event: FileChange['event']): string {
  if (event === 'added') return '+'
  if (event === 'removed') return '-'
  return '~'
}

function AgentEntry({
  agentPath,
  running,
  changes,
  getAgentName,
}: {
  agentPath: string
  running: boolean
  changes: FileChange[]
  getAgentName: (p: string) => string
}) {
  const recent = changes.slice(-5)
  return (
    <Box flexDirection="column">
      <Text color={running ? 'green' : 'yellow'}>{running ? '● ' : '○ '}{getAgentName(agentPath)}</Text>
      {recent.map((c, i) => (
        <Text key={i} color="gray" dimColor wrap="truncate">
          {'  '}{changeIcon(c.event)} {c.path}
        </Text>
      ))}
    </Box>
  )
}

export function QueuePanel({ width, height, inputFiles, queueRunning, queueWaiting, queueChanges, getAgentName }: Props) {
  const hasQueue = queueRunning !== null || queueWaiting.length > 0
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="gray"
      width={width}
      height={height}
      overflow="hidden"
    >
      <Text bold>Queue</Text>
      {inputFiles.length > 0 && (
        <Box flexDirection="column">
          <Text color="gray" dimColor>── input ──</Text>
          {inputFiles.map((f) => <Text key={f} color="cyan" wrap="truncate">  {f}</Text>)}
        </Box>
      )}
      {!hasQueue
        ? <Text color="gray" dimColor>  idle</Text>
        : <>
          {queueRunning && (
            <AgentEntry
              agentPath={queueRunning}
              running={true}
              changes={queueChanges[queueRunning] ?? []}
              getAgentName={getAgentName}
            />
          )}
          {queueWaiting.map((agent) => (
            <AgentEntry
              key={agent}
              agentPath={agent}
              running={false}
              changes={queueChanges[agent] ?? []}
              getAgentName={getAgentName}
            />
          ))}
        </>
      }
    </Box>
  )
}

