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
    sticky: undefined
  };
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

/** Whether an account's quota reading is absent or older than `maxAgeMs`. */
export function quotaStale(pool, id, maxAgeMs, now = Date.now()) {
  const observedAt = entryState(pool, id).quota?.observedAt;
  return observedAt === undefined || now - observedAt > maxAgeMs;
}

/** Fold an out-of-band reading (the active probe) into an account's quota. */
export function recordQuota(pool, id, quota, now = Date.now()) {
  if (quota === undefined) return;
  const state = entryState(pool, id);
  state.quota = mergeQuota(expireWindows(state.quota, now), quota);
  if (!isQuotaExhausted(state.quota)) state.cooldownUntil = undefined;
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
  return { strategy: pool.strategy, accountsDir: pool.accountsDir, accounts, observedAt: now };
}