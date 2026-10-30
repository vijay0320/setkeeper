export type Status = "have" | "need" | "ordered" | "in-store" | "upgrade";
export type Priority = "chase" | "high" | "normal" | "low";

export interface Card {
  id: string;
  section: string;
  number: string;
  name: string;
  rarity: string;
  note?: string;
  image?: string;
  ref?: string; // card database id when it differs from id
}

export interface CardSet {
  id: string;
  name: string;
  series: string;
  language: string;
  releaseDate: string;
  imageBase: string;
  imageSuffix: string;
  sections: string[];
  rarities: string[];
  sources: string[];
  cards: Card[];
  logo?: string;
}

/** What the collector records about one card. Everything is optional. */
export interface Entry {
  status?: Status;
  priority?: Priority;
  qty?: number;
  store?: string;
  seenOn?: string; // ISO date
  priceSeen?: number; // CAD
  market?: number; // CAD, the collector's own value (overrides the fair value)
  paid?: number; // CAD
  printing?: string; // normal, holofoil, reverse-holofoil… (unset = the card's usual printing)
  condition?: "NM" | "LP" | "MP" | "HP" | "DMG"; // of the copy owned, or wanted (unset = NM)
  sightings?: import("./sightings.ts").Sighting[]; // prices the collector saw at shops, newest first
  notes?: string;
  grade?: { company: string; centering: string; measuredOn: string };
  graded?: {
    psa10?: number; psa9?: number; psa8?: number; condition?: "pristine" | "minor" | "worn";
    values?: Record<string, [number | undefined, number | undefined]>; // slab sale prices per company, CAD: [top grade, next grade]
  };
}

export interface Settings {
  currency: "CAD";
  dealBelow: number; // fraction of market, e.g. 0.9
  overAbove: number; // e.g. 1.15
  scalperAbove: number; // e.g. 1.5
  usdToCad: number;
  budget: number;
  gradingFee: number; // CAD per card
  gradingShip: number; // CAD per card, both ways + insurance
  packPrice: number; // CAD
  resaleShare: number; // share of a duplicate hit's value you'd recover
  /** The collector's own condition discounts (share of NM), overriding measured ones and estimates. */
  conditionFactors?: Partial<Record<"LP" | "MP" | "HP" | "DMG", number>>;
}

export interface Collection {
  version: 1;
  setId: string;
  entries: Record<string, Entry>;
  settings: Settings;
  updatedAt: string;
  packs?: import("./packs.ts").PackSession[];
  packOdds?: Record<string, number>;
  badges?: { label: string; date: string }[];
}

export const STATUS_LABEL: Record<Status, string> = {
  have: "Have",
  need: "Need",
  ordered: "Ordered",
  "in-store": "In store",
  upgrade: "Want upgrade",
};

export const PRIORITY_LABEL: Record<Priority, string> = { chase: "Chase", high: "High", normal: "Normal", low: "Low" };

export const DEFAULT_SETTINGS: Settings = {
  currency: "CAD",
  dealBelow: 0.9,
  overAbove: 1.15,
  scalperAbove: 1.5,
  usdToCad: 1.38,
  budget: 100,
  gradingFee: 30,
  gradingShip: 8,
  packPrice: 6.5,
  resaleShare: 0.5,
};

export const owned = (s?: Status) => s === "have" || s === "upgrade";
export const missing = (s?: Status) => !owned(s) && s !== "ordered";
