// Wires sync into the app: stamps every write of the collector's data, pushes changes a
// few seconds after they happen, and pulls changes from other devices when the app is
// opened or comes back to the foreground. Imported first by main.ts so it sees every write.
import { SyncApi, merge, deferToRemote, snapshot, sessionFromHash, claims, syncable, backupFile, readBackup, type Session, type Blob } from "./lib/sync.ts";

declare const __SUPABASE_URL__: string;
declare const __SUPABASE_ANON_KEY__: string;

export const syncEnabled = !!(__SUPABASE_URL__ && __SUPABASE_ANON_KEY__);
const api = syncEnabled ? new SyncApi(__SUPABASE_URL__, __SUPABASE_ANON_KEY__) : null;

const TIMES = "setkeeper:sync:times", SESS = "setkeeper:sync:session", LAST = "setkeeper:sync:last", PRE = "setkeeper:sync:before-first-sync";
const DELETED = ""; // a key removed on one device is removed everywhere

const read = <T>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : d; } catch { return d; } };
const write = (k: string, v: unknown) => { try { origSet.call(localStorage, k, JSON.stringify(v)); } catch { /* full or blocked */ } };

export const state = { email: "", last: read<string>(LAST, ""), busy: false, error: "" };
const listeners = new Set<() => void>();
/** Get told whenever sign-in or sync status changes. Returns an unsubscribe function. */
export function onSyncChange(fn: () => void) { listeners.add(fn); return () => listeners.delete(fn); }
const notify = () => { for (const fn of listeners) { try { fn(); } catch { /* a view went away */ } } };
let applying = false;
let timer = 0;

// ---------- stamp every write ----------
const origSet = Storage.prototype.setItem, origRemove = Storage.prototype.removeItem, origGet = Storage.prototype.getItem;
function stamp(key: string) {
  if (applying || !syncable(key)) return;
  const t = read<Record<string, number>>(TIMES, {});
  t[key] = Date.now();
  write(TIMES, t);
  schedule();
}
try {
  // Only real changes count: the app re-saves settings and defaults while it starts up, and
  // those rewrites must not look newer than edits made on another device.
  Storage.prototype.setItem = function (k: string, v: string) {
    const mine = this === localStorage, before = mine ? origGet.call(this, k) : null;
    origSet.call(this, k, v);
    if (mine && before !== v) stamp(k);
  };
  Storage.prototype.removeItem = function (k: string) {
    const mine = this === localStorage, had = mine && origGet.call(this, k) != null;
    origRemove.call(this, k);
    if (had) stamp(k);
  };
} catch { /* storage unavailable: nothing to sync */ }

function localBlob(): Blob {
  const times = read<Record<string, number>>(TIMES, {});
  const b = snapshot(localStorage, times);
  for (const [k, t] of Object.entries(times)) if (!b.keys[k] && syncable(k)) b.keys[k] = { v: DELETED, t };
  return b;
}
function apply(blob: Blob, keys: string[]) {
  applying = true;
  try {
    const times = read<Record<string, number>>(TIMES, {});
    for (const k of keys) {
      const e = blob.keys[k];
      if (!e) continue;
      if (e.v === DELETED) origRemove.call(localStorage, k); else origSet.call(localStorage, k, e.v);
      times[k] = e.t;
    }
    write(TIMES, times);
  } finally { applying = false; }
}

// ---------- session ----------
function saveSession(s: Session | null) { if (s) write(SESS, s); else origRemove.call(localStorage, SESS); state.email = s?.email ?? ""; notify(); }
async function session(): Promise<Session | null> {
  let s = read<Session | null>(SESS, null);
  if (!s || !api) return null;
  if (s.expires_at - Date.now() < 60_000) {
    try { s = await api.refresh(s.refresh_token); saveSession(s); }
    catch { saveSession(null); state.error = "Signed out: your sign-in expired. Sign in again to keep syncing."; return null; }
  }
  return s;
}

