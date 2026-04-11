/**
 * auth — re-run the Google OAuth flow.
 *
 * Usage:
 *   bun run auth
 *
 * Deletes any existing token and opens the browser auth flow.
 * Run this when calendar or Gmail tools return invalid_grant.
 */

import { existsSync, unlinkSync } from 'fs'
import path from 'path'
import { GoogleAuth } from './services/google-auth.js'

const TOKEN_PATH = path.join(import.meta.dirname, '..', '.credentials', 'google-token.json')

if (existsSync(TOKEN_PATH)) {
  unlinkSync(TOKEN_PATH)
  console.log('Removed stale token.')
}

console.log('Starting OAuth flow...')
const auth = GoogleAuth.fromEnv()
await auth.ensureAuthenticated()
console.log('Done. Token saved to .credentials/google-token.json')
