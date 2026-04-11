import { google } from 'googleapis'
import { type OAuth2Client } from 'google-auth-library'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { createServer } from 'http'
import { URL } from 'url'
import path from 'path'

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
]

const CREDENTIALS_DIR = path.join(import.meta.dirname, '..', '..', '.credentials')
const TOKEN_PATH = path.join(CREDENTIALS_DIR, 'google-token.json')
const OAUTH_CLIENT_PATH = path.join(CREDENTIALS_DIR, 'gmail-oauth-client.json')
const REDIRECT_PORT = 59201
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}`

export class GoogleAuth {
  readonly client: OAuth2Client
  private authPromise: Promise<void> | null = null

  constructor(clientId: string, clientSecret: string) {
    this.client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI)
  }

  static fromEnv(): GoogleAuth {
    const clientId = process.env['GMAIL_CLIENT_ID']
    const clientSecret = process.env['GMAIL_CLIENT_SECRET']

    if (clientId && clientSecret) {
      return new GoogleAuth(clientId, clientSecret)
    }

    if (existsSync(OAUTH_CLIENT_PATH)) {
      const raw = JSON.parse(readFileSync(OAUTH_CLIENT_PATH, 'utf-8'))
      const client = raw.web ?? raw.installed
      if (!client?.client_id || !client?.client_secret) {
        throw new Error(`Could not parse OAuth client credentials from ${OAUTH_CLIENT_PATH}`)
      }
      return new GoogleAuth(client.client_id, client.client_secret)
    }

    throw new Error(
      'Google credentials not found. Set GMAIL_CLIENT_ID + GMAIL_CLIENT_SECRET env vars, ' +
        `or place the OAuth client JSON at ${OAUTH_CLIENT_PATH}`,
    )
  }

  ensureAuthenticated(): Promise<void> {
    if (!this.authPromise) {
      this.authPromise = this.authenticate()
    }
    return this.authPromise
  }

  private async authenticate(): Promise<void> {
    if (existsSync(TOKEN_PATH)) {
      const tokens = JSON.parse(readFileSync(TOKEN_PATH, 'utf-8'))
      this.client.setCredentials(tokens)
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
    const existing = existsSync(TOKEN_PATH)
      ? JSON.parse(readFileSync(TOKEN_PATH, 'utf-8'))
      : {}
    writeFileSync(TOKEN_PATH, JSON.stringify({ ...existing, ...tokens }, null, 2))
  }

  private async runAuthFlow(): Promise<void> {
    const authUrl = this.client.generateAuthUrl({
      access_type: 'offline',
      scope: GOOGLE_SCOPES,
      prompt: 'consent',
    })

    console.log('\nAuthorize Seashell Desk to access Google:')
    console.log(authUrl)
    console.log('\nWaiting for authorization...')

    const code = await this.waitForAuthCode()
    const { tokens } = await this.client.getToken(code)
    this.client.setCredentials(tokens)
    this.saveTokens(tokens as Record<string, unknown>)
    console.log('Authorization complete. Tokens saved to .credentials/')
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

      server.listen(REDIRECT_PORT)
      server.on('error', reject)
    })
  }
}
