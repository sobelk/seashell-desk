import React, { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import { classifyLine } from '../shared/presentation.js'

interface Props {
  title: string
  logs: string[]
  width: number
  height: number
  active: boolean
  waiting: boolean
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

function useSpinner(active: boolean): string {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80)
    return () => clearInterval(t)
  }, [active])
  return SPINNER_FRAMES[frame] ?? '⠋'
}

function LogLine({ line }: { line: string }) {
  const kind = classifyLine(line)
  if (kind === 'tool') {
    const body = line.slice('[tool]'.length)
    return (
      <Box>
        <Text color="gray" dimColor wrap="truncate">{'  '}{body.trimStart()}</Text>
      </Box>
    )
  }
  if (kind === 'agent') {
    const body = line.slice('[agent]'.length).trimStart()
    return <Box><Text wrap="truncate">{body}</Text></Box>
  }
  if (kind === 'error') {
    return <Box><Text color="red" wrap="truncate">{line}</Text></Box>
  }
  if (kind === 'user') {
    const body = line.slice('[user]'.length).trimStart()
    return <Box><Text color="cyan" wrap="truncate">{'you: '}{body}</Text></Box>
  }
  return <Box><Text color="gray" wrap="truncate">{line}</Text></Box>
}

export function AgentRow({ title, logs, width, height, active, waiting }: Props) {
  const spinner = useSpinner(waiting)
  const bodyHeight = Math.max(1, height - 3)
  const visible = logs.slice(-bodyHeight)
  const statusIndicator = waiting
    ? <Text color="yellow">  {spinner}</Text>
    : active
      ? <Text color="green">  ●</Text>
      : null

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={active || waiting ? 'green' : 'gray'}
      width={width}
      height={height}
      overflow="hidden"
    >
      <Box>
        <Text bold color={active || waiting ? 'green' : 'white'}>{title}</Text>
        {statusIndicator}
      </Box>
      <Box flexDirection="column" overflow="hidden">
        {visible.map((line, i) => <LogLine key={i} line={line} />)}
      </Box>
    </Box>
  )
}

