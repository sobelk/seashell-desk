/**
 * Gmail tools for LLM tool-call workflows (Anthropic tool_use format).
 *
 * Usage:
 *   1. Pass `gmailTools` in the `tools` array when calling the Anthropic API.
 *   2. When the model returns a `tool_use` block, call `runGmailTool` with the
 *      tool name and input, then return the result as a `tool_result` message.
 */

import { z } from 'zod'
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import path from 'path'
import { GmailService } from '../services/gmail.js'

const DESK_LABEL = '🐚 desk'
// src/tools/ → src/ → repo root → desk/input/
const DEFAULT_DESK_INPUT_DIR = path.join(import.meta.dirname, '..', '..', 'desk', 'input')

// ---------------------------------------------------------------------------
// Tool definitions (Anthropic tool_use format)
// ---------------------------------------------------------------------------

export const gmailTools = [
  {
    name: 'gmail_search',
    description:
      'Search Gmail messages using Gmail search syntax. Returns matching messages including headers, plain-text body, and attachment metadata. The body field contains the full plain-text content. Use gmail_get_attachment to download attachments or gmail_read to re-fetch a single message.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description:
            'Gmail search query (e.g. "is:unread in:inbox", "from:@delta.com", "subject:payment after:2026/01/01")',
        },
        max_results: {
          type: 'number',
          description: 'Maximum messages to return. Default 20, max 50.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'gmail_read',
    description:
      'Fetch a single Gmail message by ID. Useful for re-fetching a specific message without searching. Returns headers, plain-text body, and attachment metadata.',
    input_schema: {
      type: 'object' as const,
      properties: {
        message_id: {
          type: 'string',
          description: 'Gmail message ID',
        },
      },
      required: ['message_id'],
    },
  },
  {
    name: 'gmail_get_attachment',
    description:
      'Download a message attachment. If output_path is provided (relative to desk/), saves the binary file directly to disk — use this for PDFs and other binary files. Without output_path, returns the raw bytes as base64.',
    input_schema: {
      type: 'object' as const,
      properties: {
        message_id: {
          type: 'string',
          description: 'Gmail message ID that contains the attachment',
        },
        attachment_id: {
          type: 'string',
          description: 'Attachment ID from the message',
        },
        filename: {
          type: 'string',
          description: 'Original filename (for context only)',
        },
        output_path: {
          type: 'string',
          description: 'If provided, save the attachment to this path relative to desk/ (e.g. "files/pdfs/bill.pdf"). The file is written as binary — use this for PDFs and images. Parent directories are created automatically.',
        },
      },
      required: ['message_id', 'attachment_id'],
    },
  },
  {
    name: 'gmail_list_labels',
    description: 'List all Gmail labels for this account, including system labels (INBOX, SENT, etc.) and user-created labels. Useful for finding label IDs before calling gmail_modify_labels.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'gmail_archive',
    description:
      'Archive a Gmail message — removes it from the inbox without deleting it. Use this after a message has been processed and filed.',
    input_schema: {
      type: 'object' as const,
      properties: {
        message_id: {
          type: 'string',
          description: 'Gmail message ID to archive',
        },
      },
      required: ['message_id'],
    },
  },
  {
    name: 'gmail_modify_labels',
    description:
      'Add or remove labels on a Gmail message. Use gmail_list_labels first to find label IDs.',
    input_schema: {
      type: 'object' as const,
      properties: {
        message_id: {
          type: 'string',
          description: 'Gmail message ID',
        },
        add_label_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Label IDs to add',
        },
        remove_label_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Label IDs to remove',
        },
      },
      required: ['message_id'],
    },
  },
  {
    name: 'gmail_process_inbox',
    description:
      'Fetch N emails from the inbox that have not yet been processed (i.e. do not have the "🐚 desk" label), write each as a JSON file to the desk input directory, and apply the "🐚 desk" label. Emails are returned most recent first. Run repeatedly to work through the inbox in batches.',
    input_schema: {
      type: 'object' as const,
      properties: {
        n: {
          type: 'number',
          description: 'Number of emails to process. Default 5.',
        },
        desk_input_dir: {
          type: 'string',
          description: 'Path to the desk input directory. Defaults to desk/input/ at the repo root.',
        },
      },
      required: [],
    },
  },
] as const

