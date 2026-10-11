/*
 * Shared rules for the line check: used by the page, the Netlify function and
 * the tests, so all three always agree.
 *
 * A day is stored as { date, tpl, f } where
 *   tpl  = the checklists as they were when the day was started (never changes)
 *   f    = { fieldKey: { v: value, t: timestamp ms, by: initials } }
 *
 * Every box on the sheet is its own field, so the AM and PM managers (or two
 * tablets at once) can never overwrite each other's work: when two copies of a
 * day meet, each box keeps whichever value was written last.
 */
import {
  TEMPLATE_VERSION, GLOSSARY, LINE_SECTIONS,
  TEMP_FRIDGES, TEMP_HOT, TEMP_DISHWASHER, TEMP_FRYERS, TEMP_GRILL, TEMP_FLAT_TOP,
} from "./line-template.mjs";

export const SHIFTS = ["am", "pm"];
export const CODES = [
  ["N", "Need"], ["BU", "Back up needed"], ["X", "Thrown out"], ["P", "Portion device"], ["F", "Flavor profile"],
];
export const FRIDGE_SLOTS = [
  ["open", "Opening", "Fridge", "am"],
  ["12i", "12:00", "Item", "am"], ["12f", "12:00", "Fridge", "am"],
  ["16i", "16:00", "Item", "pm"], ["16f", "16:00", "Fridge", "pm"],
  ["20i", "20:00", "Item", "pm"], ["20f", "20:00", "Fridge", "pm"],
  ["close", "Closing", "Fridge", "pm"],
];
export const HOT_SLOTS = [["12", "12:00", "am"], ["16", "16:00", "pm"], ["20", "20:00", "pm"]];

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const KEY_RE = /^[LST]:[a-z0-9-]{1,80}(:[a-z0-9]{1,8})?$/;
export const MAX_VALUE_CHARS = 2000;
export const MAX_INITIALS = 12;

export function isDate(s) {
  return typeof s === "string" && DATE_RE.test(s);
}

export function slug(s) {
  return String(s).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "item";
}

/* ---------- Temperatures ---------- */

/** "41°F/5° C" -> { max: 5 }, "167°F/75°C" -> { min: 75 }, "Room Temp" -> null */
export function limitFromText(text) {
  const m = /(-?\d+(?:[.,]\d+)?)\s*°\s*C/i.exec(String(text || ""));
  if (!m) return null;
  const c = Number(m[1].replace(",", "."));
  return c >= 60 ? { min: c } : { max: c };
}

