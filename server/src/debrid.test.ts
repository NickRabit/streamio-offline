import assert from "node:assert/strict";
import test from "node:test";
import { DebridError, RD_API, verifyRealDebridToken } from "./debrid.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("a premium token is accepted", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const user = await verifyRealDebridToken("  secret-token  ", async (url, init) => {
    calls.push({ url, init });
    return json({ username: "nick", type: "premium", premium: 86_400 });
  });
  assert.deepEqual(user, { username: "nick", premium: true });
  assert.equal(calls[0].url, `${RD_API}/user`);
  assert.equal((calls[0].init?.headers as Record<string, string>).authorization, "Bearer secret-token");
});

test("a free account is rejected", async () => {
  await assert.rejects(
    verifyRealDebridToken("free", async () => json({ username: "free", type: "free", premium: 0 })),
    (error: unknown) => error instanceof DebridError && /není premium/.test(error.message) && error.status === 400,
  );
});

test("an invalid token is rejected without storing a guess", async () => {
  await assert.rejects(
    verifyRealDebridToken("nope", async () => json({ error: "bad_token" }, 401)),
    (error: unknown) => error instanceof DebridError && error.status === 401 && /není platný/.test(error.message),
  );
});

test("an empty token is rejected before any request", async () => {
  let called = false;
  await assert.rejects(
    verifyRealDebridToken("   ", async () => { called = true; return json({}); }),
    /Zadejte API token/,
  );
  assert.equal(called, false);
});
