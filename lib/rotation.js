import {
  expireWindows,
  isQuotaExhausted,
  mergeQuota,
  parseQuota,
  peakUsedPercent,
  quotaRetryAt
} from "./quota.js";

/** Selection strategies a deployment may pick. */
export const STRATEGIES = ["hybrid", "round-robin", "sticky"];
export const DEFAULT_STRATEGY = "hybrid";
/** How long an account stays out after a 429 that carried no reset instant. */
export const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000;
/** Short quarantine for a transport failure, so one bad hop is skipped, not retired. */
const TRANSPORT_COOLDOWN_MS = 30 * 1000;
/** First wait after a probe that produced no reading; it doubles per further attempt. */
const PROBE_BACKOFF_BASE_MS = 60 * 1000;
/** Retries allowed after the first attempt of a trigger; past that the account goes quiet. */
const PROBE_RETRY_LIMIT = 3;

/** How long to hold the next attempt back after `failures` in a row produced nothing. */
function probeBackoffMs(failures) {
  return PROBE_BACKOFF_BASE_MS * 2 ** (failures - 1);
}

/** Coerce a configured strategy name, defaulting instead of throwing. */
export function normalizeStrategy(value) {
  return STRATEGIES.includes(value) ? value : DEFAULT_STRATEGY;
}

/** Fresh pool state. Process-local by design: quota is observed, not persisted. */
export function createPool({ strategy = DEFAULT_STRATEGY, accountsDir } = {}) {
  return {
    strategy: normalizeStrategy(strategy),
    accountsDir,
    accounts: new Map(),
    tokens: new Map(),
    cursor: 0,
    sticky: undefined,
    pinned: undefined
  };
}

/**
 * Pin the pool to one account, or hand it back to the strategy.
 *
 * The pin is process-local like the rest of the pool state: it steers selection
 * from the next request on and is gone after a restart.
 *
 * @param pool - rotation state.
 * @param id - an account id, or `null`/`undefined` to clear the pin.
 * @returns the pin now in effect.
 */
export function setPinned(pool, id) {
  pool.pinned = typeof id === "string" && id !== "" ? id : undefined;
  return pool.pinned;
}

function entryState(pool, id) {
  let state = pool.accounts.get(id);
  if (state === undefined) {
    state = {
      id,
      quota: undefined,
      cooldownUntil: undefined,
      health: 1,
      successes: 0,
      failures: 0,
      lastUsedAt: undefined
    };
    pool.accounts.set(id, state);
  }
  return state;
}

/** Forget state for accounts that are no longer on disk. */
export function prunePool(pool, ids) {
  const keep = new Set(ids);
  for (const id of [...pool.accounts.keys()]) {
    if (!keep.has(id)) pool.accounts.delete(id);
  }
  if (pool.sticky !== undefined && !keep.has(pool.sticky)) pool.sticky = undefined;
  if (pool.pinned !== undefined && !keep.has(pool.pinned)) pool.pinned = undefined;
}

/**
 * Create the per-account state for everything `discoverAccounts()` found.
 *
 * `pool.accounts` is otherwise only filled while a request resolves its
 * credential, so a freshly started process reports an empty pool and the
 * settings panel has nothing to list until someone talks to the model. This
 * materialises the entries up front. It is not a selection: nothing is marked as
 * used and no quota reading is invented.
 *
 * @param pool - rotation state.
 * @param entries - discovered accounts.
 */
export function warmPool(pool, entries) {
  for (const entry of entries) entryState(pool, entry.id);
}

/** Remember which pool entry an access token was handed out for. */
export function noteToken(pool, token, id) {
  if (typeof token === "string" && token !== "") pool.tokens.set(token, id);
}

/** The pool entry a bearer token belongs to, when it is one this process issued. */
export function accountForToken(pool, token) {
  return pool.tokens.get(token);
}

function windowState(state, now) {
  state.quota = expireWindows(state.quota, now);
  return state;
}

/** Whether an entry can serve a request right now. */
export function isAvailable(state, now) {
  if (state.cooldownUntil !== undefined && now < state.cooldownUntil) return false;
  return !isQuotaExhausted(windowState(state, now).quota);
}

/** Remaining headroom as a percentage; an unobserved account counts as untouched. */
function remainingPercent(state, now) {
  const peak = peakUsedPercent(windowState(state, now).quota);
  return peak === undefined ? 100 : Math.max(0, 100 - peak);
}

/** When a cooling or spent entry becomes usable again. */
export function retryAt(state, now) {
  const quotaAt = quotaRetryAt(windowState(state, now).quota);
  const values = [state.cooldownUntil, quotaAt].filter((value) => value !== undefined && value > now);
  return values.length === 0 ? undefined : Math.max(...values);
}

