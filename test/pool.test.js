import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { apply, CODEX_CREDENTIAL_REF } from "../index.js";
import { discoverAccounts, accountIdentity } from "../lib/accounts.js";
import { parseQuota, isQuotaExhausted, quotaRetryAt } from "../lib/quota.js";
import { createPool, prunePool, recordOutcome, selectAccount, setPinned, warmPool, poolSnapshot } from "../lib/rotation.js";

function jwt(payload, exp) {
  return `x.${Buffer.from(JSON.stringify({ exp, ...payload })).toString("base64url")}.x`;
}

function codexToken(accountId, exp = Math.floor(Date.now() / 1000) + 3600) {
  return jwt({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }, exp);
}

async function writePool(accounts) {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-pool-"));
  for (const [name, accountId] of Object.entries(accounts)) {
    const path = join(directory, name, "auth.json");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access_token: codexToken(accountId), refresh_token: `refresh-${name}`, account_id: accountId }
    }));
  }
  return directory;
}

test("an empty accounts directory falls back to the legacy single login", async () => {
  const home = await mkdtemp(join(tmpdir(), "dsh-codex-home-"));
  const { pooled, accounts } = await discoverAccounts({ env: { CODEX_HOME: home } });
  assert.equal(pooled, false);
  assert.deepEqual(accounts.map((entry) => entry.id), ["default"]);
  assert.equal(accounts[0].path, join(home, "auth.json"));
});

test("account sub-directories become the pool", async () => {
  const dir = await writePool({ zulu: "acct-z", alpha: "acct-a" });
  const { pooled, accounts } = await discoverAccounts({ accountsDir: dir });
  assert.equal(pooled, true);
  assert.deepEqual(accounts.map((entry) => entry.id), ["alpha", "zulu"]);
});

test("quota headers normalize into the two windows", () => {
  const headers = new Headers({
    "x-codex-primary-used-percent": "42.5",
    "x-codex-primary-reset-after-seconds": "600",
    "x-codex-secondary-used-percent": "100",
    "x-codex-secondary-reset-at": String(Math.floor(Date.now() / 1000) + 7200)
  });
  const now = Date.now();
  const quota = parseQuota(headers, now);
  assert.equal(quota.primaryUsedPercent, 42.5);
  assert.equal(quota.primaryResetsAt, now + 600_000);
  assert.equal(quota.secondaryUsedPercent, 100);
  assert.equal(isQuotaExhausted(quota), true);
  assert.ok(quotaRetryAt(quota) > now);
});

test("hybrid selection prefers the account with headroom and skips a limited one", async () => {
  const dir = await writePool({ alpha: "acct-a", bravo: "acct-b" });
  const { accounts } = await discoverAccounts({ accountsDir: dir });
  const pool = createPool({ strategy: "hybrid" });
  const now = Date.now();

  assert.equal(selectAccount(pool, accounts, { now }).id, "alpha");
  recordOutcome(pool, "alpha", { status: 429, headers: { "x-codex-primary-used-percent": "100" }, now });
  assert.equal(selectAccount(pool, accounts, { now }).id, "bravo");

  const snapshot = poolSnapshot(pool, now);
  assert.equal(snapshot.accounts.find((entry) => entry.id === "alpha").available, false);
  assert.equal(snapshot.accounts.find((entry) => entry.id === "bravo").available, true);
});

test("a window that has already reset returns the account to rotation", async () => {
  const dir = await writePool({ alpha: "acct-a", bravo: "acct-b" });
  const { accounts } = await discoverAccounts({ accountsDir: dir });
  const pool = createPool({ strategy: "hybrid" });
  const now = Date.now();
  recordOutcome(pool, "alpha", {
    status: 429,
    headers: { "x-codex-primary-used-percent": "100", "x-codex-primary-reset-after-seconds": "60" },
    now
  });
  const later = now + 61_000;
  assert.equal(selectAccount(pool, accounts, { now: later }).id, "alpha");
});

