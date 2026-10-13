import { join } from "node:path";
import { ProxyAgent, fetch as undiciFetch } from "undici";

import {
  accountIdentity,
  codexHome,
  discoverAccounts,
  expiresAt,
  legacyAuthPath,
  readAccountAuth,
  writeAccountAuth
} from "./lib/accounts.js";
import {
  DEFAULT_STRATEGY,
  accountForToken,
  createPool,
  markCooldown,
  markUsed,
  normalizeStrategy,
  noteToken,
  poolSnapshot,
  prunePool,
  quotaStale,
  recordOutcome,
  recordQuota,
  selectAccount
} from "./lib/rotation.js";
import { probeQuota } from "./lib/probe.js";

export const name = "codex-cli-auth";
export const inject = ["credentials"];
export const CODEX_CREDENTIAL_REF = "OPENAI_CODEX_AUTH";
/** The service the patched llm-pi-ai adapter looks up to observe quota passively. */
export const ROTATION_SERVICE = "codexMultiAuth";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const REFRESH_URL = "https://auth.openai.com/oauth/token";
const REFRESH_WINDOW_MS = 5 * 60 * 1000;
/** How long an active probe's reading is trusted before another one is worth spending. */
const PROBE_MAX_AGE_MS = 10 * 60 * 1000;
/** One in-flight refresh per auth file, so concurrent requests share the rotation. */
const refreshInflight = new Map();

function authPath(env = process.env) {
  return legacyAuthPath(env);
}

/** Read a config field whether the loader handed back a plain value or a reactive cell. */
function configValue(config, key) {
  const value = config?.[key];
  return value !== null && typeof value === "object" && typeof value.get === "function" ? value.get() : value;
}

function readSettings(config) {
  const rotate = configValue(config, "rotateOnQuotaExhausted") !== false;
  return {
    accountsDir: configValue(config, "accountsDir"),
    quotaProbe: configValue(config, "quotaProbe") === true,
    rotateOnQuotaExhausted: rotate,
    // Staying on one account is exactly the sticky strategy.
    strategy: rotate ? normalizeStrategy(configValue(config, "strategy")) : "sticky"
  };
}

async function refresh(path, auth, fetchImpl) {
  const usedRefreshToken = auth.tokens.refresh_token;
  const response = await fetchImpl(process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE || REFRESH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.CODEX_APP_SERVER_LOGIN_CLIENT_ID || CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: usedRefreshToken
    }),
    signal: AbortSignal.timeout(30_000)
  });

  if (!response.ok) {
    const latest = await readAccountAuth(path);
    if (latest.tokens.refresh_token !== usedRefreshToken) return latest.tokens.access_token;
    throw new Error(`Codex CLI token refresh failed (HTTP ${response.status}); run "codex login" again`);
  }

  const tokens = await response.json();
  if (typeof tokens?.access_token !== "string") {
    throw new Error("Codex CLI token refresh returned no access token");
  }

  const latest = await readAccountAuth(path);
  if (latest.tokens.refresh_token !== usedRefreshToken) return latest.tokens.access_token;
  latest.tokens.access_token = tokens.access_token;
  if (typeof tokens.refresh_token === "string") latest.tokens.refresh_token = tokens.refresh_token;
  latest.last_refresh = new Date().toISOString();
  await writeAccountAuth(path, latest);
  return tokens.access_token;
}

function requesterFor(fetchImpl, proxyUrl) {
  if (fetchImpl) return { request: fetchImpl, close: undefined };
  if (!proxyUrl) return { request: globalThis.fetch, close: undefined };
  const dispatcher = new ProxyAgent(proxyUrl);
  return {
    request: (input, init) => undiciFetch(input, { ...init, dispatcher }),
    close: () => dispatcher.close()
  };
}

/** One auth file's live access token, refreshing under a per-file single flight. */
async function tokenFor(path, { now = Date.now(), fetchImpl, proxyUrl } = {}) {
  const auth = await readAccountAuth(path);
  if (expiresAt(auth.tokens.access_token) > now + REFRESH_WINDOW_MS) {
    return { token: auth.tokens.access_token, auth };
  }
  let pending = refreshInflight.get(path);
  if (pending === undefined) {
    const { request, close } = requesterFor(fetchImpl, proxyUrl);
    pending = refresh(path, auth, request).finally(async () => {
      refreshInflight.delete(path);
      await close?.();
    });
    refreshInflight.set(path, pending);
  }
  return { token: await pending, auth };
}

