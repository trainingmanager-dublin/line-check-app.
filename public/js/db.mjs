/*
 * The tablet's IndexedDB: the long-term archive of every day (no practical
 * size limit, unlike localStorage) and the photos.
 *
 * Stores:
 *   days       { date, tplId, f, savedAt }
 *   index      { date, summary, savedAt }        (quick history list)
 *   templates  { id, tpl }
 *   photos     { id, date, on, at, type, w, h, data (ArrayBuffer) }
 *
 * Everything here is best effort: if the browser has no IndexedDB the app
 * still works from localStorage alone.
 */
import { mergeFields } from "./core.mjs";

const DB_NAME = "line-check";
const VERSION = 1;
let opening = null;

export function openDb() {
  if (opening) return opening;
  opening = new Promise((resolve) => {
    let done = false;
    const finish = (db) => { if (!done) { done = true; resolve(db); } };
    // Some Safari versions never answer the first open; carry on without it.
    setTimeout(() => finish(null), 6000);
    let req;
    try {
      req = globalThis.indexedDB && globalThis.indexedDB.open(DB_NAME, VERSION);
    } catch {
      req = null;
    }
    if (!req) return finish(null);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("days")) db.createObjectStore("days", { keyPath: "date" });
      if (!db.objectStoreNames.contains("index")) db.createObjectStore("index", { keyPath: "date" });
      if (!db.objectStoreNames.contains("templates")) db.createObjectStore("templates", { keyPath: "id" });
      if (!db.objectStoreNames.contains("photos")) db.createObjectStore("photos", { keyPath: "id" }).createIndex("date", "date");
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      finish(db);
    };
    req.onerror = () => finish(null);
  });
  return opening;
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Promise helpers for one IndexedDB database. */
export function wrap(db) {
  const store = (name, mode) => db.transaction(name, mode).objectStore(name);
  return {
    get: (name, key) => request(store(name, "readonly").get(key)).then((v) => v || null),
    put: (name, value) => request(store(name, "readwrite").put(value)),
    del: (name, key) => request(store(name, "readwrite").delete(key)),
    getAll: (name, range) => request(store(name, "readonly").getAll(range)),
    keys: (name, range) => request(store(name, "readonly").getAllKeys(range)),
    byIndex: (name, index, range) => request(store(name, "readonly").index(index).getAll(range)),
    range: (lo, hi) => IDBKeyRange.bound(lo, hi),
  };
}

/**
 * The day archive used by store.mjs. `io` is wrap(db), or memoryIo() in tests.
 */
export function archiveOver(io) {
  const knownTemplates = new Set();
  return {
    async getDay(date) {
      return io.get("days", date);
    },
    /**
     * Saves a day, merged box by box with any copy already archived.
     * summarize(f) builds the history-list summary from the merged boxes.
     */
    async putDay(rec, summarize) {
      const old = await io.get("days", rec.date);
      const f = old ? mergeFields(old.f, rec.f).fields : rec.f;
      const saved = { date: rec.date, tplId: (old && old.tplId) || rec.tplId, f, savedAt: rec.savedAt || new Date().toISOString() };
      await io.put("days", saved);
      await io.put("index", { date: rec.date, summary: summarize ? summarize(f) : null, savedAt: saved.savedAt });
      return saved;
    },
    async listMonth(month) {
      return io.getAll("index", io.range(month + "-00", month + "-99"));
    },
    async allDays() {
      return io.getAll("days");
    },
    async getTemplate(id) {
      const row = await io.get("templates", id);
      return row ? row.tpl : null;
    },
    async putTemplate(id, tpl) {
      if (knownTemplates.has(id)) return;
      if (!(await io.get("templates", id))) await io.put("templates", { id, tpl });
      knownTemplates.add(id);
    },
    async allTemplates() {
      return io.getAll("templates");
    },
    io,
  };
}

/** Same interface as wrap(db), kept in memory (tests, or a browser without IndexedDB). */
export function memoryIo() {
  const stores = new Map();
  const s = (name) => { if (!stores.has(name)) stores.set(name, new Map()); return stores.get(name); };
  const keyOf = (name, value) => (name === "days" || name === "index" ? value.date : value.id);
  const inRange = (k, range) => !range || (k >= range[0] && k <= range[1]);
  const clone = (v) => (v == null ? null : structuredClone(v));
  return {
    get: async (name, key) => clone(s(name).get(key)),
    put: async (name, value) => { s(name).set(keyOf(name, value), clone(value)); },
    del: async (name, key) => { s(name).delete(key); },
    getAll: async (name, range) => [...s(name).entries()].filter(([k]) => inRange(k, range)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([, v]) => clone(v)),
    keys: async (name, range) => [...s(name).keys()].filter((k) => inRange(k, range)).sort(),
    byIndex: async (name, index, range) => [...s(name).values()].filter((v) => inRange(v[index], range)).map(clone),
    range: (lo, hi) => [lo, hi],
  };
}
