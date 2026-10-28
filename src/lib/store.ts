import type { Collection, Entry, Settings } from "./types.ts";
import { DEFAULT_SETTINGS } from "./types.ts";

const key = (setId: string) => `setkeeper:v1:${setId}`;

export function emptyCollection(setId: string): Collection {
  return { version: 1, setId, entries: {}, settings: { ...DEFAULT_SETTINGS }, updatedAt: new Date().toISOString() };
}

export function load(setId: string): Collection {
  try {
    const raw = localStorage.getItem(key(setId));
    if (!raw) return emptyCollection(setId);
    const c = JSON.parse(raw) as Collection;
    return { ...emptyCollection(setId), ...c, settings: { ...DEFAULT_SETTINGS, ...c.settings } };
  } catch {
    return emptyCollection(setId);
  }
}

export function save(c: Collection): boolean {
  c.updatedAt = new Date().toISOString();
  try {
    localStorage.setItem(key(c.setId), JSON.stringify(c));
    return true;
  } catch {
    return false;
  }
}

export function updateEntry(c: Collection, id: string, patch: Partial<Entry>): Entry {
  const next: Entry = { ...(c.entries[id] ?? {}), ...patch };
  for (const k of Object.keys(next) as (keyof Entry)[])
    if (next[k] === undefined || next[k] === "" || (typeof next[k] === "number" && Number.isNaN(next[k]))) delete next[k];
  c.entries[id] = next;
  return next;
}

export function updateSettings(c: Collection, patch: Partial<Settings>) {
  c.settings = { ...c.settings, ...patch };
}
