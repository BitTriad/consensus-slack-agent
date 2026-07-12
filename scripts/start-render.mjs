/**
 * Render (free tier) entrypoint. In order:
 *   1. Ensure the ledger directory exists (for the SQLite/JSON fallback path
 *      when MONGODB_URI is unset — the durable store is MongoDB Atlas, which
 *      persists natively across restarts and needs no local disk).
 *   2. Seed from seed/seed-decisions.json — the seed script is idempotent and
 *      skips when the ledger already has rows (run as a child process because
 *      it calls process.exit, and so the ledger module opens its own connection
 *      here and seeds into MongoDB when MONGODB_URI is set).
 *   3. Bind a minimal HTTP health server on $PORT (/healthz -> 200 "ok") —
 *      free web services must bind a port, and an external pinger hits it
 *      every ~10 min to prevent the 15-min idle sleep.
 *   4. Self-ping our own /healthz every 5 minutes via RENDER_EXTERNAL_URL so
 *      Render sees inbound traffic and never idles the instance while this
 *      process is alive. The keepalive.yml GitHub Actions cron is only the
 *      backstop that wakes a slept/restarted instance from the outside.
 *   5. Start the Socket-mode app. Ledger durability now comes from MongoDB
 *      Atlas, so there is no snapshot push/restore and no SIGTERM final flush.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import http from 'node:http';
import { dirname, resolve } from 'node:path';

const dbPath = resolve(process.env.CONSENSUS_DB_PATH || './consensus.db');

// Only needed for the SQLite/JSON fallback; harmless when MongoDB is the store.
mkdirSync(dirname(dbPath), { recursive: true });

execFileSync(process.execPath, [new URL('./seed-ledger.mjs', import.meta.url).pathname], { stdio: 'inherit' });

const port = Number(process.env.PORT) || 10000;
http
  .createServer((req, res) => {
    if (req.url === '/healthz' || req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    } else {
      res.writeHead(404);
      res.end();
    }
  })
  .listen(port, () => console.log(`[health] listening on :${port} (/healthz)`));

const SELF_PING_INTERVAL_MS = 5 * 60 * 1000;
const externalUrl = process.env.RENDER_EXTERNAL_URL;
if (externalUrl) {
  console.log(`[keepalive] self-ping active — ${externalUrl}/healthz every ${SELF_PING_INTERVAL_MS / 60000} min`);
  const pinger = setInterval(async () => {
    try {
      const res = await fetch(`${externalUrl}/healthz`);
      if (!res.ok) console.error(`[keepalive] self-ping -> HTTP ${res.status}`);
    } catch (e) {
      console.error('[keepalive] self-ping failed:', e instanceof Error ? e.message : e);
    }
  }, SELF_PING_INTERVAL_MS);
  pinger.unref();
} else {
  console.log('[keepalive] RENDER_EXTERNAL_URL not set — self-ping inactive (relying on external pings only)');
}

if (process.env.MONGODB_URI) {
  console.log('[ledger] MongoDB durable store configured — data persists across restarts');
} else {
  console.warn('[ledger] MONGODB_URI not set — ledger uses the local SQLite/JSON store and is EPHEMERAL on this host');
}

await import('../app.js');
