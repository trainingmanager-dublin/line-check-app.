/*
 * Saving on the tablet. Every tap is written to the tablet's storage
 * (localStorage) before anything else happens, so a check survives the page
 * being closed, the browser crashing or the battery dying. Open the app again
 * and it carries on exactly where it was.
 *
 * Stored:
 *   lc:day:2026-10-11  -> { date, tplId, f: { fieldKey: { v, t } }, savedAt }
 *   lc:tpl:<id>        -> the checklists a day was started with
 */
import { buildTemplate, mergeFields, isDate, summarize } from "./core.mjs";

const DAY = "lc:day:";
const TPL = "lc:tpl:";

let memoryOnly = null; // used only if the browser blocks storage

export const local = {
  get(key) {
    try { return memoryOnly ? memoryOnly.get(key) ?? null : localStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    if (memoryOnly) { memoryOnly.set(key, value); return true; }
    try { localStorage.setItem(key, value); return true; } catch { return false; }
  },
  remove(key) {
    try { if (memoryOnly) memoryOnly.delete(key); else localStorage.removeItem(key); } catch { /* ignore */ }
  },
  keys() {
    try { return memoryOnly ? [...memoryOnly.keys()] : Object.keys(localStorage); } catch { return []; }
  },
};

try {
  localStorage.setItem("lc:probe", "1");
  localStorage.removeItem("lc:probe");
} catch {
  memoryOnly = new Map();
}
export const storageWorks = () => !memoryOnly;

/** Ask the browser not to clear our storage when the tablet runs low on space. */
export function askToKeepStorage() {
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); } catch { /* ignore */ }
}

function hash(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function saveTemplate(tpl) {
  const text = JSON.stringify(tpl);
  const id = tpl.version + "-" + hash(text);
  if (!local.get(TPL + id)) local.set(TPL + id, text);
  return id;
}

function loadTemplate(id) {
  try { return JSON.parse(local.get(TPL + id) || "null"); } catch { return null; }
}

function readDay(date) {
  try {
    const d = JSON.parse(local.get(DAY + date) || "null");
    if (d && d.date === date && d.f && typeof d.f === "object") return d;
  } catch { /* damaged: treat as a new day */ }
  return null;
}

export function savedDates() {
  return local.keys().filter((k) => k.startsWith(DAY)).map((k) => k.slice(DAY.length)).filter(isDate).sort();
}

/** A full day ({ date, tpl, f }) as stored, or null. */
export function loadDay(date) {
  const d = readDay(date);
  if (!d) return null;
  return { date, tpl: loadTemplate(d.tplId) || buildTemplate(), f: d.f, savedAt: d.savedAt };
}

export function daySummaries(month) {
  return savedDates().filter((d) => d.startsWith(month)).map((date) => {
    const rec = loadDay(date);
    return rec && Object.keys(rec.f).length ? { date, summary: summarize(rec) } : null;
  }).filter(Boolean).reverse();
}

/** Remove the oldest saved day (never `keep`). Returns its date or null. */
function dropOldest(keep) {
  const oldest = savedDates().find((d) => d !== keep);
  if (!oldest) return null;
  local.remove(DAY + oldest);
  return oldest;
}

/**
 * hooks.onChange(keys) - the same day was changed in another tab
 * hooks.onStatus({ state: "saved" | "error", savedAt, message })
 * hooks.onDropped(date) - storage was full and the oldest day was removed
 */
export function createStore(hooks) {
  let day = null;
  let lastT = 0;
  let status = { state: "saved", savedAt: null, message: "" };

  function setStatus(s) { status = s; hooks.onStatus(status); }

  function write() {
    const text = JSON.stringify({ date: day.date, tplId: day.tplId, f: day.f, savedAt: new Date().toISOString() });
    for (let tries = 0; tries < 20; tries++) {
      if (local.set(DAY + day.date, text)) {
        setStatus({ state: "saved", savedAt: new Date(), message: "" });
        return true;
      }
      const dropped = dropOldest(day.date);
      if (!dropped) break;
      hooks.onDropped(dropped);
    }
    setStatus({ state: "error", savedAt: status.savedAt, message: "The tablet's storage is full or blocked, so this entry was NOT saved. Keep this page open and print or download the sheet now." });
    return false;
  }

  function open(date) {
    const stored = readDay(date);
    const tpl = (stored && loadTemplate(stored.tplId)) || buildTemplate();
    day = { date, tpl, tplId: stored ? stored.tplId : saveTemplate(tpl), f: stored ? stored.f : {} };
    if (stored && !loadTemplate(stored.tplId)) day.tplId = saveTemplate(tpl);
    setStatus({ state: "saved", savedAt: stored && stored.savedAt ? new Date(stored.savedAt) : null, message: "" });
    return day;
  }

  /** Change one box. It is on the tablet before this returns. */
  function set(key, value) {
    if (!day) return false;
    const t = Math.max(Date.now(), lastT + 1);
    lastT = t;
    day.f[key] = { v: value, t };
    return write();
  }

  // The same day open in a second tab: merge, box by box, newest wins.
  window.addEventListener("storage", (e) => {
    if (!day || e.key !== DAY + day.date || !e.newValue) return;
    let other;
    try { other = JSON.parse(e.newValue); } catch { return; }
    if (!other || !other.f) return;
    const merged = mergeFields(day.f, other.f);
    day.f = merged.fields;
    if (merged.changed.length) hooks.onChange(merged.changed);
  });

  return { open, set, current: () => day, status: () => status };
}

/* ---------- Backup (moving to a new tablet, or just to be safe) ---------- */

export function backupJson() {
  const days = {};
  for (const date of savedDates()) {
    const rec = loadDay(date);
    if (rec) days[date] = rec;
  }
  return JSON.stringify({ app: "hard-rock-line-check", exportedAt: new Date().toISOString(), days });
}

/** Merge a backup into the tablet. Returns the number of days restored. */
export function restoreBackup(text) {
  const data = JSON.parse(text);
  if (!data || data.app !== "hard-rock-line-check" || typeof data.days !== "object") throw new Error("This isn't a line check backup file.");
  let count = 0;
  for (const [date, rec] of Object.entries(data.days)) {
    if (!isDate(date) || !rec || typeof rec.f !== "object") continue;
    const existing = readDay(date);
    const merged = mergeFields(existing ? existing.f : {}, rec.f);
    const tplId = existing && loadTemplate(existing.tplId) ? existing.tplId
      : rec.tpl && Array.isArray(rec.tpl.line) ? saveTemplate(rec.tpl) : saveTemplate(buildTemplate());
    if (!local.set(DAY + date, JSON.stringify({ date, tplId, f: merged.fields, savedAt: new Date().toISOString() }))) {
      throw new Error("The tablet ran out of space after " + count + " days.");
    }
    count++;
  }
  return count;
}
