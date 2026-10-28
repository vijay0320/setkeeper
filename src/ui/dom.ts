// Tiny DOM helper used across the UI.
export type Attrs = Record<string, unknown>;
export type Kid = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: Kid[]) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else if (k === "class") el.className = String(v);
    else if (k === "html") el.innerHTML = String(v);
    else if (k in el && typeof v !== "string") (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  // Buttons don't submit forms (or close dialogs) unless asked to; close buttons keep value="close".
  if (tag === "button" && attrs.type == null && attrs.value !== "close") (el as HTMLButtonElement).type = "button";
  for (const kid of kids) if (kid != null && kid !== false) el.append(kid);
  return el;
}

export const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