test("a pin outranks the strategy until it is released", async () => {
  const dir = await writePool({ alpha: "acct-a", bravo: "acct-b" });
  const { accounts } = await discoverAccounts({ accountsDir: dir });
  const pool = createPool({ strategy: "hybrid" });
  const now = Date.now();

  assert.equal(selectAccount(pool, accounts, { now }).id, "alpha");
  assert.equal(setPinned(pool, "bravo"), "bravo");
  assert.equal(selectAccount(pool, accounts, { now }).id, "bravo");
  assert.equal(poolSnapshot(pool, now).pinned, "bravo");

  assert.equal(setPinned(pool, null), undefined);
  assert.equal(selectAccount(pool, accounts, { now }).id, "alpha");
  assert.equal(poolSnapshot(pool, now).pinned, undefined);
});

test("a pin that is spent steps aside and returns when its window resets", async () => {
  const dir = await writePool({ alpha: "acct-a", bravo: "acct-b" });
  const { accounts } = await discoverAccounts({ accountsDir: dir });
  const pool = createPool({ strategy: "hybrid" });
  const now = Date.now();
  setPinned(pool, "alpha");
  recordOutcome(pool, "alpha", {
    status: 429,
    headers: { "x-codex-primary-used-percent": "100", "x-codex-primary-reset-after-seconds": "60" },
    now
  });

  // The strategy covers the gap rather than replaying a request that cannot work.
  assert.equal(selectAccount(pool, accounts, { now }).id, "bravo");
  assert.equal(poolSnapshot(pool, now).pinned, "alpha");
  assert.equal(selectAccount(pool, accounts, { now: now + 61_000 }).id, "alpha");
});

test("a pin for an account that disappeared is dropped", async () => {
  const dir = await writePool({ alpha: "acct-a", bravo: "acct-b" });
  const pool = createPool({ strategy: "hybrid" });
  setPinned(pool, "bravo");
  prunePool(pool, ["alpha"]);
  assert.equal(pool.pinned, undefined);
});

test("warmPool lists every account without selecting one", async () => {
  const dir = await writePool({ alpha: "acct-a", bravo: "acct-b" });
  const { accounts } = await discoverAccounts({ accountsDir: dir });
  const pool = createPool({ strategy: "hybrid" });
  assert.equal(pool.accounts.size, 0);

  warmPool(pool, accounts);

  const snapshot = poolSnapshot(pool, Date.now());
  assert.deepEqual(snapshot.accounts.map((entry) => entry.id), ["alpha", "bravo"]);
  // Listing is not using: no request went out, so nothing is marked or measured.
  assert.equal(snapshot.accounts.every((entry) => entry.lastUsedAt === undefined && entry.usedPercent5h === undefined), true);
});

test("apply() fills the pool before the first request", async () => {
  const dir = await writePool({ alpha: "acct-a", bravo: "acct-b" });
  const services = {};
  const credentials = { resolve: async () => undefined, describe: async () => ({ configured: false }) };
  const ctx = { get: () => credentials, provide: (nameValue, service) => { services[nameValue] = service; return () => {}; } };
  const dispose = apply(ctx, { accountsDir: dir });
  try {
    const rotation = services.codexMultiAuth;
    const listed = await until(() => rotation.snapshot().accounts.length === 2);
    assert.equal(listed, true, "the panel has accounts to show without a model request");
    assert.deepEqual(rotation.snapshot().accounts.map((entry) => entry.id), ["alpha", "bravo"]);
  } finally {
    dispose();
  }
});

test("apply() resolves through the pool and the observer steers the next request", async () => {
  const dir = await writePool({ alpha: "acct-a", bravo: "acct-b" });
  const services = {};
  const credentials = {
    resolve: async () => undefined,
    describe: async () => ({ configured: false, writable: true })
  };
  const ctx = {
    get: () => credentials,
    provide: (nameValue, service) => {
      services[nameValue] = service;
      return () => {};
    }
  };
  const dispose = apply(ctx, { accountsDir: dir, strategy: "hybrid" });
  try {
    const rotation = services.codexMultiAuth;
    assert.ok(rotation, "the rotation service is provided for the patched adapter");

    const first = await credentials.resolve(CODEX_CREDENTIAL_REF);
    assert.equal(accountIdentity({ tokens: { access_token: first.value } }), "acct-a");

    // One limited reply on account A is enough for the next request to switch.
    rotation.observe({
      token: first.value,
      status: 429,
      headers: { "x-codex-primary-used-percent": "100", "x-codex-primary-reset-after-seconds": "3600" }
    });
    const second = await credentials.resolve(CODEX_CREDENTIAL_REF);
    assert.equal(accountIdentity({ tokens: { access_token: second.value } }), "acct-b");

    assert.equal(rotation.snapshot().accounts.length, 2);
  } finally {
    dispose();
  }
});

