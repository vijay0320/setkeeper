// Import from / export to spreadsheets (CSV for Google Sheets, .xlsx, JSON backup).
import type { Card, CardSet, Collection, Entry, Priority, Status } from "./types.ts";
import { DEFAULT_SETTINGS, PRIORITY_LABEL, STATUS_LABEL } from "./types.ts";
import { checkPrice, priorityOf, VERDICT_LABEL } from "./pricing.ts";
import { readXlsx, excelDate, type Cell } from "./xlsx.ts";

export function parseStatus(v: unknown): Status | undefined {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return undefined;
  if (s.startsWith("have") || s === "owned" || s === "yes" || s === "true") return "have";
  if (s.includes("upgrade")) return "upgrade";
  if (s.startsWith("order")) return "ordered";
  if (s.includes("store") || s.includes("stock")) return "in-store";
  if (s.startsWith("need") || s === "no" || s === "false" || s === "missing") return "need";
  return undefined;
}

export function parsePriority(v: unknown): Priority | undefined {
  const s = String(v ?? "").trim().toLowerCase();
  return (["chase", "high", "normal", "low"] as const).find((p) => s === p);
}

const num = (v: unknown): number | undefined => {
  if (v == null || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : undefined;
};

// Notes our own spreadsheet exports add automatically; not worth importing.
const GENERATED_NOTES = /^(no official image|rgb mew \(no official image\)|30-artist pikachu|futuristic rare)$/i;

const HEADERS: Record<string, RegExp> = {
  section: /^section$/i,
  number: /^card\s*#|^number$|^no\.?$/i,
  name: /^name$/i,
  status: /^status$|^owned$/i,
  priority: /^priority$/i,
  qty: /^qty|quantity/i,
  store: /^store|^seller/i,
  seenOn: /^date seen|^seen on/i,
  priceSeen: /^price seen|^target price|^asking/i,
  market: /^market/i,
  paid: /^paid/i,
  notes: /notes$/i,
};

function parseDate(v: Cell): string | undefined {
  if (v == null || v === "") return undefined;
  if (typeof v === "number") return v > 30000 && v < 80000 ? excelDate(v) : undefined;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
}

/** Store names typed like "Hobbiesville (October 27)" become store + date. */
function splitStore(store: string, year: number): { store: string; seenOn?: string } {
  const m = store.match(/^\s*(.*?)\s*\((.+)\)\s*$/);
  if (!m) return { store: store.trim() };
  const d = new Date(`${m[2]} ${year}`);
  return Number.isNaN(d.getTime()) ? { store: store.trim() } : { store: m[1], seenOn: d.toISOString().slice(0, 10) };
}

export interface ImportResult { entries: Record<string, Entry>; matched: number; unmatched: string[] }

/** Map rows from any tracker sheet onto the set's cards by section + card number. */
export function importRows(set: CardSet, rows: Cell[][]): ImportResult {
  const hi = rows.findIndex((r) => r.some((c) => HEADERS.number.test(String(c ?? ""))) && r.some((c) => HEADERS.status.test(String(c ?? ""))));
  if (hi < 0) throw new Error('Could not find a header row with "Card #" and "Status" columns.');
  const header = rows[hi].map((c) => String(c ?? "").trim());
  const col: Partial<Record<keyof typeof HEADERS, number>> = {};
  for (const [k, re] of Object.entries(HEADERS)) {
    const i = header.findIndex((h) => re.test(h));
    if (i >= 0 && col[k as keyof typeof HEADERS] == null) col[k as keyof typeof HEADERS] = i;
  }
  const year = new Date(set.releaseDate).getUTCFullYear();
  const bySecNum = new Map(set.cards.map((c) => [`${c.section}|${c.number}`, c]));
  const byNum = new Map<string, Card[]>();
  for (const c of set.cards) byNum.set(c.number, [...(byNum.get(c.number) ?? []), c]);
  const energyQueue = set.cards.filter((c) => c.number === "—");
  const entries: Record<string, Entry> = {};
  const unmatched: string[] = [];
  let energyIdx = 0;
  for (const r of rows.slice(hi + 1)) {
    const get = (k: keyof typeof HEADERS) => (col[k] != null ? r[col[k]!] : undefined);
    const number = String(get("number") ?? "").trim();
    if (!number) continue;
    const section = String(get("section") ?? "").trim();
    let card = number === "—" || number === "-"
      ? energyQueue[energyIdx++]
      : bySecNum.get(`${section}|${number}`) ?? (byNum.get(number)?.length === 1 ? byNum.get(number)![0] : undefined);
    if (!card) { unmatched.push(`${section} ${number}`.trim()); continue; }
    const e: Entry = {};
    const status = parseStatus(get("status"));
    if (status) e.status = status;
    const prio = parsePriority(get("priority"));
    if (prio) e.priority = prio;
    const qty = num(get("qty")); if (qty != null) e.qty = qty;
    const storeRaw = String(get("store") ?? "").trim();
    if (storeRaw) Object.assign(e, splitStore(storeRaw, year));
    const seen = parseDate(get("seenOn") as Cell); if (seen) e.seenOn = seen;
    const ps = num(get("priceSeen")); if (ps != null) e.priceSeen = ps;
    const mk = num(get("market")); if (mk != null) e.market = mk;
    const pd = num(get("paid")); if (pd != null) e.paid = pd;
    const notes = String(get("notes") ?? "").split(";").map((x) => x.trim())
      .filter((x) => x && !GENERATED_NOTES.test(x)).join("; ");
    if (notes) e.notes = notes;
    entries[card.id] = e;
  }
  return { entries, matched: Object.keys(entries).length, unmatched };
}

export function parseCSV(text: string): Cell[][] {
  const rows: Cell[][] = [];
  let row: Cell[] = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cur); cur = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cur); rows.push(row); row = []; cur = "";
    } else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

