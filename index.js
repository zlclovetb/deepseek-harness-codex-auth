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
  selectAccount,
  setPinned,
  warmPool
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
  const proxyUrl = configValue(config, "proxyUrl");
  return {
    accountsDir: configValue(config, "accountsDir"),
    quotaProbe: configValue(config, "quotaProbe") === true,
    // The adapter's per-provider proxy is only visible once it resolves a
    // credential, which is too late for the startup probe. This lets a proxied
    // install name its transport up front; the adapter's value still wins later.
    proxyUrl: typeof proxyUrl === "string" && proxyUrl !== "" ? proxyUrl : undefined,
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
    noteProbeProxy(accounts, proxyUrl);
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

  /**
   * The proxy the current probe pass used. Seeded from the plugin's own
   * `proxyUrl`, because the adapter hands its proxy over only when it resolves a
   * credential — too late for the startup pass. `null` is that direct pass; a
   * later `resolve()` that reveals a different proxy re-probes the accounts the
   * startup pass could not reach.
   */
  let probedProxy = settings.proxyUrl ?? null;

  function noteProbeProxy(accounts, proxyUrl) {
    if (!settings.quotaProbe) return;
    const key = proxyUrl ?? null;
    if (key === probedProxy) return;
    probedProxy = key;
    void probeAll(accounts, proxyUrl).catch(() => {});
  }

  /**
   * Read every account that has no fresh reading, all at once. Detached from the
   * request that triggered it and best-effort per account: an account that cannot
   * be reached, read or refreshed simply stays unmeasured until its own reply is
   * observed.
   */
  async function probeAll(accounts, proxyUrl) {
    const now = Date.now();
    await Promise.all(accounts.map(async (entry) => {
      if (quotaStale(pool, entry.id, PROBE_MAX_AGE_MS, now) === false) return;
      try {
        const { token, auth } = await tokenFor(entry.path, { now, fetchImpl: undefined, proxyUrl });
        await probeAccount(entry, { token, auth, proxyUrl, now });
      } catch {
        // Unreachable, unreadable or unrefreshable: left to the passive path.
      }
    }));
  }

  /**
   * Fill the pool before the first model request.
   *
   * Without this the panel stays blank until someone talks to the model, because
   * `pool.accounts` is only populated while a credential is being resolved.
   * Accounts are listed immediately; their quota is only read up front when
   * `quotaProbe` is on, since that is a real network call per account.
   */
  async function warm() {
    const { accounts } = await discoverAccounts({ accountsDir: settings.accountsDir });
    prunePool(pool, accounts.map((entry) => entry.id));
    warmPool(pool, accounts);
    if (settings.quotaProbe) await probeAll(accounts, settings.proxyUrl);
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
   * Take the choice of account away from the strategy, or give it back.
   *
   * Deliberately not persisted: the pin lives exactly as long as the pool does,
   * which keeps a restart a clean return to automatic selection. A pinned
   * account that is spent or cooling is skipped like any other, and the pin
   * takes over again by itself once its window resets.
   */
  function pin(id) {
    return setPinned(pool, id);
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
    warm,
    pin,
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
  // Fill the pool in the background so the settings panel can list the accounts
  // right after a restart instead of waiting for the first model request.
  void service.warm().catch(() => {});
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

/** A pin request carries one account id, so anything larger is malformed. */
const MAX_PIN_BODY_BYTES = 4 * 1024;

/** Answer with JSON and never let a cached pool reading go stale in a proxy. */
function sendJson(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > MAX_PIN_BODY_BYTES) throw new Error("pin body is too large");
  }
  const trimmed = raw.trim();
  return trimmed === "" ? {} : JSON.parse(trimmed);
}

/**
 * Apply `{ pin: "<id>" | null }` from the settings panel and answer with the
 * pool as it now stands, so the caller can render the result without a second
 * round trip.
 */
async function applyPin(request, response, service) {
  let body;
  try {
    body = await readJsonBody(request);
  } catch {
    return sendJson(response, 400, { error: "invalid JSON body" });
  }
  const requested = body?.pin;
  if (requested !== null && requested !== undefined && (typeof requested !== "string" || requested === "")) {
    return sendJson(response, 400, { error: "pin must be an account id or null" });
  }
  if (typeof requested === "string" && service.pool.accounts.has(requested) === false) {
    return sendJson(response, 404, { error: `unknown account: ${requested}` });
  }
  service.pin(requested ?? undefined);
  return sendJson(response, 200, { ...service.snapshot(), integration: service.integration?.() });
}

/** Serve the pool snapshot as JSON; no secret ever crosses this route. */
function registerQuotaRoute(webServer, service) {
  const snapshotPayload = () => ({ ...service.snapshot(), integration: service.integration?.() });
  return webServer.register({
    kind: "exact",
    path: QUOTA_ROUTE,
    handler: (request, response) => {
      if (request.method === "GET") {
        sendJson(response, 200, snapshotPayload());
        return;
      }
      if (request.method === "POST") {
        // The body arrives asynchronously; a failure here must still produce a
        // reply rather than an unhandled rejection in the host's request loop.
        applyPin(request, response, service).catch(() => {
          if (response.headersSent !== true) sendJson(response, 500, { error: "pin failed" });
        });
        return;
      }
      sendJson(response, 405, { error: "method not allowed" });
    }
  });
}

export { DEFAULT_STRATEGY };