function hybridOrder(pool, entries, now) {
  return [...entries].sort((left, right) => {
    const a = entryState(pool, left.id);
    const b = entryState(pool, right.id);
    const score = (remainingPercent(b, now) * b.health) - (remainingPercent(a, now) * a.health);
    if (score !== 0) return score;
    return (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0);
  });
}

/**
 * Choose the entry for the next request.
 *
 * A pinned account outranks every strategy, but only while it can actually
 * serve: a spent or cooling pin falls back to the strategy so a manual choice
 * degrades into "as soon as it is usable again" instead of a stream of 429s.
 *
 * Only available entries are considered. When every entry is spent the earliest
 * recovery is returned so the caller can name a real reset instant rather than
 * reporting an empty pool.
 *
 * @param pool - rotation state.
 * @param entries - discovered accounts.
 * @param options.now - current epoch milliseconds.
 * @returns the chosen entry, or `undefined` for an empty pool.
 */
export function selectAccount(pool, entries, { now = Date.now() } = {}) {
  if (entries.length === 0) return undefined;
  const ranked = hybridOrder(pool, entries, now);
  const available = ranked.filter((entry) => isAvailable(entryState(pool, entry.id), now));

  if (pool.pinned !== undefined) {
    const pinned = available.find((entry) => entry.id === pool.pinned);
    if (pinned !== undefined) return pinned;
  }

  if (pool.strategy === "round-robin") {
    const candidates = available.length > 0 ? available : ranked;
    const index = pool.cursor % candidates.length;
    pool.cursor = (index + 1) % candidates.length;
    return candidates[index];
  }
  if (pool.strategy === "sticky") {
    const current = available.find((entry) => entry.id === pool.sticky);
    if (current !== undefined) return current;
    const fallback = available[0] ?? ranked[0];
    pool.sticky = fallback.id;
    return fallback;
  }
  // hybrid: the best available entry, or the first to recover.
  if (available.length > 0) return available[0];
  return [...ranked].sort((left, right) => {
    const a = retryAt(entryState(pool, left.id), now) ?? Number.POSITIVE_INFINITY;
    const b = retryAt(entryState(pool, right.id), now) ?? Number.POSITIVE_INFINITY;
    return a - b;
  })[0];
}

/** Record that an account was handed a request. */
export function markUsed(pool, id, now = Date.now()) {
  const state = entryState(pool, id);
  state.lastUsedAt = now;
  if (pool.strategy === "sticky") pool.sticky = id;
  return state;
}

/** Put an account into cooldown, e.g. after a refresh that could not succeed. */
export function markCooldown(pool, id, until) {
  entryState(pool, id).cooldownUntil = until;
}

/**
 * How long a reading is trusted: the server's own re-subscribe cadence when one
 * came with it, otherwise the caller's freshness bound.
 *
 * A subscription reply names `renewal_seconds`; a plain pull does not, so it
 * keeps the fixed bound and is re-read before it can go noticeably stale.
 */
function leaseOf(quota, fallbackMs) {
  const seconds = quota?.renewalSeconds;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : fallbackMs;
}

/**
 * Whether an account's quota reading is absent or older than its lease.
 *
 * An account that has used up its attempts answers `false` instead: its next
 * reading waits for a new trigger rather than for another turn of the clock, so a
 * claimed credential does not silently restart a cycle that already gave up.
 */
export function quotaStale(pool, id, maxAgeMs, now = Date.now()) {
  const state = entryState(pool, id);
  if (state.probeHalted === true) return false;
  const quota = state.quota;
  const observedAt = quota?.observedAt;
  return observedAt === undefined || now - observedAt > leaseOf(quota, maxAgeMs);
}

/**
 * The instant the pool's earliest reading falls due.
 *
 * One timer drives every account, so a scheduler needs the soonest expiry among
 * them. An account that has never been read is due right now, which is what
 * makes a fresh process probe immediately; an empty pool has nothing to wait for.
 *
 * @param pool - rotation state.
 * @param fallbackMs - freshness bound for readings that carry no lease.
 * @param now - current epoch milliseconds.
 * @returns the earliest due instant, or `undefined` for an empty pool.
 */
export function earliestQuotaDueAt(pool, fallbackMs, now = Date.now()) {
  if (pool.accounts.size === 0) return undefined;
  let dueAt;
  for (const state of pool.accounts.values()) {
    // Out of attempts: nothing is scheduled for it until the next trigger.
    if (state.probeHalted === true) continue;
    const observedAt = state.quota?.observedAt;
    const readingDue = observedAt === undefined ? now : observedAt + leaseOf(state.quota, fallbackMs);
    // A failed probe holds its own account back, so one unreachable account
    // cannot pin the whole pool to the scheduler's floor every minute.
    const due = Math.max(readingDue, state.probeRetryAt ?? 0);
    if (dueAt === undefined || due < dueAt) dueAt = due;
  }
  return dueAt;
}

