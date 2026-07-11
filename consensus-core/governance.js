/**
 * Governance — the trusted-channel / authority model and the decision-lifecycle
 * predicates that gate ENFORCEMENT (hard contradiction alerts).
 *
 * Phase 1 is config-driven with NO admin UI. Three env vars shape behavior:
 *   - CONSENSUS_TRUSTED_CHANNELS: comma-separated channel IDs whose captures
 *     become `active` (enforceable) immediately. Captures from ANY other channel
 *     become `proposed` (surfaced but NOT enforced).
 *   - CONSENSUS_AUTHORITY_USERS: comma-separated user IDs allowed to
 *     Confirm / Reject / Mark-exception / Supersede a decision into (or out of)
 *     an enforceable state.
 *   - CONSENSUS_GOVERNANCE_STRICT: a production kill-switch for the demo-friendly
 *     "unset means wide-open" fallbacks below. Default false.
 *
 * The unset-fallbacks preserve today's DEMO behavior, which is convenient but a
 * dangerous production default — so each is gated by CONSENSUS_GOVERNANCE_STRICT:
 *   - CONSENSUS_TRUSTED_CHANNELS unset ENTIRELY:
 *       · strict=false (default) → EVERY channel is trusted, so ambient capture
 *         still yields `active` decisions like the pre-governance build.
 *       · strict=true → NO channel is trusted; every capture is `proposed` until
 *         a channel is explicitly listed. Set-but-empty ("") is always a lockdown
 *         (no channel trusted) regardless of strict.
 *   - CONSENSUS_AUTHORITY_USERS unset OR empty:
 *       · strict=false (default) → EVERYONE is authorized, so the existing
 *         one-click demo flows keep working.
 *       · strict=true → NO ONE can confirm until a user is explicitly listed.
 *
 * Every predicate here is PURE: it takes an explicit `env` (defaulting to
 * process.env) and returns a boolean/string with no I/O, so the whole state
 * machine is unit-testable without Slack or a live ledger. The strict flag is
 * read from that same injectable `env`, so strict-vs-lenient behavior is testable
 * without touching the real process environment.
 *
 * @typedef {import('./ledger.js').Decision} Decision
 */

/**
 * Parse a comma-separated env value into a Set of trimmed, non-empty tokens.
 * @param {string | undefined | null} raw
 * @returns {Set<string>}
 */
