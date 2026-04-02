import React, { useEffect, useState } from 'react'
import { Box, Text } from 'ink'

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

// Classify a log line for display styling
type LineKind = 'agent' | 'tool' | 'error' | 'user' | 'other'

function classifyLine(line: string): LineKind {
  if (line.startsWith('[tool]')) return 'tool'
  if (line.startsWith('[agent]')) return 'agent'
  if (line.startsWith('[error]')) return 'error'
  if (line.startsWith('[user]')) return 'user'
  return 'other'
}

function LogLine({ line }: { line: string }) {
  const kind = classifyLine(line)

  // Each LogLine is wrapped in a Box so it always occupies its own row in the
  // column layout — bare <Text> nodes can render inline in some Ink versions.
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
  // Reserve: top border (1) + title row (1) + bottom border (1)
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
        {visible.map((line, i) => (
          <LogLine key={i} line={line} />
        ))}
      </Box>
    </Box>
  )
}