/** Call once at startup, before the app reads the address bar. */
export function initSync(onRemoteChange: () => void) {
  if (!api) return;
  const fromLink = sessionFromHash(location.hash);
  if (fromLink) {
    const c = claims(fromLink.access_token);
    if (c) saveSession({ ...fromLink, email: c.email, user_id: c.sub });
    history.replaceState(null, "", location.pathname + location.search + "#data");
  } else if (/error_description=/.test(location.hash)) {
    state.error = new URLSearchParams(location.hash.slice(1)).get("error_description") ?? "Sign-in failed";
    history.replaceState(null, "", location.pathname + location.search + "#data");
  }
  state.email = read<Session | null>(SESS, null)?.email ?? "";
  if (!state.email) return;
  void syncNow().then((changed) => { if (changed) onRemoteChange(); });
  // Automatic sync: when the app comes back to the screen, when the connection returns, and
  // every minute while it's open. Skipped while a card sheet or form is in use, so a change
  // from another device never lands under the collector's fingers.
  const busyHere = () => !!document.querySelector("dialog[open]") || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? "");
  const pull = () => { if (state.email && !busyHere()) void syncNow().then((changed) => { if (changed) onRemoteChange(); }); };
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") pull(); else void syncNow(); });
  addEventListener("online", pull);
  setInterval(() => { if (document.visibilityState === "visible") pull(); }, 60_000);
}

function schedule() {
  if (!state.email) return;
  clearTimeout(timer);
  timer = window.setTimeout(() => void syncNow(), 4000);
}

/** Merge with the cloud copy. Resolves true when another device's changes were applied here. */
export async function syncNow(): Promise<boolean> {
  if (!api || state.busy) return false;
  const s = await session();
  if (!s) { notify(); return false; }
  state.busy = true; state.error = ""; notify();
  try {
    const first = !read<string>(LAST, "");
    if (first) write(PRE, backupFile(localBlob())); // keep this device's data before the first merge
    const remote = await api.pull(s);
    // A device joining for the first time takes the cloud copy wherever both have data
    // (its own data was saved above and can be downloaded from the Data tab).
    const local = first && remote ? deferToRemote(localBlob(), remote.blob) : localBlob();
    const { merged, toLocal, toRemote } = merge(local, remote?.blob ?? null);
    if (toLocal.length) apply(merged, toLocal);
    if (toRemote.length || !remote) await api.push(s, merged);
    state.last = new Date().toISOString(); write(LAST, state.last);
    return toLocal.length > 0;
  } catch (e) {
    state.error = navigator.onLine ? `Couldn't sync: ${(e as Error).message}` : "Offline: changes are saved here and will sync when you're back online.";
    return false;
  } finally { state.busy = false; notify(); }
}

export async function sendLink(email: string) {
  if (!api) throw new Error("Sync isn't set up for this site.");
  await api.sendLink(email.trim(), location.origin + location.pathname);
}
export async function signOut() {
  const s = read<Session | null>(SESS, null);
  if (s && api) await api.signOut(s.access_token);
  saveSession(null);
  origRemove.call(localStorage, LAST);
  state.last = "";
  notify();
}
export async function deleteCloudCopy() {
  const s = await session();
  if (!s || !api) return;
  // delete the whole account; if the database predates that function, delete the data row
  try { await api.deleteAccount(s); } catch { await api.remove(s); }
  await signOut();
}

// ---------- backup file (works with or without sync) ----------
export function backupText() { return JSON.stringify(backupFile(localBlob()), null, 1); }
export function hasPreSyncCopy() { return !!localStorage.getItem(PRE); }
export function preSyncText() { return localStorage.getItem(PRE) ?? ""; }
/** Restore a backup: replaces this device's collection data (and syncs it if signed in). */
export function restore(text: string) {
  const blob = readBackup(text);
  const now = Date.now();
  const times: Record<string, number> = {};
  for (const k of Object.keys(localBlob().keys)) if (!blob.keys[k]) { origRemove.call(localStorage, k); times[k] = now; }
  for (const [k, e] of Object.entries(blob.keys)) { if (e.v !== DELETED) origSet.call(localStorage, k, e.v); times[k] = now; }
  write(TIMES, times);
  schedule();
}

/** Ask the browser not to clear this site's storage when space runs low. */
export async function persistStorage(): Promise<boolean> {
  try { return (await navigator.storage?.persisted?.()) || (await navigator.storage?.persist?.()) || false; } catch { return false; }
}

/** Newest price snapshot the scout saved for a set. Signed-in collectors only; the history stays private. */
export async function latestListings(setId: string): Promise<unknown | null> {
  if (!syncEnabled) return null;
  const s = await session();
  if (!s) return null;
  const res = await fetch(`${__SUPABASE_URL__.replace(/\/$/, "")}/rest/v1/rpc/latest_listings`, {
    method: "POST",
    headers: { apikey: __SUPABASE_ANON_KEY__, Authorization: `Bearer ${s.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_set: setId }),
  });
  return res.ok ? res.json() : null;
}
