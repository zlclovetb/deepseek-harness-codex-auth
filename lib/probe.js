import { hasQuota } from "./quota.js";

/**
 * Active quota probe — the opt-in fallback for the passive header path.
 *
 * The Responses endpoint reports quota on every reply, so this module exists
 * only for deployments that want an account's headroom before the first
 * request lands on it. It is strictly best-effort: any failure, unknown
 * payload, or missing field returns `undefined` and rotation falls back to the
 * headers it already observes.
 */

/** ChatGPT's usage endpoint: reports windows without invoking a model. */
export const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
/** The subscription endpoint, whose reply also names when to ask again. */
export const SUBSCRIPTIONS_URL = "https://chatgpt.com/backend-api/wham/usage/subscriptions";

/** Headers the desktop app sends so the subscription payload is served. */
const SUBSCRIPTION_HEADERS = {
  accept: "application/json",
  "OAI-App-Brand": "codex",
  "x-openai-codex-pricing-chooser": "1"
};

function numbers(source, names) {
  for (const name of names) {
    const value = source?.[name];
    const numeric = typeof value === "string" ? Number(value) : value;
    if (typeof numeric === "number" && Number.isFinite(numeric)) return numeric;
  }
  return undefined;
}

function resetAt(window, now) {
  const absolute = numbers(window, ["reset_at", "resets_at", "resetAt"]);
  if (absolute !== undefined) return absolute < 1e12 ? absolute * 1000 : absolute;
  const after = numbers(window, ["reset_after_seconds", "resetAfterSeconds"]);
  return after === undefined ? undefined : now + after * 1000;
}

function windowQuota(window, now) {
  const usedPercent = numbers(window, ["used_percent", "usedPercent"]);
  if (usedPercent === undefined) return undefined;
  return {
    usedPercent,
    resetsAt: resetAt(window, now),
    windowSeconds: numbers(window, ["limit_window_seconds", "window_seconds", "windowSeconds"])
  };
}

/** Every object nested anywhere in the payload that reports a `used_percent`. */
function collectWindows(value, now, found = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectWindows(item, now, found);
  } else if (value !== null && typeof value === "object") {
    const quota = windowQuota(value, now);
    if (quota !== undefined) found.push(quota);
    for (const nested of Object.values(value)) collectWindows(nested, now, found);
  }
  return found;
}

/** At or under this declared length, a window is the rolling 5-hour limit. */
const SHORT_WINDOW_SECONDS = 18_000;

/**
 * Match the collected windows to the 5-hour and weekly slots.
 *
 * The payload's names are positional, not descriptive: an account whose 5-hour
 * window is not currently running reports its weekly one as `primary_window`
 * and sends `secondary_window: null`. Trusting the name would then display a
 * weekly reading as the 5-hour one, so the declared length is what decides.
 *
 * A window that declares no length at all has nothing to match on, and only
 * then does the old shortest-first ranking apply.
 */
function classifyWindows(windows) {
  const byLength = [...windows].sort((left, right) => (left.windowSeconds ?? 0) - (right.windowSeconds ?? 0));
  const short = byLength.find((window) => window.windowSeconds !== undefined && window.windowSeconds <= SHORT_WINDOW_SECONDS);
  const long = byLength.find((window) => window.windowSeconds !== undefined && window.windowSeconds > SHORT_WINDOW_SECONDS);
  if (short === undefined && long === undefined) {
    return { primary: byLength[0], secondary: byLength.find((window) => window !== byLength[0]) };
  }
  return {
    primary: short ?? byLength.find((window) => window !== long),
    secondary: long ?? byLength.find((window) => window !== short)
  };
}

/**
 * Normalize a usage payload into the same shape {@link parseQuota} produces.
 *
 * Either slot may be empty: an account with no active 5-hour window yields a
 * weekly reading and an `undefined` primary, which the panel shows as "no data"
 * for the one window rather than borrowing the other one's numbers.
 *
 * @param payload - the decoded JSON body.
 * @param now - observation instant in epoch milliseconds.
 * @returns the quota view, or `undefined` when the payload carried no windows.
 */
