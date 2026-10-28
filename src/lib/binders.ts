// The binder shelf: one binder per set the collector tracks, plus personal binders
// that hold any cards from any set in the order the collector chooses.

export type Material = "leather" | "canvas" | "carbon";
export type Pockets = 4 | 9 | 12;

export interface Slot {
  ref: string; // TCGdex card id, or "<setId>/<cardId>" for bundled sets
  setId: string;
  setName?: string;
  name: string;
  number: string;
  image?: string; // full image URL base or bundled image key
  addedAt: string;
  note?: string;
}

export interface Binder {
  id: string;
  kind: "set" | "personal";
  setId?: string;
  name: string;
  color: string;
  material: Material;
  pockets: Pockets;
  createdAt: string;
  slots?: Slot[];
  owner?: string; // name written on the inside cover
  logo?: string; // set logo URL (without extension)
}

export interface Shelf {
  version: 1;
  binders: Binder[];
  active: string; // binder id
  activeSet: string; // set the tool tabs work on
}

const KEY = "setkeeper:v1:shelf";
export const COVER_COLORS = ["#1d2b4f", "#5b1a1a", "#14412e", "#2b2b2b", "#4a2a63", "#7a4b12", "#0f4c5c", "#8a1538"];

export function defaultShelf(): Shelf {
  return {
    version: 1, active: "b-30th", activeSet: "30th-celebration",
    binders: [{ id: "b-30th", kind: "set", setId: "30th-celebration", name: "30th Celebration", color: "#1d2b4f", material: "leather", pockets: 9, createdAt: new Date().toISOString() }],
  };
}

export function loadShelf(): Shelf {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as Shelf;
      if (s.binders?.length) return s;
    }
  } catch { /* storage unavailable */ }
  return defaultShelf();
}

export function saveShelf(s: Shelf): boolean {
  try { localStorage.setItem(KEY, JSON.stringify(s)); return true; } catch { return false; }
}

/** Stable cover colour for a set so each set binder looks different. */
export function colorFor(setId: string): string {
  let h = 0;
  for (const ch of setId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COVER_COLORS[h % COVER_COLORS.length];
}

export function newId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function addSetBinder(s: Shelf, setId: string, name: string, logo?: string): Binder {
  const existing = s.binders.find((b) => b.kind === "set" && b.setId === setId);
  if (existing) return existing;
  const b: Binder = { id: newId("b"), kind: "set", setId, name, color: colorFor(setId), material: "leather", pockets: 9, createdAt: new Date().toISOString(), ...(logo ? { logo } : {}) };
  s.binders.push(b);
  return b;
}

export function addPersonalBinder(s: Shelf, name: string, color: string, material: Material, pockets: Pockets): Binder {
  const b: Binder = { id: newId("p"), kind: "personal", name: name.trim() || "My binder", color, material, pockets, createdAt: new Date().toISOString(), slots: [] };
  s.binders.push(b);
  return b;
}

export function addSlot(b: Binder, slot: Omit<Slot, "addedAt">, at?: number): boolean {
  b.slots ??= [];
  const full: Slot = { ...slot, addedAt: new Date().toISOString() };
  if (at == null || at >= b.slots.length) b.slots.push(full);
  else b.slots.splice(Math.max(0, at), 0, full);
  return true;
}

export function moveSlot(b: Binder, from: number, to: number) {
  if (!b.slots || from < 0 || from >= b.slots.length) return;
  const [x] = b.slots.splice(from, 1);
  b.slots.splice(Math.max(0, Math.min(b.slots.length, to)), 0, x);
}

export function removeSlot(b: Binder, index: number) {
  b.slots?.splice(index, 1);
}

/** Split items into binder pages of N pockets. Always at least one page. */
export function paginate<T>(items: T[], perPage: number): T[][] {
  const pages: T[][] = [];
  for (let i = 0; i < items.length; i += perPage) pages.push(items.slice(i, i + perPage));
  return pages.length ? pages : [[]];
}

export const POCKET_GRID: Record<Pockets, [number, number]> = { 4: [2, 2], 9: [3, 3], 12: [4, 3] };