/** Fold an out-of-band reading (the active probe) into an account's quota. */
export function recordQuota(pool, id, quota, now = Date.now()) {
  if (quota === undefined) return;
  const state = entryState(pool, id);
  state.quota = mergeQuota(expireWindows(state.quota, now), quota);
  if (!isQuotaExhausted(state.quota)) state.cooldownUntil = undefined;
  state.probeFailures = 0;
  state.probeRetryAt = undefined;
  state.probeHalted = undefined;
}

/**
 * Record that a probe produced no reading.
 *
 * Something was unreachable — the account, its token, or the transport — so the
 * next attempt waits twice as long as the last one did. Retries stop altogether
 * once `PROBE_RETRY_LIMIT` of them have failed: an install that cannot reach the
 * network should go quiet instead of asking forever, and `resetProbeAttempts`
 * hands the attempts back when the panel is opened again.
 *
 * This is deliberately not `cooldownUntil`: that also takes the account out of
 * rotation, and a failed probe says nothing about whether it can serve.
 */
export function markProbeFailure(pool, id, now = Date.now()) {
  const state = entryState(pool, id);
  const failures = (state.probeFailures ?? 0) + 1;
  state.probeFailures = failures;
  if (failures > PROBE_RETRY_LIMIT) {
    state.probeRetryAt = undefined;
    state.probeHalted = true;
    return;
  }
  state.probeRetryAt = now + probeBackoffMs(failures);
}

/**
 * Hand every account its attempts back.
 *
 * Attempts are spent, not recurring, so the only thing that starts a new cycle is
 * an explicit trigger — opening the settings panel, which forces a refresh.
 */
export function resetProbeAttempts(pool) {
  for (const state of pool.accounts.values()) {
    state.probeFailures = 0;
    state.probeRetryAt = undefined;
    state.probeHalted = undefined;
  }
}

/**
 * Fold one response into the pool's view of an account.
 *
 * Quota headers are merged in whether or not the request succeeded — a 429 is
 * usually the reply that finally carries them.
 *
 * @param pool - rotation state.
 * @param id - the account the request was sent for.
 * @param result - status, headers, and the observation instant.
 */
export function recordOutcome(pool, id, { status, headers, now = Date.now() } = {}) {
  const state = entryState(pool, id);
  if (headers !== undefined) {
    state.quota = mergeQuota(state.quota, parseQuota(headers, now));
  }
  state.quota = expireWindows(state.quota, now);

  if (status === 429) {
    // A 429 is a quota signal, and the quota window already encodes it: the
    // account is held out until that window resets, with no lasting penalty.
    state.failures += 1;
    state.cooldownUntil = quotaRetryAt(state.quota) ?? now + DEFAULT_COOLDOWN_MS;
  } else if (typeof status === "number" && status >= 500) {
    state.failures += 1;
    state.health = Math.max(0.05, state.health * 0.7);
    state.cooldownUntil = now + TRANSPORT_COOLDOWN_MS;
  } else if (typeof status === "number" && status >= 200 && status < 400) {
    state.successes += 1;
    state.health = Math.min(1, state.health + 0.2);
    if (!isQuotaExhausted(state.quota)) state.cooldownUntil = undefined;
  }
  // Any reply proves the account was reachable, whatever it said about quota.
  state.probeFailures = 0;
  state.probeRetryAt = undefined;
  state.probeHalted = undefined;
  return state;
}

/** A serializable view of the pool for diagnostics and the settings snapshot. */
export function poolSnapshot(pool, now = Date.now()) {
  const accounts = [...pool.accounts.values()].map((state) => {
    const quota = expireWindows(state.quota, now);
    return {
      id: state.id,
      usedPercent5h: quota?.primaryUsedPercent,
      resetsAt5h: quota?.primaryResetsAt,
      usedPercentWeekly: quota?.secondaryUsedPercent,
      resetsAtWeekly: quota?.secondaryResetsAt,
      health: Number(state.health.toFixed(3)),
      cooldownUntil: state.cooldownUntil !== undefined && state.cooldownUntil > now ? state.cooldownUntil : undefined,
      lastUsedAt: state.lastUsedAt,
      available: isAvailable(state, now)
    };
  });
  return { strategy: pool.strategy, accountsDir: pool.accountsDir, pinned: pool.pinned, accounts, observedAt: now };
}