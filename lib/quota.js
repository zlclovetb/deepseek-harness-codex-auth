/**
 * Passive quota observation for the Codex backend.
 *
 * The Responses endpoint reports rate-limit usage on every reply, so the pool
 * learns an account's 5-hour and weekly windows without spending a request.
 * Everything here is pure: header in, normalized numbers out.
 */

/** The 5-hour window Codex refreshes on a rolling basis. */
export const PRIMARY_WINDOW = "primary";
/** The weekly window. */
export const SECONDARY_WINDOW = "secondary";

const HEADERS = {
  primaryUsed: "x-codex-primary-used-percent",
  primaryResetAt: "x-codex-primary-reset-at",
  primaryResetAfter: "x-codex-primary-reset-after-seconds",
  primaryWindow: "x-codex-primary-window-minutes",
  secondaryUsed: "x-codex-secondary-used-percent",
  secondaryResetAt: "x-codex-secondary-reset-at",
  secondaryResetAfter: "x-codex-secondary-reset-after-seconds",
  secondaryWindow: "x-codex-secondary-window-minutes"
};

/** Read one header whether the source is a `Headers` object or a plain record. */
export function readHeader(headers, name) {
  if (headers === undefined || headers === null) return undefined;
  if (typeof headers.get === "function") return headers.get(name) ?? undefined;
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name) return headers[key];
  }
  return undefined;
}

function readNumber(headers, name) {
  const raw = readHeader(headers, name);
  if (raw === undefined || raw === null || raw === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Read a reset instant as epoch milliseconds.
 *
 * The backend has shipped this header as an epoch second count and as an ISO
 * timestamp; both are accepted, and `reset-after-seconds` is the fallback when
 * only a relative value is present.
 */
function readResetAt(headers, absoluteName, relativeName, now) {
  const raw = readHeader(headers, absoluteName);
  if (raw !== undefined && raw !== null && raw !== "") {
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric;
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  const after = readNumber(headers, relativeName);
  return after === undefined ? undefined : now + after * 1000;
}

/**
 * Extract the quota view from one response's headers.
 *
 * Absent headers stay `undefined` so a caller can tell "the backend did not
 * report this window" from "the window is empty".
 */
export function parseQuota(headers, now = Date.now()) {
  return {
    observedAt: now,
    primaryUsedPercent: readNumber(headers, HEADERS.primaryUsed),
    primaryResetsAt: readResetAt(headers, HEADERS.primaryResetAt, HEADERS.primaryResetAfter, now),
    primaryWindowMinutes: readNumber(headers, HEADERS.primaryWindow),
    secondaryUsedPercent: readNumber(headers, HEADERS.secondaryUsed),
    secondaryResetsAt: readResetAt(headers, HEADERS.secondaryResetAt, HEADERS.secondaryResetAfter, now),
    secondaryWindowMinutes: readNumber(headers, HEADERS.secondaryWindow)
  };
}

/** Whether a quota view carries any usable number. */
export function hasQuota(quota) {
  return quota !== undefined
    && (quota.primaryUsedPercent !== undefined || quota.secondaryUsedPercent !== undefined);
}

/**
 * Merge a fresh view over the last one, keeping a known value when the newest
 * response simply did not carry that header.
 */
export function mergeQuota(previous, next) {
  if (previous === undefined) return next;
  const merged = { ...previous };
  for (const [key, value] of Object.entries(next)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

/**
 * Drop windows whose reset instant has passed.
 *
 * A window that has rolled over says nothing about the new window until the
 * backend reports it again, so both the utilization and the reset instant go:
 * keeping a zero here would let the panel print a confident "100% remaining"
 * for a window nobody has observed. Rotation is unaffected either way, because
 * an unobserved window counts as untouched.
 */
export function expireWindows(quota, now = Date.now()) {
  if (quota === undefined) return quota;
  const next = { ...quota };
  if (next.primaryResetsAt !== undefined && now >= next.primaryResetsAt) {
    next.primaryUsedPercent = undefined;
    next.primaryResetsAt = undefined;
  }
  if (next.secondaryResetsAt !== undefined && now >= next.secondaryResetsAt) {
    next.secondaryUsedPercent = undefined;
    next.secondaryResetsAt = undefined;
  }
  return next;
}

/** The highest reported utilization, or `undefined` when nothing was reported. */
export function peakUsedPercent(quota) {
  if (quota === undefined) return undefined;
  const values = [quota.primaryUsedPercent, quota.secondaryUsedPercent].filter((value) => value !== undefined);
  return values.length === 0 ? undefined : Math.max(...values);
}

/** Whether every reported window is spent. */
export function isQuotaExhausted(quota) {
  const peak = peakUsedPercent(quota);
  return peak !== undefined && peak >= 100;
}

/**
 * The instant the account becomes usable again — the later of the two windows
 * that are currently full, or `undefined` when none is.
 */
export function quotaRetryAt(quota) {
  if (quota === undefined) return undefined;
  const spent = [];
  if ((quota.primaryUsedPercent ?? 0) >= 100) spent.push(quota.primaryResetsAt);
  if ((quota.secondaryUsedPercent ?? 0) >= 100) spent.push(quota.secondaryResetsAt);
  const known = spent.filter((value) => value !== undefined);
  return known.length === 0 ? undefined : Math.max(...known);
}