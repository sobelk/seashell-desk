import { google, type calendar_v3 } from 'googleapis'
import { GoogleAuth } from './google-auth.js'

export interface CalendarEvent {
  id: string
  calendarId: string
  summary: string
  description?: string
  location?: string
  start: EventDateTime
  end: EventDateTime
  attendees?: Attendee[]
  htmlLink: string
  status: string
  recurrence?: string[]
}

export interface EventDateTime {
  dateTime?: string  // ISO 8601, for timed events
  date?: string      // YYYY-MM-DD, for all-day events
  timeZone?: string
}

export interface Attendee {
  email: string
  displayName?: string
  responseStatus?: string
}

export interface CalendarInfo {
  id: string
  summary: string
  primary: boolean
  accessRole: string
}

export interface ListEventsOptions {
  timeMin?: string   // ISO 8601
  timeMax?: string   // ISO 8601
  query?: string
  maxResults?: number
  singleEvents?: boolean
}

export interface CreateEventInput {
  summary: string
  description?: string
  location?: string
  start: EventDateTime
  end: EventDateTime
  attendees?: Array<{ email: string }>
  recurrence?: string[]
}

export class CalendarService {
  private calendar: calendar_v3.Calendar

  constructor(private auth: GoogleAuth) {
    this.calendar = google.calendar({ version: 'v3', auth: auth.client })
  }

  static fromEnv(): CalendarService {
    return new CalendarService(GoogleAuth.fromEnv())
  }

  private ensureAuthenticated(): Promise<void> {
    return this.auth.ensureAuthenticated()
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    await this.ensureAuthenticated()
    const res = await this.calendar.calendarList.list()
    return (res.data.items ?? []).map((c) => ({
      id: c.id!,
      summary: c.summary!,
      primary: c.primary ?? false,
      accessRole: c.accessRole ?? 'reader',
    }))
  }

  async listEvents(calendarId: string, options: ListEventsOptions = {}): Promise<CalendarEvent[]> {
    await this.ensureAuthenticated()
    const res = await this.calendar.events.list({
      calendarId,
      timeMin: options.timeMin,
      timeMax: options.timeMax,
      q: options.query,
      maxResults: options.maxResults ?? 20,
      singleEvents: options.singleEvents ?? true,
      orderBy: 'startTime',
    })
    return (res.data.items ?? []).map((e) => this.parseEvent(e, calendarId))
  }

  async getEvent(calendarId: string, eventId: string): Promise<CalendarEvent> {
    await this.ensureAuthenticated()
    const res = await this.calendar.events.get({ calendarId, eventId })
    return this.parseEvent(res.data, calendarId)
  }

  async createEvent(calendarId: string, input: CreateEventInput): Promise<CalendarEvent> {
    await this.ensureAuthenticated()
    const res = await this.calendar.events.insert({
      calendarId,
      requestBody: {
        summary: input.summary,
        description: input.description,
        location: input.location,
        start: input.start,
        end: input.end,
        attendees: input.attendees,
        recurrence: input.recurrence,
      },
    })
    return this.parseEvent(res.data, calendarId)
  }

  async updateEvent(
    calendarId: string,
    eventId: string,
    input: Partial<CreateEventInput>,
  ): Promise<CalendarEvent> {
    await this.ensureAuthenticated()
    const res = await this.calendar.events.patch({
      calendarId,
      eventId,
      requestBody: input,
    })
    return this.parseEvent(res.data, calendarId)
  }

  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    await this.ensureAuthenticated()
    await this.calendar.events.delete({ calendarId, eventId })
  }

  private parseEvent(raw: calendar_v3.Schema$Event, calendarId: string): CalendarEvent {
    return {
      id: raw.id!,
      calendarId,
      summary: raw.summary ?? '(no title)',
      description: raw.description ?? undefined,
      location: raw.location ?? undefined,
      start: {
        dateTime: raw.start?.dateTime ?? undefined,
        date: raw.start?.date ?? undefined,
        timeZone: raw.start?.timeZone ?? undefined,
      },
      end: {
        dateTime: raw.end?.dateTime ?? undefined,
        date: raw.end?.date ?? undefined,
        timeZone: raw.end?.timeZone ?? undefined,
      },
      attendees: raw.attendees?.map((a) => ({
        email: a.email!,
        displayName: a.displayName ?? undefined,
        responseStatus: a.responseStatus ?? undefined,
      })),
      htmlLink: raw.htmlLink ?? '',
      status: raw.status ?? 'confirmed',
      recurrence: raw.recurrence ?? undefined,
    }
  }
}
