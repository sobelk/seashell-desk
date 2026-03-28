import { google, type gmail_v1 } from 'googleapis'
import { type OAuth2Client } from 'google-auth-library'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { createServer } from 'http'
import { URL } from 'url'
import path from 'path'

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
]

// .credentials/ lives at the repo root, two levels above src/services/
const CREDENTIALS_DIR = path.join(import.meta.dirname, '..', '..', '.credentials')
const TOKEN_PATH = path.join(CREDENTIALS_DIR, 'gmail-token.json')
const OAUTH_CLIENT_PATH = path.join(CREDENTIALS_DIR, 'gmail-oauth-client.json')
const REDIRECT_PORT = 3000
// Installed-app OAuth clients accept any http://localhost:{port}
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}`

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
  private client: OAuth2Client
  private gmail: gmail_v1.Gmail
  private authPromise: Promise<void> | null = null

  constructor(clientId: string, clientSecret: string) {
    this.client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI)
    this.gmail = google.gmail({ version: 'v1', auth: this.client })
  }

  /** Called automatically before any API method. Safe to call multiple times. */
  private ensureAuthenticated(): Promise<void> {
    if (!this.authPromise) {
      this.authPromise = this.authenticate()
    }
    return this.authPromise
  }

  /**
   * Create a GmailService from environment variables, falling back to the
   * downloaded OAuth client JSON at .credentials/gmail-oauth-client.json.
   */
  static fromEnv(): GmailService {
    const clientId = process.env['GMAIL_CLIENT_ID']
    const clientSecret = process.env['GMAIL_CLIENT_SECRET']

    if (clientId && clientSecret) {
      return new GmailService(clientId, clientSecret)
    }

    if (existsSync(OAUTH_CLIENT_PATH)) {
      const raw = JSON.parse(readFileSync(OAUTH_CLIENT_PATH, 'utf-8'))
      const client = raw.web ?? raw.installed
      if (!client?.client_id || !client?.client_secret) {
        throw new Error(`Could not parse OAuth client credentials from ${OAUTH_CLIENT_PATH}`)
      }
      return new GmailService(client.client_id, client.client_secret)
    }

    throw new Error(
      'Gmail credentials not found. Set GMAIL_CLIENT_ID + GMAIL_CLIENT_SECRET env vars, ' +
        `or place the OAuth client JSON at ${OAUTH_CLIENT_PATH}`,
    )
  }

  async authenticate(): Promise<void> {
    if (existsSync(TOKEN_PATH)) {
      const tokens = JSON.parse(readFileSync(TOKEN_PATH, 'utf-8'))
      this.client.setCredentials(tokens)
      // Persist refreshed tokens automatically
      this.client.on('tokens', (newTokens) => {
        this.saveTokens(newTokens as Record<string, unknown>)
      })
      return
    }
    await this.runAuthFlow()
  }

  private saveTokens(tokens: Record<string, unknown>): void {
    if (!existsSync(CREDENTIALS_DIR)) {
      mkdirSync(CREDENTIALS_DIR, { recursive: true })
    }
    // Merge to preserve refresh_token across access_token refreshes
    const existing = existsSync(TOKEN_PATH)
      ? JSON.parse(readFileSync(TOKEN_PATH, 'utf-8'))
      : {}
    writeFileSync(TOKEN_PATH, JSON.stringify({ ...existing, ...tokens }, null, 2))
  }

  private async runAuthFlow(): Promise<void> {
    const authUrl = this.client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      prompt: 'consent', // force refresh_token issuance
    })

    console.log('\nAuthorize Seashell Desk to access Gmail:')
    console.log(authUrl)
    console.log('\nWaiting for authorization...')

    const code = await this.waitForAuthCode()
    const { tokens } = await this.client.getToken(code)
    this.client.setCredentials(tokens)
    this.saveTokens(tokens as Record<string, unknown>)
    console.log('Gmail authorization complete. Tokens saved to .credentials/')
  }

  private waitForAuthCode(): Promise<string> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        try {
          const url = new URL(req.url ?? '/', `http://localhost:${REDIRECT_PORT}`)
          const code = url.searchParams.get('code')
          const error = url.searchParams.get('error')

          if (error) {
            res.writeHead(400).end('Authorization failed. You may close this window.')
            server.close()
            reject(new Error(`OAuth error: ${error}`))
            return
          }

          if (code) {
            res.writeHead(200).end('Authorization successful. You may close this window.')
            server.close()
            resolve(code)
          }
        } catch (err) {
          reject(err)
        }
      })

      server.listen(REDIRECT_PORT, () => {
        // Server is ready — auth URL has already been printed
      })

      server.on('error', reject)
    })
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
    // Gmail uses URL-safe base64
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

  /**
   * Find a label by name, creating it if it doesn't exist.
   */
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
