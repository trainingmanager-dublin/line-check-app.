/*
 * Shared rules for the line check, used by the screens, the printouts, the
 * Excel export and the tests, so they always agree.
 *
 * A day is stored as { date, tpl, f } where
 *   tpl  = the checklists as they were when the day was started (never changes)
 *   f    = { fieldKey: { v: value, t: timestamp ms } }
 *
 * Every box on the sheet is its own field. When two copies of a day meet
 * (two tabs, a backup being restored), each box keeps whichever value was
 * written last, so nothing typed in one place can wipe out another.
 *
 * Field keys:
 *   L:<item>:am|pm        line check box  { s: "ok"|"no", t: "4.5", c: ["BU"], n: "comment" }
 *   T:<row>:<slot>        temperature sheet box (text)
 *   S:sign:am|pm          sign-off { name, i, at, sig }   (null = not signed / reopened)
 *   S:hist:am|pm          sign-off history [{ a: "sign"|"reopen", name, at }]
 *   P:<photo>             photo reference { on: "<what it belongs to>", at, w, h } (null = deleted)
 */
import {
  TEMPLATE_VERSION, GLOSSARY, LINE_SECTIONS,
  TEMP_FRIDGES, TEMP_HOT, TEMP_DISHWASHER, TEMP_FRYERS, TEMP_GRILL, TEMP_FLAT_TOP,
} from "./line-template.mjs";

export const SHIFTS = ["am", "pm"];
export const SHIFT_NAME = { am: "AM", pm: "PM" };
export const otherShift = (s) => (s === "am" ? "pm" : "am");

export const CODES = [
  ["N", "Need"], ["BU", "Back up needed"], ["X", "Thrown out"], ["P", "Portion device"], ["F", "Flavor profile"],
];

/* Temperature sheet columns: [slot, time, kind, shift] */
export const FRIDGE_SLOTS = [
  ["open", "Opening", "Fridge", "am"],
  ["12i", "12:00", "Item", "am"], ["12f", "12:00", "Fridge", "am"],
  ["16i", "16:00", "Item", "pm"], ["16f", "16:00", "Fridge", "pm"],
  ["20i", "20:00", "Item", "pm"], ["20f", "20:00", "Fridge", "pm"],
  ["close", "Closing", "Fridge", "pm"],
];
export const HOT_SLOTS = [["12", "12:00", "am"], ["16", "16:00", "pm"], ["20", "20:00", "pm"]];
/** Hour each time column is due, for the "due now" marker. */
export const SLOT_HOURS = { open: 9, "12i": 12, "12f": 12, 12: 12, "16i": 16, "16f": 16, 16: 16, "20i": 20, "20f": 20, 20: 20, close: 23 };

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const KEY_RE = /^[LSTP]:[a-z0-9-]{1,80}(:[a-z0-9]{1,8})?$/;
/** Largest value one box may hold (a drawn signature is the biggest, a few KB). */
export const MAX_VALUE_CHARS = 40000;
export const MAX_NAME = 40;

export function isDate(s) {
  return typeof s === "string" && DATE_RE.test(s);
}

export function slug(s) {
  return String(s).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "item";
}

/* ---------- Temperatures ---------- */

/** "41°F/5°C" -> { max: 5 }, "167°F/75°C" -> { min: 75 }, "Room Temp" -> null */
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

/** Tidy a typed reading for storage: "4,5°" -> "4.5". Leaves anything unreadable as typed. */
export function cleanTemp(input) {
  const s = String(input == null ? "" : input).trim();
  const n = parseTemp(s);
  return n == null ? s : String(n);
}

/** "ok", "bad", or null when there is nothing to judge. */
export function judgeTemp(input, limit) {
  const n = parseTemp(input);
  if (n == null || !limit) return null;
  if (limit.max != null && n > limit.max) return "bad";
  if (limit.min != null && n < limit.min) return "bad";
  return "ok";
}

/** Dish washer: wash and rinse readings against { wash, rinse } minimums. */
export function judgeDish(wash, rinse, limit) {
  const w = parseTemp(wash), r = parseTemp(rinse);
  if (w == null && r == null) return null;
  if ((w != null && w < limit.wash) || (r != null && r < limit.rinse)) return "bad";
  return w != null && r != null ? "ok" : null;
}

/** Older days kept the dish washer as one "66/84" box. */
export function dishBad(text, limit) {
  const nums = String(text || "").split(/[/\s]+/).filter(Boolean).map((p) => Number(p.replace(",", "."))).filter((n) => !isNaN(n));
  return nums.length === 2 && (nums[0] < limit.wash || nums[1] < limit.rinse);
}

