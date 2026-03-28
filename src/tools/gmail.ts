/**
 * Gmail tools for LLM tool-call workflows (Anthropic tool_use format).
 *
 * Usage:
 *   1. Pass `gmailTools` in the `tools` array when calling the Anthropic API.
 *   2. When the model returns a `tool_use` block, call `runGmailTool` with the
 *      tool name and input, then return the result as a `tool_result` message.
 */

import { z } from 'zod'
import { GmailService } from '../services/gmail.js'

// ---------------------------------------------------------------------------
// Tool definitions (Anthropic tool_use format)
// ---------------------------------------------------------------------------

export const gmailTools = [
  {
    name: 'gmail_search',
    description:
      'Search Gmail messages using Gmail search syntax. Returns matching messages including headers, body text, and attachment metadata. Use this to find emails before reading or acting on them.',
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
      'Fetch a single Gmail message by ID. Returns full headers, decoded body text, and a list of attachments (with attachment IDs for downloading).',
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
      'Download a message attachment as a base64-encoded string. Use the attachment ID from a gmail_read result.',
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
          description: 'Original filename (for context only, not used in the API call)',
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

const GetAttachmentInput = z.object({
  message_id: z.string(),
  attachment_id: z.string(),
  filename: z.string().optional(),
})

const ArchiveInput = z.object({
  message_id: z.string(),
})

const ModifyLabelsInput = z.object({
  message_id: z.string(),
  add_label_ids: z.array(z.string()).optional().default([]),
  remove_label_ids: z.array(z.string()).optional().default([]),
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
        const { message_id, attachment_id } = GetAttachmentInput.parse(input)
        const buffer = await service.getAttachment(message_id, attachment_id)
        return { data: buffer.toString('base64'), encoding: 'base64' }
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
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { error: message }
  }
}
