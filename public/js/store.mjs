/*
 * Saving on the tablet.
 *
 * 1. Every tap is written to localStorage before anything else happens
 *    (synchronous, so it survives the page closing, a crash or a flat
 *    battery). Each write first re-reads the stored copy and merges it box by
 *    box, so a second tab can never wipe out the first one's work.
 * 2. A moment later the day is copied into the IndexedDB archive, which has
 *    room for years of days and the photos. localStorage only keeps the last
 *    few weeks; older days are dropped from it once they're safely archived.
 *
 * localStorage:
 *   lc:day:2026-10-11  -> { date, tplId, f: { key: { v, t } }, savedAt }
 *   lc:tpl:<id>        -> the checklists a day was started with
 */
import { buildTemplate, mergeFields, isDate, summarize, addDays, tradingDate, upgradeFields } from "./core.mjs";
import { openDb, wrap, archiveOver } from "./db.mjs";

const DAY = "lc:day:";
const TPL = "lc:tpl:";
/** Days kept in localStorage (the working copy); everything is also archived. */
export const KEEP_LOCAL_DAYS = 21;
const BACKUP_APP = "hard-rock-line-check";

let memoryOnly = null; // only if the browser blocks storage completely

export const local = {
  get(key) {
    try { return memoryOnly ? (memoryOnly.has(key) ? memoryOnly.get(key) : null) : localStorage.getItem(key); } catch { return null; }
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
  try { if (navigator.storage && navigator.storage.persist) return navigator.storage.persist().catch(() => false); } catch { /* ignore */ }
  return Promise.resolve(false);
}

export async function storageUsage() {
  try { return navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null; } catch { return null; }
}

function hash(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function templateId(tpl) {
  return tpl.version + "-" + hash(JSON.stringify(tpl));
}

function saveTemplateLocal(tpl, id) {
  id = id || templateId(tpl);
  if (!local.get(TPL + id)) local.set(TPL + id, JSON.stringify(tpl));
  return id;
}

function loadTemplateLocal(id) {
  try { return id ? JSON.parse(local.get(TPL + id) || "null") : null; } catch { return null; }
}

function readLocal(date) {
  try {
    const d = JSON.parse(local.get(DAY + date) || "null");
    if (d && d.date === date && d.f && typeof d.f === "object") return d;
  } catch { /* damaged copy: the archive or a fresh day takes over */ }
  return null;
}

export function localDates() {
  return local.keys().filter((k) => k.startsWith(DAY)).map((k) => k.slice(DAY.length)).filter(isDate).sort();
}

/** Old-format line boxes ({ s, t: "", c: [], n: "" }) take twice the room; store them small. */
function compactFields(f) {
  for (const e of Object.values(f)) {
    const v = e && e.v;
    if (v && typeof v === "object" && !Array.isArray(v) && "s" in v && "c" in v) {
      for (const k of ["t", "n"]) if (v[k] === "") delete v[k];
      if (Array.isArray(v.c) && !v.c.length) delete v.c;
      if (v.s === "") delete v.s;
    }
  }
  return f;
}

/**
 * hooks.onChange(keys)      boxes changed elsewhere (another tab) - redraw them
 * hooks.onStatus(status)    { state: "saved" | "error", savedAt, message }
 * hooks.onDropped(date)     storage was full and a day that was NOT archived had to go
 * opts.archive              archive to use (tests); default: IndexedDB if available
 */
export function createStore(hooks, opts = {}) {
  let day = null;
  let lastT = 0;
  let status = { state: "saved", savedAt: null, message: "" };
  const archiveTimers = new Map();
  const archivedAt = new Map(); // date -> savedAt known to be in the archive
  let archive = null;
  const archiveReady = ("archive" in opts ? Promise.resolve(opts.archive) : openDb().then((db) => (db ? archiveOver(wrap(db)) : null)))
    .then((a) => { archive = a; return a; }, () => null);

  function setStatus(s) { status = s; hooks.onStatus(status); }

  function templateFor(id) {
    return loadTemplateLocal(id);
  }

  /** The checklists for a stored day: local copy, else the archive's. */
  async function templateOf(tplId) {
    let tpl = templateFor(tplId);
    if (!tpl && archive && tplId) {
      try { tpl = await archive.getTemplate(tplId); } catch { tpl = null; }
      if (tpl) saveTemplateLocal(tpl, tplId);
    }
    return tpl;
  }

  /**
   * Open a day. Today's sheet (already in localStorage) opens straight away;
   * the archive is only waited for when the day isn't on hand locally.
   */
  async function open(date) {
    let stored = readLocal(date);
    if (!stored) {
      await archiveReady;
      if (archive) {
        let archived = null;
        try { archived = await archive.getDay(date); } catch { archived = null; }
        if (archived) {
          stored = { date, tplId: archived.tplId, f: archived.f, savedAt: archived.savedAt };
          if (archived.savedAt) archivedAt.set(date, archived.savedAt);
        }
      }
    }
    let tpl = stored ? await templateOf(stored.tplId) : null;
    if (!tpl) tpl = buildTemplate();
    const tplId = stored && stored.tplId && templateFor(stored.tplId) ? stored.tplId : saveTemplateLocal(tpl);
    day = { date, tpl, tplId, f: upgradeFields(compactFields(stored ? stored.f : {})) };
    if (stored) write(false);
    setStatus({ state: "saved", savedAt: stored && stored.savedAt ? new Date(stored.savedAt) : null, message: "" });
    // A day that was in localStorage may still have boxes only the archive has (e.g. restored there).
    if (readLocal(date)) {
      archiveReady.then(async () => {
        if (!archive || !day || day.date !== date) return;
        let archived = null;
        try { archived = await archive.getDay(date); } catch { return; }
        if (!archived || !day || day.date !== date) return;
        archivedAt.set(date, archived.savedAt);
        const merged = mergeFields(day.f, archived.f);
        if (merged.changed.length) { day.f = merged.fields; write(false); hooks.onChange(merged.changed); }
      });
    }
    return day;
  }

  /** Free localStorage space: archived days first; a non-archived day only as a last resort. */
  function freeSpace(keep) {
    const others = localDates().filter((d) => d !== keep);
    const safe = others.find((d) => archivedAt.has(d) && (readLocal(d) || {}).savedAt <= archivedAt.get(d));
    if (safe) { local.remove(DAY + safe); dropUnusedTemplates(); return true; }
    if (others.length) {
      local.remove(DAY + others[0]);
      dropUnusedTemplates();
      if (!archive || !archivedAt.has(others[0])) hooks.onDropped(others[0]);
      return true;
    }
    return dropUnusedTemplates();
  }

  function dropUnusedTemplates() {
    const used = new Set(localDates().map((d) => (readLocal(d) || {}).tplId));
    if (day) used.add(day.tplId);
    let freed = false;
    for (const k of local.keys()) {
      if (k.startsWith(TPL) && !used.has(k.slice(TPL.length)) && archive) { local.remove(k); freed = true; }
    }
    return freed;
  }

  /** Write the open day: merge in whatever another tab saved, then store. */
  function write(report = true) {
    const stored = readLocal(day.date);
    if (stored) {
      const merged = mergeFields(day.f, stored.f);
      day.f = merged.fields;
      if (merged.changed.length && report) queueMicrotask(() => hooks.onChange(merged.changed));
    }
    const savedAt = new Date().toISOString();
    const text = JSON.stringify({ date: day.date, tplId: day.tplId, f: day.f, savedAt });
    for (let tries = 0; tries < 30; tries++) {
      if (local.set(DAY + day.date, text)) {
        if (report) setStatus({ state: "saved", savedAt: new Date(savedAt), message: "" });
        scheduleArchive(day.date);
        return true;
      }
      if (!freeSpace(day.date)) break;
    }
    setStatus({ state: "error", savedAt: status.savedAt, message: "The tablet's storage is full or blocked, so this entry was NOT saved. Keep this page open, print the sheet now, then free some space (Print & history → Backup)." });
    return false;
  }

  /** Change one box. It's on the tablet before this returns. */
  function set(key, value) {
    if (!day) return false;
    const prev = day.f[key];
    // Always later than the box's last change, even if the tablet's clock went back.
    const t = Math.max(Date.now(), lastT + 1, prev ? prev.t + 1 : 0);
    lastT = t;
    day.f[key] = { v: value == null ? null : value, t };
    return write();
  }

  function scheduleArchive(date, ms = 1500) {
    if (!archive) return;
    clearTimeout(archiveTimers.get(date));
    archiveTimers.set(date, setTimeout(() => { archiveTimers.delete(date); archiveDay(date); }, ms));
  }

  async function archiveDay(date) {
    if (!archive) return false;
    const rec = readLocal(date);
    if (!rec) return false;
    try {
      const tpl = templateFor(rec.tplId) || (day && day.date === date ? day.tpl : null);
      if (tpl) await archive.putTemplate(rec.tplId, tpl);
      const saved = await archive.putDay(rec, (f) => summarize({ date, tpl: tpl || buildTemplate(), f }));
      archivedAt.set(date, saved.savedAt >= rec.savedAt ? saved.savedAt : rec.savedAt);
      return true;
    } catch {
      return false;
    }
  }

  /** Archive anything waiting (page being hidden or closed). */
  function flush() {
    for (const [date, timer] of archiveTimers) { clearTimeout(timer); archiveTimers.delete(date); archiveDay(date); }
  }

  /**
   * Keep localStorage small: days older than KEEP_LOCAL_DAYS that the archive
   * holds in full are removed from it. Returns the dates removed.
   */
  async function pruneLocal(today = tradingDate()) {
    await archiveReady;
    if (!archive) return [];
    const cutoff = addDays(today, -KEEP_LOCAL_DAYS);
    const removed = [];
    for (const date of localDates()) {
      if (date >= cutoff || (day && day.date === date)) continue;
      const rec = readLocal(date);
      if (!rec) continue;
      await archiveDay(date);
      let archived = null;
      try { archived = await archive.getDay(date); } catch { archived = null; }
      const complete = archived && Object.entries(rec.f).every(([k, e]) => archived.f[k] && archived.f[k].t >= e.t);
      if (complete && JSON.stringify(readLocal(date)) === JSON.stringify(rec)) {
        local.remove(DAY + date);
        removed.push(date);
      }
    }
    if (removed.length) dropUnusedTemplates();
    return removed;
  }

  /** History for one month: [{ date, summary }], newest first. */
  async function listMonth(month) {
    await archiveReady;
    const byDate = new Map();
    if (archive) {
      try { for (const row of await archive.listMonth(month)) if (row.summary) byDate.set(row.date, row.summary); } catch { /* ignore */ }
    }
    for (const date of localDates()) {
      if (!date.startsWith(month)) continue;
      const rec = readLocal(date);
      if (!rec || !Object.keys(rec.f).length) continue;
      const tpl = templateFor(rec.tplId);
      if (tpl) byDate.set(date, summarize({ date, tpl, f: rec.f }));
    }
    return [...byDate.entries()].map(([date, summary]) => ({ date, summary })).sort((a, b) => (a.date < b.date ? 1 : -1));
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

  /* ---------- Backup ---------- */

  /** Everything (all days, the checklists they used, optionally photos) as one object. */
  async function backupData(photos) {
    await archiveReady;
    flush();
    const days = {};
    const templates = {};
    const addTpl = (id, tpl) => { if (id && tpl && !templates[id]) templates[id] = tpl; };
    if (archive) {
      try {
        for (const rec of await archive.allDays()) days[rec.date] = { tplId: rec.tplId, f: rec.f, savedAt: rec.savedAt };
        for (const row of await archive.allTemplates()) addTpl(row.id, row.tpl);
      } catch { /* fall back to the local copies */ }
    }
    for (const date of localDates()) {
      const rec = readLocal(date);
      if (!rec) continue;
      days[date] = days[date] ? { tplId: rec.tplId, f: mergeFields(days[date].f, rec.f).fields, savedAt: rec.savedAt } : { tplId: rec.tplId, f: rec.f, savedAt: rec.savedAt };
      addTpl(rec.tplId, templateFor(rec.tplId));
    }
    return { app: BACKUP_APP, version: 2, exportedAt: new Date().toISOString(), days, templates, photos: photos || [] };
  }

  /**
   * Merge a backup into the tablet (newer boxes win, nothing is deleted).
   * Accepts this version's backups and the first version's ({ days: { date: { tpl, f } } }).
   * Returns { days, photos } where photos are the backup's photos for the caller to store.
   */
  async function restore(text) {
    await archiveReady;
    let data;
    try { data = JSON.parse(text); } catch { throw new Error("This isn't a line check backup file."); }
    if (!data || data.app !== BACKUP_APP || typeof data.days !== "object") throw new Error("This isn't a line check backup file.");
    const templates = data.templates && typeof data.templates === "object" ? data.templates : {};
    let count = 0;
    const cutoff = addDays(tradingDate(), -KEEP_LOCAL_DAYS);
    for (const [date, rec] of Object.entries(data.days)) {
      if (!isDate(date) || !rec || typeof rec.f !== "object") continue;
      const tpl = (rec.tplId && templates[rec.tplId]) || (rec.tpl && Array.isArray(rec.tpl.line) ? rec.tpl : null) || buildTemplate();
      const tplId = rec.tplId && templates[rec.tplId] ? rec.tplId : templateId(tpl);
      saveTemplateLocal(tpl, tplId);
      const existing = readLocal(date);
      const f = mergeFields(existing ? existing.f : {}, rec.f).fields;
      const merged = { date, tplId: existing ? existing.tplId : tplId, f, savedAt: new Date().toISOString() };
      if (archive) {
        await archive.putTemplate(tplId, tpl);
        const saved = await archive.putDay(merged, (all) => summarize({ date, tpl, f: all }));
        archivedAt.set(date, saved.savedAt);
      }
      if (existing || date >= cutoff || !archive) {
        if (!local.set(DAY + date, JSON.stringify(merged)) && !archive) throw new Error("The tablet ran out of space after " + count + " days.");
      }
      if (day && day.date === date) day.f = mergeFields(day.f, rec.f).fields;
      count++;
    }
    return { days: count, photos: Array.isArray(data.photos) ? data.photos : [] };
  }

  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });

  return {
    open, set, flush, pruneLocal, listMonth, backupData, restore,
    current: () => day,
    status: () => status,
    ready: () => archiveReady,
    hasArchive: () => !!archive,
    archiveDayNow: (date) => archiveDay(date),
  };
}
