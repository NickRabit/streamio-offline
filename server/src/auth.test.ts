import assert from "node:assert/strict";
import { test } from "node:test";
import { createSession, hashPassword, parseCookies, pruneRevoked, readSession, sessionCookie, verifyPassword } from "./auth.js";

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