/**
 * Days saved by the first version kept the dish washer as one "66/84" box per
 * time; split it into the wash and rinse boxes (the original box stays too).
 */
export function upgradeFields(f) {
  for (const [slot] of HOT_SLOTS) {
    const old = f["T:dish:" + slot];
    if (!old || old.v == null) continue;
    const [w, r] = String(old.v).split(/[/\s]+/).filter(Boolean);
    if (w && !f["T:dish:" + slot + "w"]) f["T:dish:" + slot + "w"] = { v: cleanTemp(w), t: old.t };
    if (r && !f["T:dish:" + slot + "r"]) f["T:dish:" + slot + "r"] = { v: cleanTemp(r), t: old.t };
  }
  return f;
}

/** Fryers, grill and flat top: more than 15°C away from the setting is worth a look. */
export const TARGET_TOLERANCE = 15;
export function offTarget(input, target) {
  const n = parseTemp(input);
  return n != null && target != null && Math.abs(n - target) > TARGET_TOLERANCE;
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
export const histKey = (shift) => "S:hist:" + shift;
export const tempKey = (rowId, slot) => "T:" + rowId + ":" + slot;
export const photoKey = (photoId) => "P:" + photoId;
/** What a temperature-row photo belongs to (not a box itself). */
export const tempPhotoTarget = (rowId, shift) => "T:" + rowId + ":" + shift;

export function newPhotoId(now = Date.now()) {
  return "ph-" + now.toString(36) + "-" + Math.floor(Math.random() * 36 ** 4).toString(36).padStart(4, "0");
}

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

/** The smallest stored form of a line box (empty parts left out), or null if empty. */
export function compactLine(v) {
  v = normLine(v);
  if (isLineEmpty(v)) return null;
  const out = {};
  if (v.s) out.s = v.s;
  if (v.t) out.t = v.t;
  if (v.c.length) out.c = v.c;
  if (v.n) out.n = v.n;
  return out;
}

export function initialsOf(name) {
  const parts = String(name || "").trim().split(/[\s.-]+/).filter(Boolean);
  if (!parts.length) return "";
  return parts.map((p) => p[0]).join("").toUpperCase().slice(0, 4);
}

/* ---------- Merging ---------- */

export function validEntry(key, entry) {
  if (!isValidKey(key) || !entry || typeof entry !== "object") return false;
  if (!Number.isFinite(entry.t) || entry.t <= 0) return false;
  const json = JSON.stringify(entry.v === undefined ? null : entry.v);
  return json.length <= MAX_VALUE_CHARS;
}

function newer(a, b) {
  if (!b) return true;
  if (a.t !== b.t) return a.t > b.t;
  // Same millisecond in two places: pick one the same way everywhere.
  return JSON.stringify(a.v) > JSON.stringify(b.v);
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

/* ---------- What each shift has to do ---------- */

const textOf = (record, key) => {
  const v = fieldValue(record, key);
  return v == null ? "" : String(v).trim();
};

/** A row on the temperature sheet counts once it has a name (the blank "Other" rows need one typed in). */
export const rowName = (record, row) => row.name || textOf(record, tempKey(row.id, "name"));

/**
 * Every temperature reading a shift is expected to take:
 * [{ key, rowId, slot, group, label, check(record) -> "ok" | "bad" | null }]
 */
export function tempTasks(record, shift) {
  const T = record.tpl.temps;
  const tasks = [];
  const add = (row, slot, group, label, check) => tasks.push({ key: tempKey(row.id, slot), rowId: row.id, slot, group, label, check });
  for (const row of T.fridges) {
    if (!rowName(record, row)) continue;
    for (const [slot, time, kind, sh] of FRIDGE_SLOTS) {
      if (sh !== shift) continue;
      add(row, slot, "fridges", rowName(record, row) + " - " + time + " " + kind.toLowerCase(),
        (rec) => judgeTemp(textOf(rec, tempKey(row.id, slot)), row.limit));
    }
  }
  for (const row of T.hot) {
    if (!rowName(record, row)) continue;
    for (const [slot, time, sh] of HOT_SLOTS) {
      if (sh !== shift) continue;
      add(row, slot, "hot", rowName(record, row) + " - " + time, (rec) => judgeTemp(textOf(rec, tempKey(row.id, slot)), row.limit));
    }
  }
  for (const [slot, time, sh] of HOT_SLOTS) {
    if (sh !== shift) continue;
    for (const [part, word, min] of [["w", "wash", T.dish.limit.wash], ["r", "rinse", T.dish.limit.rinse]]) {
      add(T.dish, slot + part, "hot", T.dish.name + " - " + time + " " + word, (rec) => judgeTemp(textOf(rec, tempKey("dish", slot + part)), { min }));
    }
  }
  if (shift === "am") {
    for (const f of T.fryers) {
      add(f, "temp", "fryers", f.name + " temperature", (rec) => (offTarget(textOf(rec, tempKey(f.id, "temp")), f.target) ? "check" : null));
      add(f, "tpm", "fryers", f.name + " TPM %", () => null);
    }
  }
  for (const [list, group] of [[T.grill, "grill"], [T.flat, "flat"]]) {
    for (const r of list) add(r, shift, group, (group === "grill" ? "Grill " : "Flat top ") + r.name, (rec) => (offTarget(textOf(rec, tempKey(r.id, shift)), r.target) ? "check" : null));
  }
  return tasks;
}

/** Line check items that need a comment (corrective action) before the shift can be signed. */
export function lineNeedingAction(record, shift) {
  return lineItems(record.tpl).filter((item) => {
    const v = normLine(fieldValue(record, lineKey(item.id, shift)));
    return (v.s === "no" || judgeTemp(v.t, item.limit) === "bad") && !v.n.trim();
  });
}

/** Temperature rows with a reading out of range this shift and no corrective action written. */
export function tempsNeedingAction(record, shift) {
  const out = [];
  const seen = new Set();
  for (const task of tempTasks(record, shift)) {
    if (task.group !== "fridges" && task.group !== "hot") continue;
    if (task.check(record) !== "bad" || seen.has(task.rowId)) continue;
    if (textOf(record, tempKey(task.rowId, "ca"))) continue;
    seen.add(task.rowId);
    out.push(task);
  }
  return out;
}

export function signedBy(record, shift) {
  const s = fieldValue(record, signKey(shift));
  return s && (s.name || s.i) ? s : null;
}

export function shiftProgress(record, shift) {
  const tpl = record.tpl || buildTemplate();
  let done = 0, total = 0, issues = 0;
  for (const item of lineItems(tpl)) {
    total++;
    const v = normLine(fieldValue(record, lineKey(item.id, shift)));
    if (v.s) done++;
    if (v.s === "no" || judgeTemp(v.t, item.limit) === "bad") issues++;
  }
  const tasks = tempTasks(Object.assign({}, record, { tpl }), shift);
  const tempsDone = tasks.filter((t) => textOf(record, t.key)).length;
  const tempIssues = tasks.filter((t) => t.check(record) === "bad").length;
  return {
    done, total, issues,
    temps: { done: tempsDone, total: tasks.length, issues: tempIssues },
    signed: signedBy(record, shift),
  };
}

export function tempsFilled(record) {
  return Object.keys((record && record.f) || {})
    .filter((k) => k.startsWith("T:") && !/:(name|food|ca|notes)$/.test(k) && textOf(record, k)).length;
}

export function photoRefs(record) {
  return Object.entries((record && record.f) || {})
    .filter(([k, e]) => k.startsWith("P:") && e && e.v && e.v.on)
    .map(([k, e]) => Object.assign({ id: k.slice(2) }, e.v));
}

/** Small summary kept next to each saved day so the history list is quick. */
export function summarize(record) {
  const one = (shift) => {
    const p = shiftProgress(record, shift);
    return { d: p.done, n: p.total, i: p.issues + p.temps.issues, td: p.temps.done, tn: p.temps.total, s: p.signed ? p.signed.name || p.signed.i : "" };
  };
  return { v: 2, am: one("am"), pm: one("pm"), photos: photoRefs(record).length };
}

/** "AM: signed by Mary Kelly 11:42, reopened by John Doyle 16:10, signed by …" (only when there's more than one event). */
export function signHistoryText(record, shift) {
  const v = fieldValue(record, histKey(shift));
  if (!Array.isArray(v) || v.length < 2) return "";
  return SHIFT_NAME[shift] + ": " + v.map((e) => (e.a === "reopen" ? "reopened by " : "signed by ") + e.name + " " + timeOf(e.at)).join(", ");
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

export function timeOf(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleTimeString("en-IE", { hour: "2-digit", minute: "2-digit" });
}

export function slashDate(date) {
  const [y, m, d] = date.split("-");
  return d + "/" + m + "/" + y;
}
