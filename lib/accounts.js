import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

/** The Codex home this process resolves against, honouring `CODEX_HOME`. */
export function codexHome(env = process.env) {
  return env.CODEX_HOME || join(homedir(), ".codex");
}

/** The single-account login Codex CLI itself writes. */
export function legacyAuthPath(env = process.env) {
  return join(codexHome(env), "auth.json");
}

/**
 * Resolve the multi-account directory.
 *
 * Precedence: explicit config, then `CODEX_ACCOUNTS_DIR`, then the layout this
 * plugin defaults to — `$CODEX_HOME/accounts`, each account in its own
 * `<name>/auth.json`.
 */
export function resolveAccountsDir({ accountsDir, env = process.env } = {}) {
  return accountsDir || env.CODEX_ACCOUNTS_DIR || join(codexHome(env), "accounts");
}

/** Decode a JWT payload without verifying it; `undefined` for anything malformed. */
export function decodeAccessToken(token) {
  if (typeof token !== "string") return undefined;
  const segment = token.split(".")[1];
  if (segment === undefined) return undefined;
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

/** Expiry of an access token in epoch milliseconds; `0` when it cannot be read. */
export function expiresAt(token) {
  const payload = decodeAccessToken(token);
  return typeof payload?.exp === "number" ? payload.exp * 1000 : 0;
}

/**
 * A stable identity for the ChatGPT account behind an access token.
 *
 * The ChatGPT account id is the only claim that survives a token refresh, so it
 * is what the observer uses to attribute a response to a pool entry.
 */
export function accountIdentity(auth) {
  const payload = decodeAccessToken(auth?.tokens?.access_token);
  return payload?.["https://api.openai.com/auth"]?.chatgpt_account_id
    || auth?.tokens?.account_id
    || payload?.sub
    || undefined;
}

/** Read and validate one Codex CLI auth document. */
export async function readAccountAuth(path) {
  let auth;
  try {
    auth = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read Codex CLI login at ${path}; run "codex login" first`, { cause: error });
  }
  if (typeof auth?.tokens?.access_token !== "string" || typeof auth.tokens.refresh_token !== "string") {
    throw new Error(`Codex CLI login at ${path} has no ChatGPT OAuth tokens; run "codex login"`);
  }
  return auth;
}

/** Atomically replace one auth document, keeping the file owner-only. */
export async function writeAccountAuth(path, auth) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** One account address; `path` is not read here so discovery stays a single `readdir`. */
function entryFor(dir, name) {
  return { id: name, name, path: join(dir, name, "auth.json"), legacy: false };
}

/**
 * Enumerate the account pool.
 *
 * A configured directory with at least one sub-directory *is* the pool. An
 * absent or empty directory falls back to the legacy single login at
 * `$CODEX_HOME/auth.json` under the id `"default"`, so a single-account install
 * behaves exactly as it did before this pool existed.
 */
export async function discoverAccounts({ accountsDir, env = process.env } = {}) {
  const dir = resolveAccountsDir({ accountsDir, env });
  let dirents = [];
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch {
    dirents = [];
  }
  const accounts = dirents
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => entryFor(dir, dirent.name))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (accounts.length > 0) return { dir, pooled: true, accounts };
  return { dir, pooled: false, accounts: [{ id: "default", name: "default", path: legacyAuthPath(env), legacy: true }] };
}

/** Human-readable label for diagnostics and the settings snapshot. */
export function accountLabel(entry, auth) {
  const identity = accountIdentity(auth);
  return identity === undefined ? entry.name : `${entry.name} (${identity.slice(0, 8)}…)`;
}