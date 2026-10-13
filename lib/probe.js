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

/**
 * Normalize a usage payload into the same shape {@link parseQuota} produces.
 *
 * Windows are ordered by length so the shorter one is the rolling 5-hour limit
 * and the longer is the weekly one, whatever the payload happens to call them.
 *
 * @param payload - the decoded JSON body.
 * @param now - observation instant in epoch milliseconds.
 * @returns the quota view, or `undefined` when the payload carried no windows.
 */
export function parseUsage(payload, now = Date.now()) {
  const windows = collectWindows(payload, now);
  if (windows.length === 0) return undefined;
  const ordered = [...windows].sort((left, right) => (left.windowSeconds ?? 0) - (right.windowSeconds ?? 0));
  const primary = ordered[0];
  const secondary = ordered.find((window) => window !== primary);
  return {
    observedAt: now,
    source: "probe",
    primaryUsedPercent: primary.usedPercent,
    primaryResetsAt: primary.resetsAt,
    primaryWindowMinutes: primary.windowSeconds === undefined ? undefined : primary.windowSeconds / 60,
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