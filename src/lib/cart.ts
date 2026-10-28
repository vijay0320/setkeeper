// Cart optimizer: decides which seller to buy each missing card from, or whether to wait.
//
// It maximises "surplus": the worth of the cards you get minus everything you pay,
// shipping included. A card is worth its market value times a tolerance (set by its
// priority), so:
//   - fifteen $0.50 cards that would need $20 of shipping are deferred (cost > worth),
//   - a $150 card ships even with $5 shipping (worth $172, cost $155),
//   - cheap cards get added to an order when they push it over a free-shipping line.
// In "complete the set" mode every available card is bought and only the cost is minimised.
// The search is a local search (move a card, close a seller, fill an order to its
// free-shipping threshold) from several starting carts; tests compare it to brute force.
import type { Priority } from "./types.ts";
import { type Listing, type MarketSnapshot, type Seller, orderShipping, toCAD } from "./market.ts";
import { landedCost, type Landed, type LandedContext } from "./landed.ts";

export interface Want {
  cardId: string;
  label: string;
  priority: Priority;
  market?: number; // CAD
}

export interface CartOptions {
  usdToCad: number;
  mode: "value" | "complete";
  conditions: string[]; // allowed, e.g. ["NM", "LP"]
  tolerance: number; // pay up to market × tolerance for a normal card (e.g. 1.15)
  scalperAbove: number; // never consider asks above market × this
  onlyCountries?: string[]; // e.g. ["CA"]
  exhaustive?: { best?: number }; // tests only
  /** Optimise on landed cost (tax, FX, duty, border fees) for a buyer in this province. */
  landed?: LandedContext;
}

export interface CartItem {
  cardId: string;
  label: string;
  listing: Listing;
  price: number; // CAD
  shipping: number; // per-listing shipping, CAD
}

export interface Order {
  seller: Seller;
  items: CartItem[];
  subtotal: number;
  shipping: number;
  total: number;
  freeShipping?: { needed: number; saves: number; options: { cardId: string; label: string; price: number }[] };
  landed?: Landed; // when optimising on landed cost: tax, FX and border fees; total includes them
}

export interface CartPlan {
  orders: Order[];
  deferred: { cardId: string; label: string; reason: string }[];
  unavailable: { cardId: string; label: string; reason: string }[];
  cards: number;
  itemsTotal: number;
  shippingTotal: number;
  extrasTotal: number; // tax, FX fees, duty and border fees (landed mode)
  total: number;
  objective: number; // spend minus worth of cards bought (lower is better)
  naiveTotal: number; // same cards, each from its cheapest listing, every seller's shipping paid
  savings: number;
}

const PRIORITY_BOOST: Record<Priority, number> = { chase: 1.3, high: 1.15, normal: 1, low: 0.9 };
const r2 = (n: number) => Math.round(n * 100) / 100;

interface Offer { seller: number; listing: Listing; price: number; ship: number }

