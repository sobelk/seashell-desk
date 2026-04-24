/**
 * Agent runner — drives an LLM agent in a tool-use loop.
 *
 * Takes a system prompt, a set of tools, and an initial user message.
 * Calls the Anthropic API repeatedly, dispatching tool_use blocks to real
 * tool implementations, until the model produces a final text response.
 *
 * Usage:
 *   import { runAgent } from './runner.js'
 *   const result = await runAgent({ systemPrompt, tools, toolExecutor, message })
 */

import Anthropic from '@anthropic-ai/sdk'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  name: string
  description: string
  input_schema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: readonly string[]
  }
}

export interface RunAgentOptions {
  /** System prompt — usually the contents of an AGENT.md file */
  systemPrompt: string
  /** Tool definitions passed to the model */
  tools: ToolDefinition[]
  /** Function that executes a named tool with the given input */
  toolExecutor: (toolName: string, input: unknown) => Promise<unknown>
  /** Initial user message to the agent */
  message: string
  /** Prior conversation to continue; the new message is appended as the next user turn */
  priorMessages?: Anthropic.MessageParam[]
  /** Maximum tool-use rounds before aborting (default 50) */
  maxRounds?: number
  /** Model to use (default claude-sonnet-4-6) */
  model?: string
  /**
   * Log level:
   *   'silent'  — no output
   *   'normal'  — tool calls + any agent text (default)
   *   'verbose' — also log inputs and full outputs
   */
  logLevel?: 'silent' | 'normal' | 'verbose'
  /**
   * Called synchronously before each tool executes (before the first await).
   * Use to pre-track paths so FS watch events fired during tool execution
   * are suppressed correctly.
   */
  onToolStart?: (toolName: string, input: unknown) => void
  /**
   * Called after each tool executes. Useful for tracking agent-originated
   * file writes to prevent re-triggering on those paths.
   */
  onToolExecuted?: (toolName: string, input: unknown, output: unknown) => void
  /**
   * Called at the start of each round. If it returns a non-empty string,
   * that text is appended to the tool_results user message as a text block,
   * letting the watcher inject external file-change events mid-run.
   */
  getPendingInjection?: () => string | null
  /**
   * Receives each log line instead of writing to stderr. When provided,
   * stderr output is suppressed entirely.
   */
  onLog?: (message: string) => void
  /**
   * Called with true just before blocking on the Anthropic API or tool
   * execution, and false once the response is received. Use to drive a
   * loading indicator in the UI.
   */
  onWaiting?: (waiting: boolean) => void
  /**
   * Called at the end of each round with a structured summary: agent text,
   * all tool calls (name + input + output), and token usage. Used for logging.
   */
  onRound?: (data: RoundData) => void
  /**
   * Streaming callbacks for agent text blocks. Invoked once `onTextStart` at
   * the start of each text content block, `onTextDelta` for each token/chunk
   * streamed from the model, and `onTextEnd` once the block is complete.
   *
   * `streamId` is an opaque identifier unique to that text block (per run).
   * When streaming callbacks are used, the runner does NOT also emit the
   * block's text via `onLog`, to avoid duplication.
   */
  onTextStart?: (streamId: string) => void
  onTextDelta?: (streamId: string, delta: string) => void
  onTextEnd?: (streamId: string, fullText: string) => void
}

export interface ToolCallData {
  id: string
  name: string
  input: unknown
  output: unknown
}

export interface RoundData {
  round: number
  text: string
  toolCalls: ToolCallData[]
  usage: {
    inputTokens: number
    outputTokens: number
    cacheCreationInputTokens: number
    cacheReadInputTokens: number
  }
}

