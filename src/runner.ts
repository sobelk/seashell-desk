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
}

export interface RunAgentResult {
  /** Final text response from the model */
  response: string
  /** Number of tool-use rounds completed */
  rounds: number
  /** Whether the agent hit the round limit without finishing */
  hitLimit: boolean
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
  if ('id' in obj && 'paths' in obj) return `task ${obj.id}`
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
    maxRounds = DEFAULT_MAX_ROUNDS,
    model = DEFAULT_MODEL,
    logLevel = 'normal',
    onToolExecuted,
    getPendingInjection,
  } = options

  const log = (msg: string) => {
    if (logLevel !== 'silent') process.stderr.write(msg + '\n')
  }
  const logVerbose = (msg: string) => {
    if (logLevel === 'verbose') process.stderr.write(msg + '\n')
  }

  const client = new Anthropic()

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: message },
  ]

  let rounds = 0

  while (rounds < maxRounds) {
    logVerbose(`\n[agent] ── Round ${rounds + 1} ──────────────────────────`)

    const response = await client.messages.create({
      model,
      max_tokens: 8096,
      system: systemPrompt,
      tools: tools as Anthropic.Tool[],
      messages,
    })

    // Add assistant turn to message history
    messages.push({ role: 'assistant', content: response.content })

    // Log any text the agent emits (thinking out loud, narration, etc.)
    const textBlocks = response.content.filter(
      (b): b is Anthropic.TextBlock => b.type === 'text',
    )
    for (const block of textBlocks) {
      const trimmed = block.text.trim()
      if (trimmed) log(`[agent] ${trimmed}`)
    }

    // If the model stopped without using tools, we're done
    if (response.stop_reason === 'end_turn') {
      const text = textBlocks.map((b) => b.text).join('\n')
      return { response: text, rounds, hitLimit: false }
    }

    // Collect and execute all tool_use blocks in parallel
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    )

    if (toolUseBlocks.length === 0) {
      const text = textBlocks.map((b) => b.text).join('\n')
      return { response: text, rounds, hitLimit: false }
    }

    const toolResults = await Promise.all(
      toolUseBlocks.map(async (block) => {
        logVerbose(`[tool]  → ${block.name}(${formatInput(block.input)})`)

        let output: unknown
        try {
          output = await toolExecutor(block.name, block.input)
        } catch (err) {
          output = { error: err instanceof Error ? err.message : String(err) }
        }

        onToolExecuted?.(block.name, block.input, output)
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

  return { response: text, rounds, hitLimit: true }
}
