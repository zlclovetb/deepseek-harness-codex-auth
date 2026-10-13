import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { apply, CODEX_CREDENTIAL_REF } from "../index.js";
import { discoverAccounts, accountIdentity } from "../lib/accounts.js";
import { parseQuota, isQuotaExhausted, quotaRetryAt } from "../lib/quota.js";
import { createPool, recordOutcome, selectAccount, poolSnapshot } from "../lib/rotation.js";

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