export interface RunAgentResult {
  /** Final text response from the model */
  response: string
  /** Number of tool-use rounds completed */
  rounds: number
  /** Whether the agent hit the round limit without finishing */
  hitLimit: boolean
  /** Full conversation history after this run — pass as priorMessages to continue */
  messages: Anthropic.MessageParam[]
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function formatInput(input: unknown): string {
  const s = JSON.stringify(input)
  if (s.length <= 200) return s
  return s.slice(0, 197) + '…'
}

function formatOutput(output: unknown): string {
  if (output === null || output === undefined) return String(output)
  const obj = output as Record<string, unknown>

  // Surface the most meaningful field(s) rather than a raw truncated blob
  if ('error' in obj) return `ERROR: ${obj.error}`
  if ('saved' in obj) return `saved → ${obj.saved} (${obj.bytes} bytes)`
  if ('deleted' in obj) return `deleted ${obj.deleted}`
  if ('created' in obj) return `created ${obj.created}`
  if ('id' in obj && 'paths' in obj) {
    const verb = 'status' in obj || 'priority' in obj ? 'updated' : 'created'
    return `task ${verb}: ${obj.id}`
  }
  if ('entries' in obj && Array.isArray(obj.entries)) {
    const names = (obj.entries as Array<{ name: string }>).map((e) => e.name)
    return `[${names.join(', ')}]`
  }
  if ('path' in obj && 'content' in obj) {
    const content = String(obj.content)
    return `${obj.path} (${content.length} chars)`
  }
  if ('written' in obj && Array.isArray(obj.written)) return `wrote ${obj.written.length} files`
  if ('success' in obj) return `ok`
  if (Array.isArray(output)) return `[${output.length} items]`

  const s = JSON.stringify(output)
  return s.length <= 160 ? s : s.slice(0, 157) + '…'
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = 'claude-sonnet-4-6'
const DEFAULT_MAX_ROUNDS = 50

export async function runAgent(options: RunAgentOptions): Promise<RunAgentResult> {
  const {
    systemPrompt,
    tools,
    toolExecutor,
    message,
    priorMessages,
    maxRounds = DEFAULT_MAX_ROUNDS,
    model = DEFAULT_MODEL,
    logLevel = 'normal',
    onToolStart,
    onToolExecuted,
    getPendingInjection,
    onLog,
    onWaiting,
    onRound,
    onTextStart,
    onTextDelta,
    onTextEnd,
  } = options

  const streamsTextBlocks = Boolean(onTextStart || onTextDelta || onTextEnd)

  const emit = (msg: string) => {
    if (onLog) onLog(msg)
    else process.stderr.write(msg + '\n')
  }
  const log = (msg: string) => {
    if (logLevel !== 'silent') emit(msg)
  }
  const logVerbose = (msg: string) => {
    if (logLevel === 'verbose') emit(msg)
  }

  const client = new Anthropic()

  // Stable across all rounds — cache at the boundary after the last tool.
  const systemBlocks: Anthropic.TextBlockParam[] = [
    { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
  ]
  const toolsWithCache: Anthropic.Tool[] = (tools as Anthropic.Tool[]).map((t, i) =>
    i === tools.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t,
  )

  // Before each API call, mark the last user message with a cache breakpoint so
  // the growing conversation history is cached up to that point.
  function withCacheControl(msgs: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
    if (msgs.length === 0) return msgs
    const last = msgs.at(-1)!
    if (last.role !== 'user') return msgs
    const content: Anthropic.MessageParam['content'] = typeof last.content === 'string'
      ? [{ type: 'text' as const, text: last.content, cache_control: { type: 'ephemeral' as const } }]
      : (last.content as Anthropic.ContentBlockParam[]).map((b, i, arr) =>
          i === arr.length - 1 ? { ...b, cache_control: { type: 'ephemeral' as const } } : b,
        )
    return [...msgs.slice(0, -1), { role: 'user' as const, content }]
  }

  const messages: Anthropic.MessageParam[] = [
    ...(priorMessages ?? []),
    { role: 'user', content: message },
  ]

  let rounds = 0

  while (rounds < maxRounds) {
    logVerbose(`\n[agent] ── Round ${rounds + 1} ──────────────────────────`)

    onWaiting?.(true)

    // We always stream: it lets us emit text deltas to the UI and costs no
    // more than non-streaming. When no streaming callbacks are supplied, we
    // still collect a final Message via `finalMessage()` and behave as before.
    const stream = client.messages.stream({
      model,
      max_tokens: 8096,
      system: systemBlocks,
      tools: toolsWithCache,
      messages: withCacheControl(messages),
    })

    // Map raw block index → streamId for text blocks. Index is stable within a
    // single stream, but a fresh streamId per block is what callers want so
    // the UI can render each agent utterance as its own entry.
    const textStreamIdByIndex = new Map<number, string>()
    const textBufferByIndex = new Map<number, string>()

    if (streamsTextBlocks) {
      stream.on('streamEvent', (event) => {
        if (event.type === 'content_block_start' && event.content_block.type === 'text') {
          const streamId = `${rounds + 1}-${event.index}-${Math.random().toString(36).slice(2, 10)}`
          textStreamIdByIndex.set(event.index, streamId)
          textBufferByIndex.set(event.index, '')
          onTextStart?.(streamId)
          return
        }
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          const streamId = textStreamIdByIndex.get(event.index)
          if (!streamId) return
          const buffer = (textBufferByIndex.get(event.index) ?? '') + event.delta.text
          textBufferByIndex.set(event.index, buffer)
          onTextDelta?.(streamId, event.delta.text)
          return
        }
        if (event.type === 'content_block_stop') {
          const streamId = textStreamIdByIndex.get(event.index)
          if (!streamId) return
          onTextEnd?.(streamId, textBufferByIndex.get(event.index) ?? '')
          return
        }
      })
    }

    const response = await stream.finalMessage()
    onWaiting?.(false)

    // Add assistant turn to message history
    messages.push({ role: 'assistant', content: response.content })

    // Log any text the agent emits (thinking out loud, narration, etc.).
    // When streaming is wired up the UI already received the text via the
    // delta callbacks, so we skip the trailing `[agent]` log to avoid dupes.
    const textBlocks = response.content.filter(
      (b): b is Anthropic.TextBlock => b.type === 'text',
    )
    if (!streamsTextBlocks) {
      for (const block of textBlocks) {
        const trimmed = block.text.trim()
        if (trimmed) log(`[agent] ${trimmed}`)
      }
    }

    // If the model stopped without using tools, we're done
    if (response.stop_reason === 'end_turn') {
      const text = textBlocks.map((b) => b.text).join('\n')
      return { response: text, rounds, hitLimit: false, messages }
    }

    // Collect and execute all tool_use blocks in parallel
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    )

    if (toolUseBlocks.length === 0) {
      const text = textBlocks.map((b) => b.text).join('\n')
      return { response: text, rounds, hitLimit: false, messages }
    }

    onWaiting?.(true)
    const roundToolCalls: ToolCallData[] = []
    const toolResults = await Promise.all(
      toolUseBlocks.map(async (block) => {
        logVerbose(`[tool]  → ${block.name}(${formatInput(block.input)})`)
        onToolStart?.(block.name, block.input)

        let output: unknown
        try {
          output = await toolExecutor(block.name, block.input)
        } catch (err) {
          output = { error: err instanceof Error ? err.message : String(err) }
        }

        onToolExecuted?.(block.name, block.input, output)
        roundToolCalls.push({ id: block.id, name: block.name, input: block.input, output })
        log(`[tool]  ${block.name.padEnd(26)} ${formatOutput(output)}`)

        // If the tool returned a _rawContent sentinel, use it directly as the
        // content array so the model receives image/document blocks intact.
        const rawContent =
          output !== null &&
          typeof output === 'object' &&
          '_rawContent' in (output as object)
            ? (output as { _rawContent: Anthropic.ToolResultBlockParam['content'] })._rawContent
            : undefined

        return {
          type: 'tool_result' as const,
          tool_use_id: block.id,
          ...(rawContent !== undefined
            ? { content: rawContent }
            : { content: JSON.stringify(output) }),
        }
      }),
    )

    onWaiting?.(false)
    onRound?.({
      round: rounds + 1,
      text: textBlocks.map((b) => b.text).join('\n'),
      toolCalls: roundToolCalls,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheCreationInputTokens: response.usage.cache_creation_input_tokens ?? 0,
        cacheReadInputTokens: response.usage.cache_read_input_tokens ?? 0,
      },
    })
    // Append any externally-injected context (file changes from the watcher)
    // as a text block alongside the tool results.
    const injection = getPendingInjection?.()
    const userContent: Anthropic.MessageParam['content'] = injection
      ? [...toolResults, { type: 'text' as const, text: injection }]
      : toolResults

    messages.push({ role: 'user', content: userContent })
    rounds++
  }

  // Hit the round limit — return whatever text we have
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')
  const lastContent = lastAssistant?.content
  const text = Array.isArray(lastContent)
    ? lastContent
        .filter((b): b is Anthropic.TextBlock => typeof b === 'object' && 'type' in b && b.type === 'text')
        .map((b) => b.text)
        .join('\n')
    : ''

  return { response: text, rounds, hitLimit: true, messages }
}