/**
 * Resolve one explicit auth file — the pre-pool contract, kept verbatim for
 * direct callers and for a deployment that points at a single login.
 */
export async function resolveCodexCredential({
  path = authPath(),
  now = Date.now(),
  fetchImpl,
  proxyUrl
} = {}) {
  const { token } = await tokenFor(path, { now, fetchImpl, proxyUrl });
  return token;
}

/** Pull the bearer token out of a fetch `init`, whatever shape its headers have. */
function bearerFrom(init) {
  const headers = init?.headers;
  if (headers === undefined || headers === null) return undefined;
  let raw;
  if (typeof headers.get === "function") raw = headers.get("authorization");
  else if (Array.isArray(headers)) raw = headers.find(([key]) => String(key).toLowerCase() === "authorization")?.[1];
  else {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === "authorization") raw = headers[key];
    }
  }
  return typeof raw === "string" ? /^Bearer\s+(.+)$/i.exec(raw.trim())?.[1] : undefined;
}

/**
 * The pool-facing credential source plus the observation hook the patched
 * adapter calls. Bookkeeping is failure-isolated throughout: attribution must
 * never turn a working request into a failed one.
 */
function createService({ settings, pool }) {
  /**
   * Whether the installed `dsh-llm-pi-ai` really routes through this service.
   *
   * An empty quota panel has two very different causes — no request has been made
   * yet, or the adapter never reached the observation hook because the patch was
   * not applied. `hooked` is set by `wrapFetch` itself, so it is proof the whole
   * chain works; `stockAdapter` is the opposite proof, taken from the credential
   * call the unpatched adapter makes.
   */
  const integration = { hooked: false, stockAdapter: false };
  async function resolve({ proxyUrl, now = Date.now() } = {}) {
    const { accounts } = await discoverAccounts({ accountsDir: settings.accountsDir });
    prunePool(pool, accounts.map((entry) => entry.id));
    const tried = new Set();
    let lastError;
    while (tried.size < accounts.length) {
      const remaining = accounts.filter((entry) => !tried.has(entry.id));
      const entry = remaining.length === 1 ? remaining[0] : selectAccount(pool, remaining, { now });
      if (entry === undefined) break;
      tried.add(entry.id);
      try {
        return await claim(entry, { now, proxyUrl, poolSize: accounts.length });
      } catch (error) {
        // An unreadable or unrefreshable login is a member to skip, not a fatal error.
        lastError = error;
        markCooldown(pool, entry.id, now + 30_000);
      }
    }
    throw lastError ?? new Error(`Codex CLI pool at ${settings.accountsDir ?? join(codexHome(), "accounts")} has no usable login; run "codex login" for an account`);
  }

  async function claim(entry, { now, proxyUrl, poolSize }) {
    const { token, auth } = await tokenFor(entry.path, { now, fetchImpl: undefined, proxyUrl });
    // Selecting before refreshing is what makes the next request switch: a quota
    // header observed on this reply steers the following selection.
    noteToken(pool, token, entry.id);
    markUsed(pool, entry.id, now);
    if (settings.quotaProbe && quotaStale(pool, entry.id, PROBE_MAX_AGE_MS, now)) {
      void probeAccount(entry, { token, auth, proxyUrl, now });
    }
    return { token, accountId: entry.id, identity: accountIdentity(auth), accounts: poolSize };
  }

  /**
   * Refresh one account's windows out of band. Detached on purpose: the request
   * this account is about to serve must not wait on a quota lookup.
   */
  async function probeAccount(entry, { token, auth, proxyUrl, now }) {
    const { request, close } = requesterFor(undefined, proxyUrl);
    try {
      const quota = await probeQuota({
        token,
        accountId: accountIdentity(auth),
        fetchImpl: request,
        refresh: () => refresh(entry.path, auth, request),
        now
      });
      recordQuota(pool, entry.id, quota, now);
    } catch {
      // A probe that cannot answer leaves the passive header path in charge.
    } finally {
      await close?.();
    }
  }

  /** Attribute one already-sent response to its account. */
  function observe({ token, authorization, status, headers, now = Date.now() } = {}) {
    try {
      const bearer = token ?? (typeof authorization === "string" ? bearerFrom({ headers: { authorization } }) : undefined);
      const id = bearer === undefined ? undefined : accountForToken(pool, bearer);
      if (id !== undefined) recordOutcome(pool, id, { status, headers, now });
    } catch {
      // Observation is best-effort.
    }
  }

  /**
   * Record the shape of the credential call, which is where an unpatched
   * `dsh-llm-pi-ai` gives itself away: the stock adapter resolves the key with no
   * options, while the patched one always passes its profile's transport options.
   * Capturing the negative case is what lets the panel report a missing patch
   * instead of an unexplained blank.
   */
  function noteAdapterRequest(withOptions) {
    if (!withOptions) integration.stockAdapter = true;
  }

  /**
   * Wrap a fetch so its reply feeds the pool. The inner transport is supplied by
   * the caller, so this layer never changes how a request reaches the network —
   * the proxy decision stays entirely with the caller.
   */
  function wrapFetch(baseFetch) {
    // Identical to today when neither a proxy nor an observer is in play.
    const inner = baseFetch ?? globalThis.fetch;
    return async (input, init) => {
      // Reaching this line means the patch is live: the adapter asked this
      // service for the very transport it is about to use.
      integration.hooked = true;
      const token = bearerFrom(init);
      const response = await inner(input, init);
      observe({ token, status: response.status, headers: response.headers });
      return response;
    };
  }

  return {
    strategy: pool.strategy,
    accountsDir: settings.accountsDir,
    quotaProbe: settings.quotaProbe,
    resolve,
    observe,
    wrapFetch,
    snapshot: (now = Date.now()) => poolSnapshot(pool, now),
    integration: () => ({ ...integration }),
    noteAdapterRequest,
    pool
  };
}