export function optimizeCart(wants: Want[], snap: MarketSnapshot, o: CartOptions): CartPlan {
  const sellers = snap.sellers.filter((s) => !o.onlyCountries?.length || o.onlyCountries.includes(s.country));
  const sIndex = new Map(sellers.map((s, i) => [s.id, i]));
  const unavailable: CartPlan["unavailable"] = [];
  const P = o.landed ? o.landed.rules.provinces[o.landed.province] : undefined;
  const homeTax = P ? 1 + (P.hst ?? P.gst ?? 0) + (P.pst ?? 0) : 1;
  const land = (s: number, items: number, ship: number) => landedCost(sellers[s], items, ship, o.landed!);

  // ----- offers per wanted card -----
  const offers: Offer[][] = [];
  const worth: number[] = [];
  const active: Want[] = [];
  for (const w of wants) {
    const all = snap.listings.filter((l) => l.cardId === w.cardId && l.qty > 0 && sIndex.has(l.sellerId)
      && (!l.condition || o.conditions.includes(l.condition)));
    const list: Offer[] = all.map((l) => {
      const s = sellers[sIndex.get(l.sellerId)!];
      return { seller: sIndex.get(l.sellerId)!, listing: l, price: toCAD(l.price, s.currency, o.usdToCad), ship: toCAD(l.shipping ?? 0, s.currency, o.usdToCad) };
    }).filter((x) => w.market == null || x.price <= w.market * o.scalperAbove + 1e-9);
    if (!all.length) { unavailable.push({ cardId: w.cardId, label: w.label, reason: "No seller has it in stock" }); continue; }
    if (!list.length) { unavailable.push({ cardId: w.cardId, label: w.label, reason: `Only listed far above market (${money(w.market!)})` }); continue; }
    // keep the cheapest offer per seller
    const best = new Map<number, Offer>();
    for (const x of list) if (!best.has(x.seller) || x.price + x.ship < best.get(x.seller)!.price + best.get(x.seller)!.ship) best.set(x.seller, x);
    offers.push([...best.values()].sort((a, b) => a.price + a.ship - (b.price + b.ship)));
    const value = w.market ?? offers[offers.length - 1][0].price;
    // in landed mode a card is worth its market price plus the tax you'd pay buying it at home
    worth.push(o.mode === "complete" ? 1e6 : value * homeTax * o.tolerance * PRIORITY_BOOST[w.priority]);
    active.push(w);
  }
  const n = active.length;

  // ----- cost model -----
  const sellerItems = (assign: number[], s: number) => {
    const items: { price: number; shipping: number }[] = [];
    for (let i = 0; i < n; i++) if (assign[i] >= 0 && offers[i][assign[i]].seller === s) items.push({ price: offers[i][assign[i]].price, shipping: offers[i][assign[i]].ship });
    return items;
  };
  const sellerCost = (assign: number[], s: number) => {
    const items = sellerItems(assign, s);
    const sub = items.reduce((a, x) => a + x.price, 0), ship = orderShipping(sellers[s], items, o.usdToCad);
    return o.landed ? land(s, sub, ship).total : sub + ship;
  };
  const objective = (assign: number[]) => {
    let t = 0;
    const used = new Set<number>();
    for (let i = 0; i < n; i++) if (assign[i] >= 0) { used.add(offers[i][assign[i]].seller); t -= worth[i]; }
    for (const s of used) t += sellerCost(assign, s);
    return t;
  };
  const sellerOf = (assign: number[], i: number) => (assign[i] >= 0 ? offers[i][assign[i]].seller : -1);
  if (o.exhaustive) {
    // Test helper: try every combination (tiny inputs only).
    const a = new Array(n).fill(-1);
    let best = Infinity;
    const rec = (i: number) => {
      if (i === n) { best = Math.min(best, objective(a)); return; }
      for (let k = -1; k < offers[i].length; k++) { a[i] = k; rec(i + 1); }
      a[i] = -1;
    };
    rec(0);
    o.exhaustive.best = best;
  }

  // change in objective if want i switches to option k (-1 = don't buy)
  const delta = (assign: number[], i: number, k: number) => {
    const from = sellerOf(assign, i), to = k >= 0 ? offers[i][k].seller : -1;
    const before = (from >= 0 ? sellerCost(assign, from) : 0) + (to >= 0 && to !== from ? sellerCost(assign, to) : 0) - (assign[i] >= 0 ? worth[i] : 0);
    const old = assign[i];
    assign[i] = k;
    const after = (from >= 0 ? sellerCost(assign, from) : 0) + (to >= 0 && to !== from ? sellerCost(assign, to) : 0) - (k >= 0 ? worth[i] : 0);
    assign[i] = old;
    return after - before;
  };

  function improve(assign: number[]): number[] {
    let best = objective(assign);
    for (let round = 0; round < 60; round++) {
      let changed = false;
      // 1. single moves
      for (let i = 0; i < n; i++) {
        let bk = assign[i], bd = -1e-9;
        for (let k = -1; k < offers[i].length; k++) {
          if (k === assign[i]) continue;
          const d = delta(assign, i, k);
          if (d < bd) { bd = d; bk = k; }
        }
        if (bk !== assign[i]) { assign[i] = bk; best += bd; changed = true; }
      }
      // 2. close a seller: send its cards elsewhere (or drop them)
      for (let s = 0; s < sellers.length; s++) {
        const members = [...Array(n).keys()].filter((i) => sellerOf(assign, i) === s);
        if (!members.length) continue;
        const trial = assign.slice();
        for (const i of members) {
          trial[i] = -1;
          let bk = -1, bd = 0;
          for (let k = 0; k < offers[i].length; k++) if (offers[i][k].seller !== s) { const d = delta(trial, i, k); if (d < bd) { bd = d; bk = k; } }
          trial[i] = bk;
        }
        const t = objective(trial);
        if (t < best - 1e-9) { assign.splice(0, n, ...trial); best = t; changed = true; }
      }
      // 3. fill an order up to its free-shipping line
      for (let s = 0; s < sellers.length; s++) {
        const rule = sellers[s].shipping;
        if (rule?.freeOver == null) continue;
        const line = toCAD(rule.freeOver, sellers[s].currency, o.usdToCad);
        const cands = [...Array(n).keys()]
          .map((i) => ({ i, k: offers[i].findIndex((x) => x.seller === s) }))
          .filter((c) => c.k >= 0 && sellerOf(assign, c.i) !== s)
          .sort((a, b) => offers[a.i][a.k].price - offers[b.i][b.k].price);
        if (!cands.length) continue;
        const trial = assign.slice();
        let sub = sellerItems(trial, s).reduce((a, x) => a + x.price, 0);
        let bestTrial: number[] | null = null, bestT = best;
        for (const c of cands) {
          trial[c.i] = c.k;
          sub += offers[c.i][c.k].price;
          if (sub >= line - 1e-9) {
            const t = objective(trial);
            if (t < bestT - 1e-9) { bestT = t; bestTrial = trial.slice(); }
          }
        }
        // also try the most valuable cards first (pushes over the line with fewer, pricier items)
        if (bestTrial) { assign.splice(0, n, ...bestTrial); best = bestT; changed = true; }
      }
      if (!changed) break;
    }
    return assign;
  }

  const starts: number[][] = [
    new Array(n).fill(-1),
    offers.map(() => 0),
  ];
  // one start per seller: buy everything it has, cheapest elsewhere for the rest
  for (let s = 0; s < sellers.length; s++) starts.push(offers.map((of) => { const k = of.findIndex((x) => x.seller === s); return k >= 0 ? k : 0; }));
  let bestAssign = starts[0], bestObj = Infinity;
  for (const st of starts) {
    const a = improve(st.slice());
    const t = objective(a);
    if (t < bestObj - 1e-9) { bestObj = t; bestAssign = a; }
  }

  // ----- build the plan -----
  const orders: Order[] = [];
  for (let s = 0; s < sellers.length; s++) {
    const members = [...Array(n).keys()].filter((i) => sellerOf(bestAssign, i) === s);
    if (!members.length) continue;
    const items: CartItem[] = members.map((i) => {
      const x = offers[i][bestAssign[i]];
      return { cardId: active[i].cardId, label: active[i].label, listing: x.listing, price: r2(x.price), shipping: r2(x.ship) };
    });
    const subtotal = items.reduce((a, x) => a + x.price, 0);
    const shipping = orderShipping(sellers[s], items, o.usdToCad);
    const order: Order = { seller: sellers[s], items, subtotal: r2(subtotal), shipping: r2(shipping), total: r2(subtotal + shipping) };
    if (o.landed) { order.landed = land(s, subtotal, shipping); order.total = order.landed.total; }
    const rule = sellers[s].shipping;
    if (rule?.freeOver != null && shipping - items.reduce((a, x) => a + x.shipping, 0) > 0) {
      const line = toCAD(rule.freeOver, sellers[s].currency, o.usdToCad);
      const options = [...Array(n).keys()].filter((i) => sellerOf(bestAssign, i) !== s)
        .map((i) => ({ i, k: offers[i].findIndex((x) => x.seller === s) })).filter((c) => c.k >= 0)
        .map((c) => ({ cardId: active[c.i].cardId, label: active[c.i].label, price: r2(offers[c.i][c.k].price) }))
        .sort((a, b) => a.price - b.price);
      order.freeShipping = { needed: r2(line - subtotal), saves: r2(shipping - items.reduce((a, x) => a + x.shipping, 0)), options };
    }
    orders.push(order);
  }
  orders.sort((a, b) => b.total - a.total);

  const deferred: CartPlan["deferred"] = [];
  for (let i = 0; i < n; i++) {
    if (bestAssign[i] >= 0) continue;
    const x = offers[i][0];
    const seller = sellers[x.seller];
    const alone = x.price + orderShipping(seller, [{ price: x.price, shipping: x.ship }], o.usdToCad);
    deferred.push({ cardId: active[i].cardId, label: active[i].label,
      reason: alone - x.price > 0.005
        ? `Cheapest is ${money(x.price)} at ${seller.name}, but shipping it alone costs ${money(alone - x.price)}. Wait until you order from ${seller.name} anyway, or a bundle shows up.`
        : `Cheapest ask is ${money(x.price)} at ${seller.name}, above what it's worth (${money(worth[i])}).` });
  }

  const chosen = [...Array(n).keys()].filter((i) => bestAssign[i] >= 0);
  const itemsTotal = orders.reduce((a, x) => a + x.subtotal, 0);
  const shippingTotal = orders.reduce((a, x) => a + x.shipping, 0);
  // naive: each chosen card from its own cheapest listing, paying each seller's shipping
  const naiveAssign = new Array(n).fill(-1);
  for (const i of chosen) {
    let bk = 0;
    for (let k = 1; k < offers[i].length; k++) if (offers[i][k].price < offers[i][bk].price) bk = k;
    naiveAssign[i] = bk;
  }
  let naiveTotal = 0;
  const naiveSellers = new Set(chosen.map((i) => offers[i][naiveAssign[i]].seller));
  for (const s of naiveSellers) naiveTotal += sellerCost(naiveAssign, s);
  const total = r2(orders.reduce((a, x) => a + x.total, 0));
  return {
    orders, deferred, unavailable, cards: chosen.length, objective: bestObj,
    itemsTotal: r2(itemsTotal), shippingTotal: r2(shippingTotal), extrasTotal: r2(total - itemsTotal - shippingTotal), total,
    naiveTotal: r2(naiveTotal), savings: r2(Math.max(0, naiveTotal - total)),
  };
}

function money(n: number) {
  return n.toLocaleString("en-CA", { style: "currency", currency: "CAD" });
}