export function parseIdList(raw) {
  return new Set(
    String(raw ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

/**
 * Whether governance strict mode is on. Strict mode removes the demo-friendly
 * "unset means wide-open" fallbacks so an unconfigured production deploy fails
 * CLOSED (nothing trusted, no one authorized) instead of open. Accepts the usual
 * truthy spellings ("1", "true", "yes", "on", case-insensitive); anything else —
 * including unset — is false (lenient/demo default). Pure over the injected env.
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function isStrict(env = process.env) {
  const raw = String(env.CONSENSUS_GOVERNANCE_STRICT ?? '')
    .trim()
    .toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/**
 * Whether captures from `channelId` should become enforceable (`active`)
 * immediately. When CONSENSUS_TRUSTED_CHANNELS is unset ENTIRELY the behavior
 * depends on strict mode: lenient (default) trusts EVERY channel (demo fallback),
 * strict trusts NONE. When the var is set (even to ""), only the listed channels
 * are trusted — an explicit "" locks everything down to `proposed` in either mode.
 * @param {string | null | undefined} channelId
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function isTrustedChannel(channelId, env = process.env) {
  const raw = env.CONSENSUS_TRUSTED_CHANNELS;
  // Unset entirely → lenient trusts all channels (keeps ambient capture working);
  // strict trusts none (fail closed until a channel is explicitly listed).
  if (raw === undefined) return !isStrict(env);
  if (!channelId) return false;
  return parseIdList(raw).has(channelId);
}

/**
 * The capture status a new decision should get, given its channel: trusted
 * channels yield `active` (enforceable); every other channel yields `proposed`
 * (stored + shown, never hard-alerted).
 * @param {string | null | undefined} channelId
 * @param {Record<string, string | undefined>} [env]
 * @returns {'active' | 'proposed'}
 */
export function captureStatusForChannel(channelId, env = process.env) {
  return isTrustedChannel(channelId, env) ? 'active' : 'proposed';
}

/**
 * Whether `userId` may transition a decision into/out of an enforceable state
 * (Confirm / Reject / Mark-exception / Supersede). When CONSENSUS_AUTHORITY_USERS
 * is unset or empty the behavior depends on strict mode: lenient (default)
 * authorizes EVERYONE (demo fallback), strict authorizes NO ONE (fail closed
 * until a user is explicitly listed). When the list is non-empty, only the listed
 * user IDs are authorized in either mode.
 * @param {string | null | undefined} userId
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function canConfirm(userId, env = process.env) {
  const list = parseIdList(env.CONSENSUS_AUTHORITY_USERS);
  // Unset/empty → lenient authorizes all users (demo fallback); strict authorizes
  // no one (fail closed until an authority user is explicitly configured).
  if (list.size === 0) return !isStrict(env);
  if (!userId) return false;
  return list.has(userId);
}

/** Statuses that enforce (hard-alert) when not expired. */
const ENFORCEABLE_STATUSES = new Set(['active', 'confirmed']);

/**
 * Is this decision a genuinely enforceable standing rule RIGHT NOW? True only
 * when its status is `active` or `confirmed` (confirmed = explicit-approval
 * flavor, active = ambient-in-trusted-channel flavor — equivalent for
 * enforcement) AND it has not passed its `expires_at`. `proposed`, `exception`,
 * `superseded`, `expired`, and `rejected` decisions are never enforceable.
 *
 * Pure: `now` is injected so expiry is testable deterministically.
 * @param {Pick<Decision, 'status' | 'expires_at'> | null | undefined} decision
 * @param {number} [now] epoch ms
 * @returns {boolean}
 */
export function isEnforceable(decision, now = Date.now()) {
  if (!decision) return false;
  if (!ENFORCEABLE_STATUSES.has(decision.status)) return false;
  return !isExpired(decision, now);
}

/**
 * Whether a decision has a concrete `expires_at` that is at/before `now`. A null
 * or unparseable expiry never expires.
 * @param {Pick<Decision, 'expires_at'> | null | undefined} decision
 * @param {number} [now] epoch ms
 * @returns {boolean}
 */
export function isExpired(decision, now = Date.now()) {
  const raw = decision?.expires_at;
  if (!raw) return false;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return false;
  return ms <= now;
}

/**
 * Map a legacy ledger status to the Phase-1 lifecycle vocabulary. Only the two
 * renamed legacy values move: `dismissed`→`rejected`. `active` and `superseded`
 * (and any already-new status) pass through unchanged. Idempotent.
 * @param {string | null | undefined} status
 * @returns {Decision['status']}
 */
export function mapLegacyStatus(status) {
  if (status === 'dismissed') return 'rejected';
  return /** @type {Decision['status']} */ (status ?? 'active');
}

/**
 * Whether an `exception` decision narrows the scope of a `parent` standing
 * decision (i.e. carves a legitimate hole in it rather than contradicting it).
 *
 * Phase 1 STATUS — honest stub. Real scope-narrowing needs a semantic comparison
 * of each decision's `applies_to` scope note (e.g. "EU tenants" ⊂ "all tenants"),
 * which Phase 1 does not model. Today an exception is a self-contained carve-out
 * with `exception_of === null` (see consensus-actions.handleMarkException), so
 * there is no linked parent to compare against and this helper conservatively
 * returns `false` for every pair. It exists so the CONCEPT is present, exported,
 * and unit-testable, and so a Phase-2 caller has a single seam to implement.
 *
 * PHASE-2 TODO: once an exception can reference a distinct parent policy via
 * `exception_of`, implement the real predicate here — return true only when
 * `exception.exception_of === parent.id` AND `exception.applies_to` denotes a
 * strict sub-scope of `parent.applies_to` (LLM- or rule-assisted). Until then the
 * conservative default keeps enforcement decisions honest: nothing is silently
 * treated as an in-scope carve-out.
 * @param {Pick<Decision, 'status' | 'exception_of' | 'applies_to'> | null | undefined} exception
 * @param {Pick<Decision, 'id' | 'applies_to'> | null | undefined} parent
 * @returns {boolean}
 */
export function narrowsScope(exception, parent) {
  // Conservative Phase-1 default — see JSDoc. No claimed behavior beyond this.
  void exception;
  void parent;
  return false;
}

/**
 * Pure maintenance helper: given a batch of decisions and a clock, return the ids
 * of those whose `expires_at` has passed but whose status is still enforceable
 * (`active` or `confirmed`) — i.e. the rows a scheduled sweep would flip to the
 * literal `expired` status. Decisions already in a terminal/non-enforcing status
 * (proposed/exception/superseded/expired/rejected) are never returned, so calling
 * this repeatedly converges (a second pass over the same rows, post-flip, returns
 * nothing).
 *
 * This function performs NO I/O and mutates nothing; it only computes the id set.
 * PHASE-2 TODO: a scheduled job (not wired in Phase 1) will call this and then
 * `setDecisionStatus(id, 'expired')` for each returned id, so the ledger reflects
 * expiry as durable state rather than only computing it on read via {@link isExpired}.
 * @param {Array<Pick<Decision, 'id' | 'status' | 'expires_at'>>} decisions
 * @param {number} [now] epoch ms
 * @returns {string[]} ids to materialize as `expired`
 */
export function materializeExpired(decisions, now = Date.now()) {
  if (!Array.isArray(decisions)) return [];
  const ids = [];
  for (const d of decisions) {
    if (!d) continue;
    if (!ENFORCEABLE_STATUSES.has(d.status)) continue;
    if (isExpired(d, now)) ids.push(d.id);
  }
  return ids;
}
