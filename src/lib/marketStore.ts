// Where price data comes from in the app, plus the collector's own seller shipping edits.
import type { MarketSnapshot, ShippingRule } from "./market.ts";

export interface BuyPrefs {
  mode: "value" | "complete";
  conditions: string[];
  canadaOnly: boolean;
  scope: "all" | "priority";
}

export interface MarketState {
  source: "scout" | "import" | "sample" | "none";
  snapshot?: MarketSnapshot;
  shipping: Record<string, ShippingRule>; // per-seller overrides
  prefs: BuyPrefs;
}

const key = (setId: string) => `setkeeper:v1:market:${setId}`;
export const DEFAULT_PREFS: BuyPrefs = { mode: "value", conditions: ["NM", "LP"], canadaOnly: false, scope: "all" };

export function loadMarket(setId: string): MarketState {
  try {
    const raw = localStorage.getItem(key(setId));
    if (raw) {
      const m = JSON.parse(raw) as MarketState;
      return { ...m, shipping: m.shipping ?? {}, prefs: { ...DEFAULT_PREFS, ...m.prefs } };
    }
  } catch { /* storage unavailable */ }
  return { source: "none", shipping: {}, prefs: { ...DEFAULT_PREFS } };
}

export function saveMarket(setId: string, m: MarketState): boolean {
  try {
    // scout data is re-fetched each visit, so don't store it
    const toSave = m.source === "scout" ? { ...m, snapshot: undefined, source: "none" } : m;
    localStorage.setItem(key(setId), JSON.stringify(toSave));
    return true;
  } catch {
    return false;
  }
}

/** Snapshot with the collector's shipping edits applied. */
export function withOverrides(m: MarketState): MarketSnapshot | undefined {
  if (!m.snapshot) return undefined;
  return { ...m.snapshot, sellers: m.snapshot.sellers.map((s) => (m.shipping[s.id] ? { ...s, shipping: m.shipping[s.id] } : s)) };
}
