// Landed cost: what an order really costs a Canadian collector once it's at the door.
//
//   items + shipping (in the seller's currency)
//   + card foreign-exchange fee on foreign-currency orders
//   + sales tax charged at checkout (Canadian shops, eBay Canada) or
//     + duty, GST/HST and provincial tax assessed at the border (imports)
//     + Canada Post's handling fee or a courier's brokerage fee when tax is due
//
// Rules live in data/landed/rules.json with their sources, so they can be updated
// without code changes. Everything here is an estimate and is labelled as one in the app.

export type Province = "AB" | "BC" | "MB" | "NB" | "NL" | "NS" | "NT" | "NU" | "ON" | "PE" | "QC" | "SK" | "YT";
export interface ProvinceRule { name: string; gst?: number; hst?: number; pst?: number; pstName?: string; pstOnImports?: boolean }
export interface LandedRules {
  checkedAt: string;
  provinces: Record<Province, ProvinceRule>;
  imports: {
    postalExempt: number; courierCusmaTaxExempt: number; courierCusmaDutyExempt: number; courierOtherExempt: number;
    cusmaCountries: string[]; dutyRate: number; canadaPostHandlingFee: number; courierBrokerageMin: number; courierBrokeragePct: number;
  };
  cardFxFeeDefault: number;
  sources: { name: string; url: string }[];
}

/** How a seller's orders reach the buyer and get taxed. */
export interface SellerTax {
  country: string; // ISO code
  currency: "CAD" | "USD" | string;
  province?: Province; // Canadian sellers
  /** "checkout": tax charged when you pay (Canadian shops, eBay for Canadian sellers). "border": assessed on import. */
  taxAt?: "checkout" | "border" | "none";
  carrier?: "post" | "courier"; // imports: how it's usually shipped
  chargesPst?: boolean; // Canadian shop charges your province's PST (default: only when it's in your province)
}

export interface LandedContext { province: Province; rules: LandedRules; fxFee?: number }

export interface Landed {
  items: number; // CAD
  shipping: number; // CAD
  fxFee: number;
  duty: number;
  gstHst: number;
  pst: number;
  fees: number; // handling / brokerage
  total: number;
  lines: { label: string; amount: number }[]; // the non-zero extras, for display
  note?: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Sensible defaults by seller type, used when a seller doesn't say. */
export function taxDefaults(s: SellerTax): Required<Pick<SellerTax, "taxAt" | "carrier">> {
  if (s.country === "CA") return { taxAt: "checkout", carrier: "post" };
  return { taxAt: "border", carrier: "post" };
}

/**
 * Landed cost of one order. `items` and `shipping` are already in CAD; `fxBase` is the part
 * charged in a foreign currency (normally items + shipping for a foreign seller).
 */
export function landedCost(seller: SellerTax, items: number, shipping: number, ctx: LandedContext): Landed {
  const R = ctx.rules, P = R.provinces[ctx.province], I = R.imports;
  const d = taxDefaults(seller);
  const taxAt = seller.taxAt ?? d.taxAt, carrier = seller.carrier ?? d.carrier;
  const foreign = seller.currency !== "CAD";
  const fxFee = foreign ? r2((items + shipping) * (ctx.fxFee ?? R.cardFxFeeDefault)) : 0;
  let duty = 0, gstHst = 0, pst = 0, fees = 0, note: string | undefined;
  const salesTaxName = P.hst ? "HST" : "GST";
  const fed = P.hst ?? P.gst ?? 0;

  if (taxAt === "checkout") {
    // shops and marketplaces charge tax on goods and shipping when you pay
    const base = items + shipping;
    gstHst = r2(base * fed);
    const pstApplies = P.pst && (seller.chargesPst ?? (seller.country === "CA" ? seller.province === ctx.province : true));
    if (pstApplies) pst = r2(base * P.pst!);
  } else if (taxAt === "border") {
    // value for duty is the price of the goods; shipping to the buyer isn't part of it here
    const value = items;
    const cusma = I.cusmaCountries.includes(seller.country);
    let dutyFree: boolean, taxFree: boolean;
    if (carrier === "courier" && cusma) { dutyFree = value <= I.courierCusmaDutyExempt; taxFree = value <= I.courierCusmaTaxExempt; }
    else if (carrier === "courier") { dutyFree = taxFree = value <= I.courierOtherExempt; }
    else { dutyFree = taxFree = value <= I.postalExempt; }
    if (!dutyFree) duty = r2(value * I.dutyRate);
    if (!taxFree) {
      gstHst = r2((value + duty) * fed);
      if (P.pst && P.pstOnImports) pst = r2((value + duty) * P.pst);
    }
    if (duty + gstHst + pst > 0) fees = carrier === "post" ? I.canadaPostHandlingFee : r2(Math.max(I.courierBrokerageMin, value * I.courierBrokeragePct));
    const limit = carrier === "courier" && cusma ? I.courierCusmaTaxExempt : carrier === "courier" ? I.courierOtherExempt : I.postalExempt;
    note = taxFree
      ? `Under the CA$${limit} import limit for ${carrier === "post" ? "mail" : "courier"}: no tax or fees at the border.`
      : `Over the CA$${limit} import limit: tax${fees ? ` and a ${carrier === "post" ? "Canada Post handling" : "brokerage"} fee` : ""} due on delivery.`;
  }

  const lines: Landed["lines"] = [];
  if (fxFee) lines.push({ label: "Card FX fee", amount: fxFee });
  if (duty) lines.push({ label: "Duty", amount: duty });
  if (gstHst) lines.push({ label: salesTaxName, amount: gstHst });
  if (pst) lines.push({ label: P.pstName ?? "PST", amount: pst });
  if (fees) lines.push({ label: carrier === "post" ? "Canada Post handling" : "Courier brokerage", amount: fees });
  const total = r2(items + shipping + fxFee + duty + gstHst + pst + fees);
  return { items: r2(items), shipping: r2(shipping), fxFee, duty, gstHst, pst, fees, total, lines, ...(note ? { note } : {}) };
}

/** Largest order value (CAD) that stays under the import limit for this seller, if one applies. */
export function importLimit(seller: SellerTax, rules: LandedRules): number | undefined {
  const d = taxDefaults(seller);
  if ((seller.taxAt ?? d.taxAt) !== "border") return undefined;
  const carrier = seller.carrier ?? d.carrier, I = rules.imports;
  if (carrier === "courier") return I.cusmaCountries.includes(seller.country) ? I.courierCusmaTaxExempt : I.courierOtherExempt;
  return I.postalExempt;
}

export const PROVINCES: Province[] = ["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"];