test("wrapFetch observes quota without touching the response", async () => {
  const dir = await writePool({ alpha: "acct-a", bravo: "acct-b" });
  const services = {};
  const credentials = { resolve: async () => undefined, describe: async () => ({ configured: false }) };
  const ctx = { get: () => credentials, provide: (nameValue, service) => { services[nameValue] = service; return () => {}; } };
  const dispose = apply(ctx, { accountsDir: dir });
  try {
    const rotation = services.codexMultiAuth;
    const token = (await credentials.resolve(CODEX_CREDENTIAL_REF)).value;
    const wrapped = rotation.wrapFetch(async () => new Response("ok", {
      status: 200,
      headers: { "x-codex-primary-used-percent": "80" }
    }));
    const response = await wrapped("https://example.test", { headers: { authorization: `Bearer ${token}` } });
    assert.equal(await response.text(), "ok");
    assert.equal(rotation.snapshot().accounts.find((entry) => entry.id === "alpha").usedPercent5h, 80);
  } finally {
    dispose();
  }
});

/** A host web server that keeps the routes it was handed. */
function fakeWebServer() {
  const routes = [];
  return { routes, register: (route) => { routes.push(route); return () => {}; } };
}

function fakeExchange(method, body) {
  const request = { method };
  if (body !== undefined) {
    request[Symbol.asyncIterator] = async function* () { yield Buffer.from(body); };
  }
  return {
    request,
    response: {
      headersSent: false,
      writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; },
      end(payload) { this.payload = payload; }
    }
  };
}

/** The route answers a POST from an async body handler, so let it run to rest. */
async function settled(response) {
  for (let turn = 0; turn < 20 && response.payload === undefined; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  return response;
}

/** Wait for something the plugin reaches on its own, e.g. the startup warm-up. */
async function until(predicate) {
  for (let turn = 0; turn < 100; turn += 1) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return predicate();
}

test("the settings panel pins an account over the pool route", async () => {
  const dir = await writePool({ alpha: "acct-a", bravo: "acct-b" });
  const services = {};
  const credentials = { resolve: async () => undefined, describe: async () => ({ configured: false }) };
  const web = fakeWebServer();
  const ctx = {
    get: () => credentials,
    provide: (nameValue, service) => { services[nameValue] = service; return () => {}; },
    inject: (names, callback) => { callback({ webServer: web }); return () => {}; }
  };
  const dispose = apply(ctx, { accountsDir: dir });
  try {
    assert.equal(web.routes.length, 1);
    const route = web.routes[0];
    await credentials.resolve(CODEX_CREDENTIAL_REF);

    const read = fakeExchange("GET");
    route.handler(read.request, read.response);
    assert.equal(read.response.status, 200);
    assert.equal(JSON.parse(read.response.payload).pinned, undefined);

    const post = fakeExchange("POST", JSON.stringify({ pin: "bravo" }));
    route.handler(post.request, post.response);
    await settled(post.response);
    assert.equal(post.response.status, 200);
    assert.equal(JSON.parse(post.response.payload).pinned, "bravo");
    const pinned = await credentials.resolve(CODEX_CREDENTIAL_REF);
    assert.equal(accountIdentity({ tokens: { access_token: pinned.value } }), "acct-b");

    const unknown = fakeExchange("POST", JSON.stringify({ pin: "nobody" }));
    route.handler(unknown.request, unknown.response);
    await settled(unknown.response);
    assert.equal(unknown.response.status, 404);

    const clear = fakeExchange("POST", JSON.stringify({ pin: null }));
    route.handler(clear.request, clear.response);
    await settled(clear.response);
    assert.equal(JSON.parse(clear.response.payload).pinned, undefined);
    const automatic = await credentials.resolve(CODEX_CREDENTIAL_REF);
    assert.equal(accountIdentity({ tokens: { access_token: automatic.value } }), "acct-a");

    const rejected = fakeExchange("DELETE");
    route.handler(rejected.request, rejected.response);
    assert.equal(rejected.response.status, 405);
  } finally {
    dispose();
  }
});