export async function importFile(set: CardSet, name: string, data: ArrayBuffer): Promise<ImportResult & { source: string }> {
  if (/\.json$/i.test(name)) {
    const c = JSON.parse(new TextDecoder().decode(data)) as Collection;
    if (!c.entries) throw new Error("This JSON file is not a SetKeeper backup.");
    return { entries: c.entries, matched: Object.keys(c.entries).length, unmatched: [], source: "backup" };
  }
  if (/\.xlsx$/i.test(name)) {
    const sheets = await readXlsx(data);
    for (const s of sheets) {
      try { return { ...importRows(set, s.rows), source: `sheet "${s.name}"` }; } catch { /* try next sheet */ }
    }
    throw new Error('No sheet has "Card #" and "Status" columns.');
  }
  return { ...importRows(set, parseCSV(new TextDecoder().decode(data))), source: "CSV" };
}

const csvCell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** CSV that opens cleanly in Google Sheets (File → Import) or Excel. */
export function exportCSV(set: CardSet, c: Collection): string {
  const head = ["Section", "Card #", "Name", "Rarity", "Priority", "Status", "Qty", "Store", "Date Seen",
    "Price Seen (CAD)", "Market Value (CAD)", "Price Check", "Paid (CAD)", "Notes", "Image"];
  const lines = [head.join(",")];
  for (const card of set.cards) {
    const e = c.entries[card.id] ?? {};
    const pc = checkPrice(e.priceSeen, e.market, c.settings ?? DEFAULT_SETTINGS);
    lines.push([card.section, card.number, card.name, card.rarity, PRIORITY_LABEL[priorityOf(card, e)],
      STATUS_LABEL[e.status ?? "need"], e.qty ?? "", e.store ?? "", e.seenOn ?? "", e.priceSeen ?? "", e.market ?? "",
      pc.verdict === "unknown" ? "" : VERDICT_LABEL[pc.verdict], e.paid ?? "", e.notes ?? "",
      card.image ? set.imageBase + card.image + set.imageSuffix : ""].map(csvCell).join(","));
  }
  return lines.join("\n");
}
