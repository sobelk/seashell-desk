/**
 * Google Calendar tools for LLM tool-call workflows (Anthropic tool_use format).
 *
 * Usage:
 *   1. Pass `calendarTools` in the `tools` array when calling the Anthropic API.
 *   2. When the model returns a `tool_use` block, call `runCalendarTool` with the
 *      tool name and input, then return the result as a `tool_result` message.
 */

import { z } from 'zod'
import { CalendarService } from '../services/calendar.js'

// ---------------------------------------------------------------------------
// Tool definitions (Anthropic tool_use format)
// ---------------------------------------------------------------------------

export const calendarTools = [
  {
    name: 'gcal_list_calendars',
    description:
      'List all Google Calendars accessible to the user. Returns calendar IDs and names. Call this first to find the right calendar ID before creating or listing events.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'gcal_list_events',
    description:
      'List events from a calendar within a time range, optionally filtered by a search query. Returns event details including ID, title, time, description, and location.',
    input_schema: {
      type: 'object' as const,
      properties: {
        calendar_id: {
          type: 'string',
          description: 'Calendar ID (use "primary" for the main calendar). Get IDs from gcal_list_calendars.',
        },
        time_min: {
          type: 'string',
          description: 'Start of time range, ISO 8601 (e.g. "2026-03-28T00:00:00Z"). Defaults to now.',
        },
        time_max: {
          type: 'string',
          description: 'End of time range, ISO 8601.',
        },
        query: {
          type: 'string',
          description: 'Free-text search query to filter events by title or description.',
        },
        max_results: {
          type: 'number',
          description: 'Maximum events to return. Default 20.',
        },
      },
      required: ['calendar_id'],
    },
  },
  {
    name: 'gcal_get_event',
    description: 'Fetch a single calendar event by ID.',
    input_schema: {
      type: 'object' as const,
      properties: {
        calendar_id: {
          type: 'string',
          description: 'Calendar ID containing the event.',
        },
        event_id: {
          type: 'string',
          description: 'Event ID.',
        },
      },
      required: ['calendar_id', 'event_id'],
    },
  },
  {
    name: 'gcal_create_event',
    description:
      'Create a new calendar event. For timed events, provide dateTime in ISO 8601 with timezone (e.g. "2026-04-01T10:00:00-07:00"). For all-day events, use date ("2026-04-01") without dateTime.',
    input_schema: {
      type: 'object' as const,
      properties: {
        calendar_id: {
          type: 'string',
          description: 'Calendar ID. Use "primary" for the main calendar.',
        },
        summary: {
          type: 'string',
          description: 'Event title.',
        },
        description: {
          type: 'string',
          description: 'Event description or notes.',
        },
        location: {
          type: 'string',
          description: 'Event location.',
        },
        start: {
          type: 'object',
          description: 'Event start time.',
          properties: {
            dateTime: { type: 'string', description: 'ISO 8601 datetime for timed events.' },
            date: { type: 'string', description: 'YYYY-MM-DD for all-day events.' },
            timeZone: { type: 'string', description: 'IANA timezone (e.g. "America/New_York").' },
          },
        },
        end: {
          type: 'object',
          description: 'Event end time. Same format as start.',
          properties: {
            dateTime: { type: 'string' },
            date: { type: 'string' },
            timeZone: { type: 'string' },
          },
        },
        attendees: {
          type: 'array',
          description: 'Optional list of attendee email addresses.',
          items: {
            type: 'object',
            properties: { email: { type: 'string' } },
          },
        },
      },
      required: ['calendar_id', 'summary', 'start', 'end'],
    },
  },
  {
    name: 'gcal_update_event',
    description: 'Update fields on an existing calendar event. Only provided fields are changed.',
    input_schema: {
      type: 'object' as const,
      properties: {
        calendar_id: { type: 'string', description: 'Calendar ID.' },
        event_id: { type: 'string', description: 'Event ID to update.' },
        summary: { type: 'string' },
        description: { type: 'string' },
        location: { type: 'string' },
        start: {
          type: 'object',
          properties: {
            dateTime: { type: 'string' },
            date: { type: 'string' },
            timeZone: { type: 'string' },
          },
        },
        end: {
          type: 'object',
          properties: {
            dateTime: { type: 'string' },
            date: { type: 'string' },
            timeZone: { type: 'string' },
          },
        },
      },
      required: ['calendar_id', 'event_id'],
    },
  },
  {
    name: 'gcal_delete_event',
    description: 'Delete a calendar event.',
    input_schema: {
      type: 'object' as const,
      properties: {
        calendar_id: { type: 'string', description: 'Calendar ID.' },
        event_id: { type: 'string', description: 'Event ID to delete.' },
      },
      required: ['calendar_id', 'event_id'],
    },
  },
] as const

export type CalendarToolName = (typeof calendarTools)[number]['name']

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const ListEventsInput = z.object({
  calendar_id: z.string(),
  time_min: z.string().optional(),
  time_max: z.string().optional(),
  query: z.string().optional(),
  max_results: z.number().min(1).max(100).optional().default(20),
})

const GetEventInput = z.object({
  calendar_id: z.string(),
  event_id: z.string(),
})

const EventDateTimeSchema = z.object({
  dateTime: z.string().optional(),
  date: z.string().optional(),
  timeZone: z.string().optional(),
})

const CreateEventInput = z.object({
  calendar_id: z.string(),
  summary: z.string(),
  description: z.string().optional(),
  location: z.string().optional(),
  start: EventDateTimeSchema,
  end: EventDateTimeSchema,
  attendees: z.array(z.object({ email: z.string() })).optional(),
})

const UpdateEventInput = z.object({
  calendar_id: z.string(),
  event_id: z.string(),
  summary: z.string().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  start: EventDateTimeSchema.optional(),
  end: EventDateTimeSchema.optional(),
})

const DeleteEventInput = z.object({
  calendar_id: z.string(),
  event_id: z.string(),
})

// ---------------------------------------------------------------------------
// Tool executor
// ---------------------------------------------------------------------------

export async function runCalendarTool(
  service: CalendarService,
  toolName: CalendarToolName,
  input: unknown,
): Promise<unknown> {
  try {
    switch (toolName) {
      case 'gcal_list_calendars': {
        return await service.listCalendars()
      }

      case 'gcal_list_events': {
        const { calendar_id, time_min, time_max, query, max_results } = ListEventsInput.parse(input)
        return await service.listEvents(calendar_id, {
          timeMin: time_min,
          timeMax: time_max,
          query,
          maxResults: max_results,
        })
      }

      case 'gcal_get_event': {
        const { calendar_id, event_id } = GetEventInput.parse(input)
        return await service.getEvent(calendar_id, event_id)
      }

      case 'gcal_create_event': {
        const { calendar_id, ...eventInput } = CreateEventInput.parse(input)
        return await service.createEvent(calendar_id, eventInput)
      }

      case 'gcal_update_event': {
        const { calendar_id, event_id, ...updates } = UpdateEventInput.parse(input)
        return await service.updateEvent(calendar_id, event_id, updates)
      }

      case 'gcal_delete_event': {
        const { calendar_id, event_id } = DeleteEventInput.parse(input)
        await service.deleteEvent(calendar_id, event_id)
        return { success: true, event_id }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { error: message }
  }
}