export function parseUsage(payload, now = Date.now()) {
  const windows = collectWindows(payload, now);
  if (windows.length === 0) return undefined;
  const { primary, secondary } = classifyWindows(windows);
  return {
    observedAt: now,
    source: "probe",
    primaryUsedPercent: primary?.usedPercent,
    primaryResetsAt: primary?.resetsAt,
    primaryWindowMinutes: primary?.windowSeconds === undefined ? undefined : primary.windowSeconds / 60,
    secondaryUsedPercent: secondary?.usedPercent,
    secondaryResetsAt: secondary?.resetsAt,
    secondaryWindowMinutes: secondary?.windowSeconds === undefined ? undefined : secondary.windowSeconds / 60
  };
}

/**
 * Ask the usage endpoint for one account's windows.
 *
 * A 401 is the one retry worth making, and only when the caller can mint a
 * fresher token; every other status is reported as "no reading".
 *
 * @param options.token - the account's current access token.
 * @param options.accountId - the ChatGPT account id, sent as its own header.
 * @param options.fetchImpl - transport to use, so the caller's proxy applies.
 * @param options.refresh - returns a fresh token for one retry, or `undefined` to skip it.
 * @returns the quota view, or `undefined` when nothing usable came back.
 */
export async function probeQuota({ token, accountId, fetchImpl, refresh, url = USAGE_URL, now = Date.now() } = {}) {
  const request = async (bearer) => fetchImpl(url, {
    method: "GET",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${bearer}`,
      ...accountId === undefined ? {} : { "chatgpt-account-id": accountId }
    },
    signal: AbortSignal.timeout(15_000)
  });

  try {
    let response = await request(token);
    if (response.status === 401 && typeof refresh === "function") {
      const fresh = await refresh();
      if (typeof fresh === "string" && fresh !== token) response = await request(fresh);
    }
    if (!response.ok) return undefined;
    return parseUsage(await response.json(), now);
  } catch {
    return undefined;
  }
}

/**
 * Subscribe one account's windows, the way the desktop app does.
 *
 * The reply is the same snapshot shape as {@link probeQuota}'s, plus
 * `renewal_seconds`: the server's own answer to "come back in this many
 * seconds". Carrying it on the view is what lets rotation accept the server's
 * cadence instead of guessing one.
 *
 * @param options.token - the account's current access token.
 * @param options.accountId - the ChatGPT account id, sent as its own header.
 * @param options.fetchImpl - transport to use, so the caller's proxy applies.
 * @param options.refresh - returns a fresh token for one retry, or `undefined` to skip it.
 * @returns the quota view with `renewalSeconds` attached, or `undefined`.
 */
export async function probeSubscriptions({ token, accountId, fetchImpl, refresh, url = SUBSCRIPTIONS_URL, now = Date.now() } = {}) {
  const request = async (bearer) => fetchImpl(url, {
    method: "POST",
    headers: {
      ...SUBSCRIPTION_HEADERS,
      authorization: `Bearer ${bearer}`,
      ...accountId === undefined ? {} : { "chatgpt-account-id": accountId }
    },
    signal: AbortSignal.timeout(15_000)
  });

  try {
    let response = await request(token);
    if (response.status === 401 && typeof refresh === "function") {
      const fresh = await refresh();
      if (typeof fresh === "string" && fresh !== token) response = await request(fresh);
    }
    if (!response.ok) return undefined;
    const payload = await response.json();
    const quota = parseUsage(payload, now);
    if (hasQuota(quota) === false) return undefined;
    const renewalSeconds = numbers(payload, ["renewal_seconds", "renewalSeconds"]);
    // A cadence is only worth carrying when it is a real positive duration: a
    // zero or negative value would schedule a pass that never waits.
    if (renewalSeconds !== undefined && renewalSeconds > 0) quota.renewalSeconds = renewalSeconds;
    return quota;
  } catch {
    return undefined;
  }
}

/**
 * Read one account's windows, preferring the subscription endpoint.
 *
 * The subscription carries the server's cadence, so it is tried first; the
 * plain pull only answers with numbers. A pull reading deliberately carries no
 * `renewalSeconds`, which leaves the scheduler on the caller's freshness bound.
 *
 * @returns the quota view, or `undefined` when neither path produced one.
 */
export async function readQuota(options = {}) {
  const subscribed = await probeSubscriptions(options);
  if (subscribed !== undefined) return subscribed;
  return probeQuota(options);
}