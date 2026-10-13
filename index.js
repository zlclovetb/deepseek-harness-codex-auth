import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { ProxyAgent, fetch as undiciFetch } from "undici";

export const name = "codex-cli-auth";
export const inject = ["credentials"];
export const CODEX_CREDENTIAL_REF = "OPENAI_CODEX_AUTH";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const REFRESH_URL = "https://auth.openai.com/oauth/token";
const REFRESH_WINDOW_MS = 5 * 60 * 1000;
let refreshInflight;

function authPath(env = process.env) {
  return join(env.CODEX_HOME || join(homedir(), ".codex"), "auth.json");
}

async function readAuth(path) {
  let auth;
  try {
    auth = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read Codex CLI login at ${path}; run \"codex login\" first`, { cause: error });
  }
  if (typeof auth?.tokens?.access_token !== "string" || typeof auth.tokens.refresh_token !== "string") {
    throw new Error(`Codex CLI login at ${path} has no ChatGPT OAuth tokens; run \"codex login\"`);
  }
  return auth;
}

function expiresAt(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

async function writeAuth(path, auth) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
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
    const latest = await readAuth(path);
    if (latest.tokens.refresh_token !== usedRefreshToken) return latest.tokens.access_token;
    throw new Error(`Codex CLI token refresh failed (HTTP ${response.status}); run \"codex login\" again`);
  }

  const tokens = await response.json();
  if (typeof tokens?.access_token !== "string") {
    throw new Error("Codex CLI token refresh returned no access token");
  }

  const latest = await readAuth(path);
  if (latest.tokens.refresh_token !== usedRefreshToken) return latest.tokens.access_token;
  latest.tokens.access_token = tokens.access_token;
  if (typeof tokens.refresh_token === "string") latest.tokens.refresh_token = tokens.refresh_token;
  latest.last_refresh = new Date().toISOString();
  await writeAuth(path, latest);
  return tokens.access_token;
}

export async function resolveCodexCredential({
  path = authPath(),
  now = Date.now(),
  fetchImpl,
  proxyUrl
} = {}) {
  const auth = await readAuth(path);
  if (expiresAt(auth.tokens.access_token) > now + REFRESH_WINDOW_MS) return auth.tokens.access_token;
  if (!refreshInflight) {
    const dispatcher = fetchImpl || !proxyUrl ? undefined : new ProxyAgent(proxyUrl);
    const requester = fetchImpl ?? (dispatcher
      ? (input, init) => undiciFetch(input, { ...init, dispatcher })
      : globalThis.fetch);
    refreshInflight = refresh(path, auth, requester).finally(async () => {
      await dispatcher?.close();
      refreshInflight = undefined;
    });
  }
  return refreshInflight;
}

export function apply(ctx) {
  const credentials = ctx.get("credentials");
  const originalResolve = credentials.resolve;
  const originalDescribe = credentials.describe;
  async function resolve(ref, options) {
    if (String(ref) !== CODEX_CREDENTIAL_REF) return originalResolve.call(credentials, ref, options);
    return { value: await resolveCodexCredential({ proxyUrl: options?.proxyUrl }), source: "codex-cli" };
  }
  async function describe(ref) {
    if (String(ref) !== CODEX_CREDENTIAL_REF) return originalDescribe.call(credentials, ref);
    try {
      await readAuth(authPath());
      return { configured: true, source: "codex-cli", writable: false };
    } catch {
      return { configured: false, writable: false };
    }
  }
  credentials.resolve = resolve;
  credentials.describe = describe;
  return () => {
    if (credentials.resolve === resolve) credentials.resolve = originalResolve;
    if (credentials.describe === describe) credentials.describe = originalDescribe;
  };
}
