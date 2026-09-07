import assert from "node:assert/strict";
import { test } from "node:test";
import { createSession, DECOY_HASH, hashPassword, LoginThrottle, parseCookies, pruneRevoked, readSession, secretEquals, sessionCookie, verifyPassword } from "./auth.js";

test("otisk hesla neobsahuje heslo a stejné heslo dá pokaždé jiný otisk", async () => {
  const first = await hashPassword("tajneheslo");
  const second = await hashPassword("tajneheslo");
  assert.ok(!first.includes("tajneheslo"));
  assert.notEqual(first, second, "náhodná sůl musí otisky odlišit");
  assert.ok(await verifyPassword("tajneheslo", first));
  assert.ok(await verifyPassword("tajneheslo", second));
});

test("špatné heslo neprojde", async () => {
  const stored = await hashPassword("spravne");
  assert.equal(await verifyPassword("spatne", stored), false);
  assert.equal(await verifyPassword("", stored), false);
});

test("poškozený otisk nespadne, jen neprojde", async () => {
  for (const broken of ["", "nesmysl", "scrypt$", "md5$aa$bb"]) {
    assert.equal(await verifyPassword("cokoli", broken), false);
  }
});

test("platná známka vrátí uživatele i identifikátor relace", () => {
  const token = createSession("tajemstvi", "ondra", Date.now() + 60_000);
  const info = readSession("tajemstvi", token);
  assert.equal(info?.username, "ondra");
  assert.ok(info?.sid, "relace musí mít identifikátor, jinak ji nelze odvolat");
});

test("každé přihlášení dostane vlastní identifikátor relace", () => {
  const a = readSession("tajemstvi", createSession("tajemstvi", "ondra", Date.now() + 60_000));
  const b = readSession("tajemstvi", createSession("tajemstvi", "ondra", Date.now() + 60_000));
  assert.notEqual(a?.sid, b?.sid, "jinak by odhlášení shodilo i ostatní zařízení");
});

test("ze seznamu odvolaných zmizí, co už stejně vypršelo", () => {
  const kept = Date.now() + 60_000;
  assert.deepEqual(pruneRevoked({ stara: Date.now() - 1000, platna: kept }), { platna: kept });
  assert.deepEqual(pruneRevoked(undefined), {});
});

test("známka podepsaná jiným tajemstvím neprojde", () => {
  const token = createSession("tajemstvi", "ondra", Date.now() + 60_000);
  assert.equal(readSession("jine-tajemstvi", token), undefined);
});

test("prošlá známka neprojde", () => {
  const token = createSession("tajemstvi", "ondra", Date.now() - 1000);
  assert.equal(readSession("tajemstvi", token), undefined);
});

test("podvržený obsah známky neprojde", () => {
  const token = createSession("tajemstvi", "ondra", Date.now() + 60_000);
  const [, signature] = token.split(".");
  const cizi = Buffer.from(JSON.stringify({ u: "admin", e: Date.now() + 60_000 })).toString("base64url");
  assert.equal(readSession("tajemstvi", `${cizi}.${signature}`), undefined);
});

test("nesmyslná známka nespadne", () => {
  for (const token of [undefined, "", "abc", "a.b.c", "..", "eyJ9.xxx"]) {
    assert.equal(readSession("tajemstvi", token), undefined);
  }
});

test("cookie se rozebere i s mezerami a rovnítkem v hodnotě", () => {
  assert.deepEqual(parseCookies("a=1; b=2"), { a: "1", b: "2" });
  assert.equal(parseCookies("session=abc.def%3D%3D").session, "abc.def==");
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies("=nesmysl;;"), {});
});

test("cookie je HttpOnly a bez zapamatování nepřežije zavření prohlížeče", () => {
  const remembered = sessionCookie("t", true, false);
  assert.match(remembered, /HttpOnly/);
  assert.match(remembered, /SameSite=Lax/);
  assert.match(remembered, /Max-Age=\d+/);
  assert.ok(!sessionCookie("t", false, false).includes("Max-Age"), "bez zapamatování žádná trvanlivost");
  assert.ok(!sessionCookie("t", true, false).includes("Secure"), "na HTTP by Secure cookie zahodilo");
  assert.match(sessionCookie("t", true, true), /Secure/);
});

test("repeated sign-in failures buy time and a success clears the record", () => {
  let now = 0;
  const throttle = new LoginThrottle(() => now, 2, 1000, 4000);
  throttle.fail("10.0.0.1");
  assert.equal(throttle.retryAfterMs("10.0.0.1"), 0);
  throttle.fail("10.0.0.1");
  assert.equal(throttle.retryAfterMs("10.0.0.1"), 0);
  throttle.fail("10.0.0.1");
  assert.equal(throttle.retryAfterMs("10.0.0.1"), 1000);
  assert.equal(throttle.retryAfterMs("10.0.0.2"), 0, "another address is not punished for it");
  now = 1000;
  assert.equal(throttle.retryAfterMs("10.0.0.1"), 0);
  throttle.fail("10.0.0.1");
  assert.equal(throttle.retryAfterMs("10.0.0.1"), 2000);
  for (let attempt = 0; attempt < 10; attempt += 1) throttle.fail("10.0.0.1");
  assert.equal(throttle.retryAfterMs("10.0.0.1"), 4000, "the pause never grows past the cap");
  throttle.succeed("10.0.0.1");
  assert.equal(throttle.retryAfterMs("10.0.0.1"), 0);
});

test("a forgotten address starts over and the record does not grow without bound", () => {
  let now = 0;
  const throttle = new LoginThrottle(() => now, 0, 1000, 4000, 10_000, 2);
  throttle.fail("10.0.0.1");
  assert.equal(throttle.retryAfterMs("10.0.0.1"), 1000);
  now = 10_000;
  assert.equal(throttle.retryAfterMs("10.0.0.1"), 0);
  for (const address of ["a", "b", "c", "d"]) throttle.fail(address);
  assert.equal(throttle.retryAfterMs("a"), 0, "the oldest records are dropped once the map is full");
  assert.equal(throttle.retryAfterMs("d"), 1000);
});

test("secrets compare in constant time whatever their length", () => {
  assert.equal(secretEquals("heslo", "heslo"), true);
  assert.equal(secretEquals("heslo", "heslx"), false);
  assert.equal(secretEquals("heslo", "heslo-delsi"), false);
  assert.equal(secretEquals("", ""), true);
  assert.equal(secretEquals("", "x"), false);
});

test("the decoy hash costs a real scrypt round and never matches", async () => {
  assert.match(DECOY_HASH, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
  assert.equal(await verifyPassword("", DECOY_HASH), false);
  assert.equal(await verifyPassword("admin", DECOY_HASH), false);
});
