import { google, type gmail_v1 } from 'googleapis'
import { GoogleAuth } from './google-auth.js'

export interface GmailMessage {
  id: string
  threadId: string
  subject: string
  from: string
  to: string
  date: string
  snippet: string
  body: string
  labelIds: string[]
  attachments: GmailAttachment[]
}

export interface GmailAttachment {
  id: string
  filename: string
  mimeType: string
  size: number
}

export interface GmailLabel {
  id: string
  name: string
  type: string
}

export class GmailService {
  private gmail: gmail_v1.Gmail

  constructor(private auth: GoogleAuth) {
    this.gmail = google.gmail({ version: 'v1', auth: auth.client })
  }

  static fromEnv(): GmailService {
    return new GmailService(GoogleAuth.fromEnv())
  }

  private ensureAuthenticated(): Promise<void> {
    return this.auth.ensureAuthenticated()
  }

  async searchMessages(query: string, maxResults = 20): Promise<GmailMessage[]> {
    await this.ensureAuthenticated()
    const listRes = await this.gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: Math.min(maxResults, 50),
    })

    const stubs = listRes.data.messages ?? []
    return Promise.all(stubs.map((m) => this.getMessage(m.id!)))
  }

  async getMessage(id: string): Promise<GmailMessage> {
    await this.ensureAuthenticated()
    const res = await this.gmail.users.messages.get({
      userId: 'me',
      id,
      format: 'full',
    })
    return this.parseMessage(res.data)
  }

  async getAttachment(messageId: string, attachmentId: string): Promise<Buffer> {
    await this.ensureAuthenticated()
    const res = await this.gmail.users.messages.attachments.get({
      userId: 'me',
      messageId,
      id: attachmentId,
    })
    return Buffer.from(res.data.data ?? '', 'base64url')
  }

  async listLabels(): Promise<GmailLabel[]> {
    await this.ensureAuthenticated()
    const res = await this.gmail.users.labels.list({ userId: 'me' })
    return (res.data.labels ?? []).map((l) => ({
      id: l.id!,
      name: l.name!,
      type: l.type ?? 'user',
    }))
  }

  async ensureLabel(name: string): Promise<GmailLabel> {
    await this.ensureAuthenticated()
    const labels = await this.listLabels()
    const existing = labels.find((l) => l.name === name)
    if (existing) return existing

    const res = await this.gmail.users.labels.create({
      userId: 'me',
      requestBody: {
        name,
        labelListVisibility: 'labelShow',
        messageListVisibility: 'show',
      },
    })
    return {
      id: res.data.id!,
      name: res.data.name!,
      type: res.data.type ?? 'user',
    }
  }

  async archiveMessage(id: string): Promise<void> {
    await this.ensureAuthenticated()
    await this.gmail.users.messages.modify({
      userId: 'me',
      id,
      requestBody: { removeLabelIds: ['INBOX'] },
    })
  }

  async modifyLabels(
    id: string,
    addLabelIds: string[],
    removeLabelIds: string[],
  ): Promise<void> {
    await this.ensureAuthenticated()
    await this.gmail.users.messages.modify({
      userId: 'me',
      id,
      requestBody: { addLabelIds, removeLabelIds },
    })
  }

  // --- Parsing ---

  private parseMessage(raw: gmail_v1.Schema$Message): GmailMessage {
    const headers = raw.payload?.headers ?? []
    const header = (name: string) =>
      headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? ''

    const attachments: GmailAttachment[] = []
    const body = this.extractBody(raw.payload, attachments)

    return {
      id: raw.id!,
      threadId: raw.threadId!,
      subject: header('subject'),
      from: header('from'),
      to: header('to'),
      date: header('date'),
      snippet: raw.snippet ?? '',
      body,
      labelIds: raw.labelIds ?? [],
      attachments,
    }
  }

  private extractBody(
    part: gmail_v1.Schema$MessagePart | undefined,
    attachments: GmailAttachment[],
  ): string {
    this.collectAttachments(part, attachments)

    const plain = this.findPart(part, 'text/plain')
    if (plain?.body?.data) {
      return Buffer.from(plain.body.data, 'base64url').toString('utf-8')
    }

    const html = this.findPart(part, 'text/html')
    if (html?.body?.data) {
      return this.stripHtml(Buffer.from(html.body.data, 'base64url').toString('utf-8'))
    }

    return ''
  }

  private findPart(
    part: gmail_v1.Schema$MessagePart | undefined,
    mimeType: string,
  ): gmail_v1.Schema$MessagePart | undefined {
    if (!part) return undefined
    if (part.mimeType === mimeType && part.body?.data) return part
    for (const child of part.parts ?? []) {
      const found = this.findPart(child, mimeType)
      if (found) return found
    }
    return undefined
  }

  private collectAttachments(
    part: gmail_v1.Schema$MessagePart | undefined,
    attachments: GmailAttachment[],
  ): void {
    if (!part) return
    if (part.filename && part.body?.attachmentId) {
      attachments.push({
        id: part.body.attachmentId,
        filename: part.filename,
        mimeType: part.mimeType ?? 'application/octet-stream',
        size: part.body.size ?? 0,
      })
      return
    }
    for (const child of part.parts ?? []) {
      this.collectAttachments(child, attachments)
    }
  }

  private stripHtml(html: string): string {
    return html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim()
  }
}
