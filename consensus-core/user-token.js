/**
 * Fallback user-token lookup for Real-Time Search.
 *
 * When the app runs in Socket Mode via `slack run`, Bolt's `context.userToken`
 * is not populated. If a user has completed the OAuth flow (app-oauth.js), the
 * FileInstallationStore holds their xoxp token with the `search:read.*`
 * scopes. This helper reads the stored installation belonging to exactly that
 * user so RTS keeps working in Socket Mode.
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const BASE_DIR = './data/installations';

/** @type {Map<string, string|null>} */
const cache = new Map();

/**
 * Get the stored user token belonging to exactly `userId`. Returns that user's
 * own xoxp token, or null if that user has no stored installation. Never falls
 * back to another user's token, and never throws.
 * @param {string} [userId]
 * @returns {string|null}
 */
export function getStoredUserToken(userId) {
  if (!userId) return null;
  if (cache.has(userId)) return cache.get(userId) ?? null;

  const fileName = `user-${userId}-latest`;
  let token = null;
  try {
    for (const org of readdirSync(BASE_DIR)) {
      const dir = path.join(BASE_DIR, org);
      const files = readdirSync(dir);
      if (!files.includes(fileName)) continue;
      try {
        const installation = JSON.parse(readFileSync(path.join(dir, fileName), 'utf-8'));
        const t = installation?.user?.token;
        if (typeof t === 'string' && t.startsWith('xoxp-')) {
          token = t;
          break;
        }
      } catch {
        // unreadable installation file — try the next org
      }
    }
  } catch {
    // no installation store yet — RTS simply stays dormant
  }
  cache.set(userId, token);
  return token;
}
