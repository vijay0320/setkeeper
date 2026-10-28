import { test } from "node:test";
import assert from "node:assert/strict";
import { merge, deferToRemote, syncable, sessionFromHash, claims, SyncApi, readBackup, backupFile, snapshot, type Blob } from "../src/lib/sync.ts";

const B = (o: Record<string, [string, number]>): Blob => ({ v: 1, keys: Object.fromEntries(Object.entries(o).map(([k, [v, t]]) => [k, { v, t }])) });

test("only the collector's own data syncs", () => {
  assert.ok(syncable("setkeeper:v1:shelf"));
  assert.ok(syncable("setkeeper:v1:30th-celebration"));
  assert.ok(syncable("setkeeper:v1:market:sv08"));
  for (const k of ["setkeeper:v1:catalog:sv08", "setkeeper:v1:fp:sv08", "setkeeper:v1:setlist", "setkeeper:v1:tiers-seen", "setkeeper:sync:session", "setkeeper:binderMode", "other"]) assert.ok(!syncable(k), k);
});

test("newer write wins per key; each side gets what it lacks", () => {
  const local = B({ "setkeeper:v1:shelf": ["L", 20], "setkeeper:v1:a": ["La", 5], "setkeeper:v1:only-here": ["x", 1] });
  const remote = B({ "setkeeper:v1:shelf": ["R", 10], "setkeeper:v1:a": ["Ra", 9], "setkeeper:v1:only-there": ["y", 3] });
  const { merged, toLocal, toRemote } = merge(local, remote);
  assert.equal(merged.keys["setkeeper:v1:shelf"].v, "L");
  assert.equal(merged.keys["setkeeper:v1:a"].v, "Ra");
  assert.deepEqual(toLocal.sort(), ["setkeeper:v1:a", "setkeeper:v1:only-there"]);
  assert.deepEqual(toRemote.sort(), ["setkeeper:v1:only-here", "setkeeper:v1:shelf"]);
  // first sync: nothing in the cloud yet, everything goes up
  assert.equal(merge(local, null).toRemote.length, 3);
  // already in step: nothing to do
  const same = merge(local, local);
  assert.deepEqual([same.toLocal, same.toRemote], [[], []]);
});

test("snapshot skips caches and stamps times", () => {
  const m = new Map([["setkeeper:v1:shelf", "S"], ["setkeeper:v1:catalog:x", "big"], ["setkeeper:v1:sv08", "C"]]);
  const store = { get length() { return m.size; }, key: (i: number) => [...m.keys()][i], getItem: (k: string) => m.get(k) ?? null } as unknown as Storage;
  assert.deepEqual(snapshot(store, { "setkeeper:v1:sv08": 7 }).keys, { "setkeeper:v1:shelf": { v: "S", t: 0 }, "setkeeper:v1:sv08": { v: "C", t: 7 } });
});

test("reads the session from a sign-in link", () => {
  const s = sessionFromHash("#access_token=aaa&expires_at=2000000000&refresh_token=rrr&token_type=bearer&type=magiclink");
  assert.deepEqual(s, { access_token: "aaa", refresh_token: "rrr", expires_at: 2000000000000 });
  assert.equal(sessionFromHash("#binder"), null);
  const jwt = ["x", Buffer.from(JSON.stringify({ sub: "u1", email: "a@b.ca" })).toString("base64url"), "sig"].join(".");
  assert.deepEqual(claims(jwt), { sub: "u1", email: "a@b.ca" });
  assert.equal(claims("garbage"), null);
});

test("talks to Supabase with the user's token and upserts one row", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(url.includes("select=") ? JSON.stringify([{ data: B({ "setkeeper:v1:shelf": ["S", 1] }), updated_at: "t" }]) : "", { status: 200 }); }) as typeof fetch;
  const api = new SyncApi("https://p.supabase.co/", "anon", f);
  const s = { access_token: "tok", refresh_token: "r", expires_at: 0, email: "a@b.ca", user_id: "u1" };
  const got = await api.pull(s);
  assert.equal(got?.blob.keys["setkeeper:v1:shelf"].v, "S");
  await api.push(s, B({}));
  assert.equal(calls[0].url, "https://p.supabase.co/rest/v1/collections?select=data,updated_at&user_id=eq.u1");
  const h = calls[1].init.headers as Record<string, string>;
  assert.equal(h.Authorization, "Bearer tok");
  assert.equal(h.apikey, "anon");
  assert.match(h.Prefer, /merge-duplicates/);
  assert.equal(JSON.parse(String(calls[1].init.body)).user_id, "u1");
  await api.sendLink("a@b.ca", "https://x.github.io/setkeeper/");
  assert.match(calls[2].url, /\/auth\/v1\/otp\?redirect_to=https%3A%2F%2Fx\.github\.io%2Fsetkeeper%2F$/);
  const fail = new SyncApi("https://p.supabase.co", "anon", (async () => new Response(JSON.stringify({ msg: "Email rate limit exceeded" }), { status: 429 })) as typeof fetch);
  await assert.rejects(fail.sendLink("a@b.ca", "x"), /rate limit/);
});

test("backup files round-trip and refuse other files", () => {
  const blob = B({ "setkeeper:v1:shelf": ["S", 1], "setkeeper:v1:catalog:x": ["cache", 1] });
  const back = readBackup(JSON.stringify(backupFile(blob)));
  assert.deepEqual(Object.keys(back.keys), ["setkeeper:v1:shelf"]);
  assert.throws(() => readBackup('{"hello":1}'), /isn't a SetKeeper backup/);
});

test("a device's first sync takes the cloud copy where both have data", () => {
  // the phone re-saved its empty defaults while starting up, so they look newer
  const phone = B({ "setkeeper:v1:shelf": ["empty", 900], "setkeeper:v1:30th-celebration": ["{}", 900], "setkeeper:v1:phone-only": ["p", 900] });
  const cloud = B({ "setkeeper:v1:shelf": ["laptop", 500], "setkeeper:v1:30th-celebration": ['{"001":"have"}', 500] });
  const { merged, toLocal, toRemote } = merge(deferToRemote(phone, cloud), cloud);
  assert.equal(merged.keys["setkeeper:v1:30th-celebration"].v, '{"001":"have"}');
  assert.deepEqual(toLocal.sort(), ["setkeeper:v1:30th-celebration", "setkeeper:v1:shelf"]);
  assert.deepEqual(toRemote, ["setkeeper:v1:phone-only"]);
});