export type GmailToolName = (typeof gmailTools)[number]['name']

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const SearchInput = z.object({
  query: z.string(),
  max_results: z.number().min(1).max(50).optional().default(20),
})

const ReadInput = z.object({
  message_id: z.string(),
})

const DESK_ROOT = path.join(import.meta.dirname, '..', '..', 'desk')

const GetAttachmentInput = z.object({
  message_id: z.string(),
  attachment_id: z.string(),
  filename: z.string().optional(),
  output_path: z.string().optional(),
})

const ArchiveInput = z.object({
  message_id: z.string(),
})

const ModifyLabelsInput = z.object({
  message_id: z.string(),
  add_label_ids: z.array(z.string()).optional().default([]),
  remove_label_ids: z.array(z.string()).optional().default([]),
})

const ProcessInboxInput = z.object({
  n: z.number().min(1).max(50).optional().default(5),
  desk_input_dir: z.string().optional(),
})

// ---------------------------------------------------------------------------
// Tool executor
// ---------------------------------------------------------------------------

/**
 * Execute a Gmail tool call. Returns a value suitable for use as a
 * `tool_result` content block in an Anthropic API request.
 *
 * Errors are caught and returned as `{ error: string }` so the model can
 * react to failures rather than the process crashing.
 */
export async function runGmailTool(
  service: GmailService,
  toolName: GmailToolName,
  input: unknown,
): Promise<unknown> {
  try {
    switch (toolName) {
      case 'gmail_search': {
        const { query, max_results } = SearchInput.parse(input)
        return await service.searchMessages(query, max_results)
      }

      case 'gmail_read': {
        const { message_id } = ReadInput.parse(input)
        return await service.getMessage(message_id)
      }

      case 'gmail_get_attachment': {
        const { message_id, attachment_id, output_path } = GetAttachmentInput.parse(input)
        const buffer = await service.getAttachment(message_id, attachment_id)

        if (output_path) {
          const resolved = path.resolve(DESK_ROOT, output_path)
          if (!resolved.startsWith(DESK_ROOT + path.sep)) {
            return { error: `output_path escapes desk/ directory: ${output_path}` }
          }
          mkdirSync(path.dirname(resolved), { recursive: true })
          writeFileSync(resolved, buffer)
          return { saved: output_path, bytes: buffer.length }
        }

        return { data: buffer.toString('base64'), encoding: 'base64', bytes: buffer.length }
      }

      case 'gmail_list_labels': {
        return await service.listLabels()
      }

      case 'gmail_archive': {
        const { message_id } = ArchiveInput.parse(input)
        await service.archiveMessage(message_id)
        return { success: true, message_id }
      }

      case 'gmail_modify_labels': {
        const { message_id, add_label_ids, remove_label_ids } = ModifyLabelsInput.parse(input)
        await service.modifyLabels(message_id, add_label_ids, remove_label_ids)
        return { success: true, message_id }
      }

      case 'gmail_process_inbox': {
        const { n, desk_input_dir } = ProcessInboxInput.parse(input)
        const inputDir = desk_input_dir ?? DEFAULT_DESK_INPUT_DIR

        // Ensure the desk label exists
        const label = await service.ensureLabel(DESK_LABEL)

        // Fetch inbox emails not yet labelled — request slightly more to
        // account for any edge cases, then trim to n
        const messages = await service.searchMessages(
          `in:inbox -label:"${DESK_LABEL}"`,
          n,
        )

        if (!existsSync(inputDir)) mkdirSync(inputDir, { recursive: true })

        const written: string[] = []
        for (const message of messages) {
          const envelope = {
            type: 'gmail.message',
            source: 'gmail.personal',
            ...message,
          }
          const filename = `${message.id}.json`
          writeFileSync(path.join(inputDir, filename), JSON.stringify(envelope, null, 2))
          await service.modifyLabels(message.id, [label.id], [])
          written.push(filename)
        }

        return { written, count: written.length, labelApplied: DESK_LABEL }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { error: message }
  }
}
