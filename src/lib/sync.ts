// Optional sign-in and sync through Supabase (https://supabase.com).
//
// The app keeps working from browser storage exactly as before; sync copies the
// collector's own data (binders, card statuses, prices paid, imported listings) to one
// row per user in a Postgres table protected by row-level security, and merges it back
// on other devices. Card databases, caches and per-device settings are never uploaded.
//
// No SDK: Supabase Auth (email sign-in links) and the REST API are plain HTTP, so this
// adds no dependency. Without SUPABASE_URL / SUPABASE_ANON_KEY at build time, sync is
// switched off and the app is the same local-only app as before.

export interface Session { access_token: string; refresh_token: string; expires_at: number; email: string; user_id: string }
export interface Blob { v: 1; keys: Record<string, { v: string; t: number }> }
type Fetch = typeof fetch;

const PREFIX = "setkeeper:v1:";
const LOCAL_ONLY = /^setkeeper:v1:(catalog:|fp:|setlist|galleries-seen|tiers-seen)/;
/** Keys that hold the collector's own data and travel between devices. */
export const syncable = (key: string) => key.startsWith(PREFIX) && !LOCAL_ONLY.test(key);

// ---------- merging (pure) ----------
/** Per key, the newer write wins. Returns the merged blob and which keys each side must take. */
export function merge(local: Blob, remote: Blob | null): { merged: Blob; toLocal: string[]; toRemote: string[] } {
  const keys: Blob["keys"] = { ...local.keys };
  const toLocal: string[] = [], toRemote: string[] = [];
  const r = remote?.keys ?? {};
  for (const [k, rv] of Object.entries(r)) {
    const lv = local.keys[k];
    if (!lv || rv.t > lv.t) { keys[k] = rv; if (!lv || lv.v !== rv.v) toLocal.push(k); }
  }
  for (const [k, lv] of Object.entries(local.keys)) if (!r[k] || lv.t > r[k].t) toRemote.push(k);
  return { merged: { v: 1, keys }, toLocal, toRemote };
}

/** First sync on a device: where the cloud already has a key, the cloud's version wins. */
export function deferToRemote(local: Blob, remote: Blob): Blob {
  const keys: Blob["keys"] = {};
  for (const [k, e] of Object.entries(local.keys)) keys[k] = remote.keys[k] ? { v: e.v, t: Math.min(e.t, remote.keys[k].t - 1) } : e;
  return { v: 1, keys };
}

/** Snapshot of syncable keys in a storage, stamped with their last-write times. */
export function snapshot(store: Storage, times: Record<string, number>): Blob {
  const keys: Blob["keys"] = {};
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i)!;
    if (!syncable(k)) continue;
    const v = store.getItem(k);
    if (v != null) keys[k] = { v, t: times[k] ?? 0 };
  }
  return { v: 1, keys };
}

// ---------- sign-in link ----------
/** Tokens Supabase appends to the page address after the collector clicks the email link. */
export function sessionFromHash(hash: string, now = Date.now()): Omit<Session, "email" | "user_id"> | null {
  const p = new URLSearchParams(hash.replace(/^#/, ""));
  const at = p.get("access_token"), rt = p.get("refresh_token");
  if (!at || !rt) return null;
  const exp = Number(p.get("expires_at")) * 1000 || now + Number(p.get("expires_in") ?? 3600) * 1000;
  return { access_token: at, refresh_token: rt, expires_at: exp };
}
/** User id and email from an access token (a JWT); the server checks it on every request. */
export function claims(jwt: string): { sub: string; email: string } | null {
  try {
    const b = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const j = JSON.parse(decodeURIComponent(escape(atob(b + "=".repeat((4 - (b.length % 4)) % 4)))));
    return j.sub ? { sub: j.sub, email: j.email ?? "" } : null;
  } catch { return null; }
}

// ---------- HTTP ----------
export class SyncApi {
  url: string; key: string; f: Fetch;
  constructor(url: string, key: string, f: Fetch = (...a) => fetch(...a)) { this.url = url.replace(/\/$/, ""); this.key = key; this.f = f; }

  private async call(path: string, init: RequestInit & { token?: string } = {}) {
    const res = await this.f(this.url + path, {
      ...init,
      headers: { apikey: this.key, "Content-Type": "application/json", ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}), ...(init.headers ?? {}) },
    });
    const text = await res.text();
    const body = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(body?.msg ?? body?.message ?? body?.error_description ?? `HTTP ${res.status}`);
    return body;
  }

  /** Email a one-time sign-in link that returns to `redirectTo`. Creates the account on first use. */
  sendLink(email: string, redirectTo: string) {
    return this.call(`/auth/v1/otp?redirect_to=${encodeURIComponent(redirectTo)}`, { method: "POST", body: JSON.stringify({ email, create_user: true }) });
  }
  async refresh(refresh_token: string): Promise<Session> {
    const b = await this.call("/auth/v1/token?grant_type=refresh_token", { method: "POST", body: JSON.stringify({ refresh_token }) });
    return { access_token: b.access_token, refresh_token: b.refresh_token, expires_at: Date.now() + b.expires_in * 1000, email: b.user?.email ?? "", user_id: b.user?.id ?? "" };
  }
  signOut(token: string) { return this.call("/auth/v1/logout", { method: "POST", token }).catch(() => {}); }

  async pull(s: Session): Promise<{ blob: Blob; updated_at: string } | null> {
    const rows = await this.call(`/rest/v1/collections?select=data,updated_at&user_id=eq.${encodeURIComponent(s.user_id)}`, { token: s.access_token });
    return rows?.[0] ? { blob: rows[0].data as Blob, updated_at: rows[0].updated_at } : null;
  }
  push(s: Session, blob: Blob) {
    return this.call("/rest/v1/collections?on_conflict=user_id", {
      method: "POST", token: s.access_token, headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ user_id: s.user_id, data: blob, updated_at: new Date().toISOString() }),
    });
  }
  /** Delete the collector's cloud copy (local data stays). */
  /** Delete the account itself (the cloud copy goes with it). Needs delete_my_account() from setup.sql. */
  deleteAccount(s: Session) { return this.call("/rest/v1/rpc/delete_my_account", { method: "POST", token: s.access_token, body: "{}" }); }
  remove(s: Session) { return this.call(`/rest/v1/collections?user_id=eq.${encodeURIComponent(s.user_id)}`, { method: "DELETE", token: s.access_token }); }
}

// ---------- backup file ----------
export interface BackupFile { app: "SetKeeper"; version: 1; exportedAt: string; data: Blob }
export const backupFile = (blob: Blob): BackupFile => ({ app: "SetKeeper", version: 1, exportedAt: new Date().toISOString(), data: blob });
export function readBackup(text: string): Blob {
  const j = JSON.parse(text) as BackupFile;
  if (j?.app !== "SetKeeper" || !j.data?.keys) throw new Error("That isn't a SetKeeper backup file.");
  for (const k of Object.keys(j.data.keys)) if (!syncable(k)) delete j.data.keys[k];
  return j.data;
}
