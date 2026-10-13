import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { apply, CODEX_CREDENTIAL_REF, resolveCodexCredential } from "../index.js";

function jwt(exp) {
  return `x.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.x`;
}

async function fixture(exp) {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-auth-"));
  const path = join(directory, "auth.json");
  await writeFile(path, JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { access_token: jwt(exp), refresh_token: "refresh-old", account_id: "account" }
  }));
  return path;
}

test("returns a fresh Codex access token without network access", async () => {
  const path = await fixture(Math.floor(Date.now() / 1000) + 3600);
  const token = await resolveCodexCredential({ path, fetchImpl: () => assert.fail("unexpected refresh") });
  assert.equal(token, JSON.parse(await readFile(path, "utf8")).tokens.access_token);
});

test("refreshes an expiring token and preserves the Codex auth document", async () => {
  const path = await fixture(1);
  const fresh = jwt(Math.floor(Date.now() / 1000) + 3600);
  const token = await resolveCodexCredential({
    path,
    fetchImpl: async (_url, request) => {
      const body = JSON.parse(request.body);
      assert.equal(body.refresh_token, "refresh-old");
      return new Response(JSON.stringify({ access_token: fresh, refresh_token: "refresh-new" }));
    }
  });
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.equal(token, fresh);
  assert.equal(saved.tokens.refresh_token, "refresh-new");
  assert.equal(saved.tokens.account_id, "account");
  assert.ok(saved.last_refresh);
});

test("only intercepts the dedicated credential reference", async () => {
  const originalResolve = async (ref) => ({ value: `original:${ref}`, source: "test" });
  const originalDescribe = async () => ({ configured: true, source: "original", writable: true });
  const credentials = { resolve: originalResolve, describe: originalDescribe };
  const dispose = apply({ get: () => credentials });
  assert.deepEqual(await credentials.resolve("OTHER_KEY"), { value: "original:OTHER_KEY", source: "test" });
  assert.deepEqual(await credentials.describe("OTHER_KEY"), { configured: true, source: "original", writable: true });
  dispose();
  assert.equal(credentials.resolve, originalResolve);
  assert.equal(credentials.describe, originalDescribe);
  assert.equal(CODEX_CREDENTIAL_REF, "OPENAI_CODEX_AUTH");
});

test("reports the live Codex login as a configured read-only credential", async () => {
  const path = await fixture(Math.floor(Date.now() / 1000) + 3600);
  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = dirname(path);
  const credentials = {
    resolve: async () => undefined,
    describe: async () => ({ configured: false, writable: true })
  };
  const dispose = apply({ get: () => credentials });
  try {
    assert.deepEqual(await credentials.describe(CODEX_CREDENTIAL_REF), {
      configured: true,
      source: "codex-cli",
      writable: false
    });
  } finally {
    dispose();
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
  }
});