/** Reads what a manager typed: "4", "4.5", "4,5", "-18", "-18°". Returns a number or null. */
export function parseTemp(input) {
  if (input == null) return null;
  const s = String(input).trim().replace(",", ".").replace(/°\s*c?$/i, "").trim();
  if (!/^[-+]?\d{1,3}(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  return n >= -60 && n <= 400 ? n : null;
}

/** "ok", "bad", or null when there is nothing to judge. */
export function judgeTemp(input, limit) {
  const n = parseTemp(input);
  if (n == null || !limit) return null;
  if (limit.max != null && n > limit.max) return "bad";
  if (limit.min != null && n < limit.min) return "bad";
  return "ok";
}

/** Dish washer reading "wash/rinse", e.g. "66/84": true if either is too low. */
export function dishBad(text, limit) {
  const nums = String(text || "").split(/[/\s]+/).filter(Boolean).map((p) => Number(p.replace(",", "."))).filter((n) => !isNaN(n));
  return nums.length === 2 && (nums[0] < limit.wash || nums[1] < limit.rinse);
}

export function limitLabel(limit) {
  if (!limit) return "";
  if (limit.max != null) return "≤ " + limit.max + "°C";
  if (limit.min != null) return "≥ " + limit.min + "°C";
  return "";
}

/* ---------- The checklists, with stable ids ---------- */

function uniqueIds() {
  const seen = new Map();
  return (base) => {
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : base + "-" + n;
  };
}

/** The checklists in the shape a day keeps a copy of. */
export function buildTemplate() {
  const lineId = uniqueIds();
  const line = LINE_SECTIONS.map((section) => ({
    name: section.name,
    columns: section.columns,
    items: section.items.map(([name, temp, life, utensil, quality]) => ({
      id: lineId(slug(section.name).slice(0, 12) + "-" + slug(name)),
      name, temp, life, utensil, quality,
      limit: limitFromText(temp),
    })),
  }));
  const rowId = uniqueIds();
  const row = (prefix, name) => rowId(prefix + "-" + (name ? slug(name) : "other"));
  return {
    version: TEMPLATE_VERSION,
    glossary: GLOSSARY,
    line,
    temps: {
      fridges: TEMP_FRIDGES.map(([name, limit]) => ({ id: row("fr", name), name, limit })),
      hot: TEMP_HOT.map(([name, limit]) => ({ id: row("hot", name), name, limit })),
      dish: { id: "dish", name: TEMP_DISHWASHER[0], label: TEMP_DISHWASHER[1], limit: TEMP_DISHWASHER[2] },
      fryers: TEMP_FRYERS.map(([name, target, use]) => ({ id: row("fry", name), name, target, use })),
      grill: TEMP_GRILL.map(([name, target]) => ({ id: row("grill", name), name, target })),
      flat: TEMP_FLAT_TOP.map(([name, target]) => ({ id: row("flat", name), name, target })),
    },
  };
}

export function lineItems(tpl) {
  return tpl.line.flatMap((s) => s.items);
}

/* ---------- Field keys ---------- */

export const lineKey = (itemId, shift) => "L:" + itemId + ":" + shift;
export const signKey = (shift) => "S:sign:" + shift;
export const tempKey = (rowId, slot) => "T:" + rowId + ":" + slot;

export function isValidKey(key) {
  return typeof key === "string" && KEY_RE.test(key);
}

/** A line check box: { s: "ok" | "no" | "", t: temp text, c: [codes], n: comment } */
export function normLine(v) {
  v = v && typeof v === "object" ? v : {};
  return {
    s: v.s === "ok" || v.s === "no" ? v.s : "",
    t: typeof v.t === "string" ? v.t : "",
    c: Array.isArray(v.c) ? v.c.filter((c) => CODES.some(([k]) => k === c)) : [],
    n: typeof v.n === "string" ? v.n : "",
  };
}

export function isLineEmpty(v) {
  v = normLine(v);
  return !v.s && !v.t && !v.c.length && !v.n;
}

/* ---------- Merging ---------- */

export function validEntry(key, entry) {
  if (!isValidKey(key) || !entry || typeof entry !== "object") return false;
  if (!Number.isFinite(entry.t) || entry.t <= 0) return false;
  if (entry.by != null && (typeof entry.by !== "string" || entry.by.length > MAX_INITIALS)) return false;
  const json = JSON.stringify(entry.v === undefined ? null : entry.v);
  return json.length <= MAX_VALUE_CHARS;
}

function newer(a, b) {
  if (!b) return true;
  if (a.t !== b.t) return a.t > b.t;
  // Same millisecond on two devices: pick one the same way everywhere.
  return JSON.stringify([a.v, a.by]) > JSON.stringify([b.v, b.by]);
}

/**
 * Merge incoming fields into base (both { key: entry }). Returns the merged
 * fields and the keys whose value changed. Invalid entries are ignored.
 */
export function mergeFields(base, incoming) {
  const fields = Object.assign({}, base || {});
  const changed = [];
  for (const [key, entry] of Object.entries(incoming || {})) {
    if (!validEntry(key, entry)) continue;
    if (newer(entry, fields[key])) {
      const clean = { v: entry.v === undefined ? null : entry.v, t: entry.t };
      if (entry.by) clean.by = entry.by;
      if (!fields[key] || JSON.stringify(fields[key].v) !== JSON.stringify(clean.v)) changed.push(key);
      fields[key] = clean;
    }
  }
  return { fields, changed };
}

export function fieldValue(record, key) {
  const e = record && record.f && record.f[key];
  return e ? e.v : null;
}

/* ---------- Progress ---------- */

export function shiftProgress(record, shift) {
  const tpl = record.tpl || buildTemplate();
  let done = 0, total = 0, issues = 0;
  for (const item of lineItems(tpl)) {
    total++;
    const v = normLine(fieldValue(record, lineKey(item.id, shift)));
    if (v.s) done++;
    if (v.s === "no" || judgeTemp(v.t, item.limit) === "bad") issues++;
  }
  const sign = fieldValue(record, signKey(shift));
  return { done, total, issues, signed: sign && sign.i ? sign : null };
}

export function tempsFilled(record) {
  return Object.keys((record && record.f) || {}).filter((k) => k.startsWith("T:") && fieldValue(record, k) !== "" && fieldValue(record, k) != null).length;
}

/** Small summary kept next to each saved day so the history list is quick. */
export function summarize(record) {
  const am = shiftProgress(record, "am");
  const pm = shiftProgress(record, "pm");
  const sig = (p) => (p.signed ? p.signed.i : "");
  return {
    am: [am.done, am.total, am.issues, sig(am)],
    pm: [pm.done, pm.total, pm.issues, sig(pm)],
    temps: tempsFilled(record),
  };
}

/* ---------- Dates & shifts ---------- */

const pad = (n) => String(n).padStart(2, "0");
export function isoDate(d) {
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

/** The trading day: anything before 5am still belongs to the night before. */
export function tradingDate(now = new Date()) {
  const d = new Date(now.getTime());
  if (d.getHours() < 5) d.setDate(d.getDate() - 1);
  return isoDate(d);
}

/** AM until 3pm, PM after (and through the night until 5am). */
export function currentShift(now = new Date()) {
  const h = now.getHours();
  return h >= 5 && h < 15 ? "am" : "pm";
}

export function addDays(date, n) {
  const [y, m, d] = date.split("-").map(Number);
  return isoDate(new Date(y, m - 1, d + n));
}

export function prettyDate(date, opts) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-IE", opts || { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}