/** Whether any discovered login is readable. */
async function anyConfigured(accountsDir, env = process.env) {
  const { accounts } = await discoverAccounts({ accountsDir, env });
  for (const entry of accounts) {
    try {
      await readAccountAuth(entry.path);
      return true;
    } catch {
      // Try the next account.
    }
  }
  return false;
}

export function apply(ctx, config) {
  const settings = readSettings(config);
  const pool = createPool({ strategy: settings.strategy, accountsDir: settings.accountsDir });
  const service = createService({ settings, pool });
  const credentials = ctx.get("credentials");
  const originalResolve = credentials.resolve;
  const originalDescribe = credentials.describe;

  async function resolve(ref, options) {
    if (String(ref) !== CODEX_CREDENTIAL_REF) return originalResolve.call(credentials, ref, options);
    service.noteAdapterRequest(options !== undefined);
    const hit = await service.resolve({ proxyUrl: options?.proxyUrl });
    return { value: hit.token, source: "codex-cli" };
  }
  async function describe(ref) {
    if (String(ref) !== CODEX_CREDENTIAL_REF) return originalDescribe.call(credentials, ref);
    try {
      const configured = await anyConfigured(settings.accountsDir);
      return configured ? { configured: true, source: "codex-cli", writable: false } : { configured: false, writable: false };
    } catch {
      return { configured: false, writable: false };
    }
  }

  credentials.resolve = resolve;
  credentials.describe = describe;
  const provided = typeof ctx.provide === "function" ? ctx.provide(ROTATION_SERVICE, service) : undefined;
  // The Web UI reads the pool over the same origin it is served from. Absent in
  // headless compositions, where the scoped injection simply never runs.
  const injected = typeof ctx.inject === "function" ? ctx.inject(["webServer"], (web) => registerQuotaRoute(web.webServer, service)) : undefined;
  return () => {
    injected?.();
    provided?.();
    if (credentials.resolve === resolve) credentials.resolve = originalResolve;
    if (credentials.describe === describe) credentials.describe = originalDescribe;
  };
}

/** The exact path the settings card polls for live pool state. */
export const QUOTA_ROUTE = "/api/codex-pool";

/** Serve the pool snapshot as JSON; no secret ever crosses this route. */
function registerQuotaRoute(webServer, service) {
  return webServer.register({
    kind: "exact",
    path: QUOTA_ROUTE,
    handler: (request, response) => {
      const payload = JSON.stringify(request.method === "GET"
        ? { ...service.snapshot(), integration: service.integration?.() }
        : { error: "method not allowed" });
      response.writeHead(request.method === "GET" ? 200 : 405, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      });
      response.end(payload);
    }
  });
}

export { DEFAULT_STRATEGY };