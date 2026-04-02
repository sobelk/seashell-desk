import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'

interface Props {
  width: number
  agentPaths: string[]   // relative paths like ['input', 'projects/finance']
  isActive: boolean
  onSend: (agentRelPath: string, message: string) => void
}

export function InputBar({ width, agentPaths, isActive, onSend }: Props) {
  const [value, setValue] = useState('')
  const [cursorOn, setCursorOn] = useState(true)

  // Blink cursor when active
  React.useEffect(() => {
    if (!isActive) { setCursorOn(true); return }
    const t = setInterval(() => setCursorOn(c => !c), 500)
    return () => clearInterval(t)
  }, [isActive])

  useInput((input, key) => {
    if (key.escape) {
      setValue('')
      return
    }

    if (key.return) {
      const trimmed = value.trim()
      if (!trimmed) return
      // Parse @agentPath prefix
      const match = trimmed.match(/^@([\w/.-]+)\s+(.+)$/)
      const agentRelPath = match ? (match[1] ?? 'input') : 'input'
      const message = match ? (match[2] ?? trimmed).trim() : trimmed
      onSend(agentRelPath, message)
      setValue('')
      return
    }

    if (key.tab) {
      // Complete @mention
      const atMatch = value.match(/@([\w/.-]*)$/)
      if (atMatch) {
        const query = atMatch[1] ?? ''
        const match = agentPaths.find(p => p.startsWith(query))
        if (match) {
          setValue(value.slice(0, value.length - atMatch[0].length) + '@' + match + ' ')
        }
      }
      return
    }

    if (key.backspace || key.delete) {
      setValue(v => v.slice(0, -1))
      return
    }

    if (input && !key.ctrl && !key.meta) {
      setValue(v => v + input)
    }
  }, { isActive })

  // Determine autocomplete completions
  const atMatch = value.match(/@([\w/.-]*)$/)
  const completions = atMatch
    ? agentPaths.filter(p => p.startsWith(atMatch[1] ?? '')).slice(0, 5)
    : []

  const cursor = isActive ? (cursorOn ? '▋' : ' ') : ''
  const hint = isActive ? '' : '  press / to type'
  const prefix = isActive ? '> ' : '  '

  return (
    <Box flexDirection="column" width={width}>
      {/* Separator */}
      <Text color="gray">{'─'.repeat(width)}</Text>
      {/* Completions row */}
      <Box height={1}>
        {completions.length > 0 ? (
          completions.map((c, i) => (
            <Text key={c} color={i === 0 ? 'cyan' : 'gray'}>{' @' + c + '  '}</Text>
          ))
        ) : (
          <Text color="gray">{isActive ? '  @input  @projects/…  (Tab to complete)' : ''}</Text>
        )}
      </Box>
      {/* Input row */}
      <Box>
        <Text color={isActive ? 'cyan' : 'gray'}>{prefix}</Text>
        <Text>{value}</Text>
        <Text color="cyan">{cursor}</Text>
        <Text color="gray">{hint}</Text>
      </Box>
    </Box>
  )
}
