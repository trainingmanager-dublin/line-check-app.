/*
 * Saving on the tablet: the flaws found in the first version, and the rules
 * that keep a line check from ever being lost.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// The tablet's localStorage (with an optional size limit) and a page with no real events.
const data = new Map();
let limit = Infinity;
const used = () => [...data].reduce((n, [k, v]) => n + k.length + v.length, 0);
globalThis.localStorage = {
  getItem: (k) => (data.has(k) ? data.get(k) : null),
  setItem: (k, v) => {
    const size = used() - (data.has(k) ? k.length + data.get(k).length : 0) + k.length + String(v).length;
    if (size > limit) throw new Error("QuotaExceededError");
    data.set(k, String(v));
  },
  removeItem: (k) => data.delete(k),
};
const realKeys = Object.keys;
Object.keys = (o) => (o === globalThis.localStorage ? [...data.keys()] : realKeys(o));
globalThis.window = { addEventListener() {} };
globalThis.document = { addEventListener() {}, visibilityState: "visible" };

const S = await import("../public/js/store.mjs");
const C = await import("../public/js/core.mjs");
const { archiveOver, memoryIo } = await import("../public/js/db.mjs");

function hooks() {
  return {
    statuses: [], dropped: [], changes: [],
    onChange(keys) { this.changes.push(...keys); },
    onStatus(s) { this.statuses.push(s); },
    onDropped(d) { this.dropped.push(d); },
  };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const items = C.lineItems(C.buildTemplate());
const today = C.tradingDate();
const daysAgo = (n) => C.addDays(today, -n);

beforeEach(() => { data.clear(); limit = Infinity; });

test("every change is on the tablet straight away and survives reopening", async () => {
  const h = hooks();
  const store = S.createStore(h, { archive: null });
  await store.open(today);
  assert.equal(store.set(C.lineKey(items[0].id, "am"), { s: "ok" }), true);
  assert.equal(h.statuses.at(-1).state, "saved");
  const again = S.createStore(hooks(), { archive: null });
  const day = await again.open(today);
  assert.deepEqual(day.f[C.lineKey(items[0].id, "am")].v, { s: "ok" });
});

test("FLAW 1 fixed: two tabs on the same day don't wipe out each other's ticks", async () => {
  const tabA = S.createStore(hooks(), { archive: null });
  const hB = hooks();
  const tabB = S.createStore(hB, { archive: null });
  await tabA.open(today);
  await tabB.open(today); // opened before A's tick, and no storage event arrives
  tabA.set(C.lineKey(items[0].id, "am"), { s: "ok" });
  tabB.set(C.lineKey(items[1].id, "am"), { s: "ok" });
  const stored = JSON.parse(data.get("lc:day:" + today));
  assert.ok(stored.f[C.lineKey(items[0].id, "am")], "tab A's tick is still saved");
  assert.ok(stored.f[C.lineKey(items[1].id, "am")], "tab B's tick is saved");
  await tick();
  assert.ok(hB.changes.includes(C.lineKey(items[0].id, "am")), "tab B is told to redraw A's tick");
});

test("FLAW 2 fixed: the latest edit wins even if the tablet's clock went back", async (t) => {
  const key = C.lineKey(items[0].id, "am");
  const s1 = S.createStore(hooks(), { archive: null });
  await s1.open(today);
  s1.set(key, { s: "no", n: "first" });
  const realNow = Date.now;
  t.after(() => { Date.now = realNow; });
  Date.now = () => realNow() - 3600e3; // clock corrected one hour back, then the page reloads
  const s2 = S.createStore(hooks(), { archive: null });
  await s2.open(today);
  s2.set(key, { s: "ok" });
  const stored = JSON.parse(data.get("lc:day:" + today)).f;
  assert.deepEqual(stored[key].v, { s: "ok" });
  // Meeting the older copy again (second tab, backup) must not bring "first" back.
  const merged = C.mergeFields(stored, { [key]: { v: { s: "no", n: "first" }, t: realNow() - 5 } });
  assert.deepEqual(merged.fields[key].v, { s: "ok" });
});

test("FLAW 4 fixed: a drawn signature fits in a box and survives merging", () => {
  // A realistic signature: about a dozen strokes of 50-60 points each.
  const sig = { w: 1000, h: 300, s: Array.from({ length: 12 }, (_, k) => Array.from({ length: 110 }, (_, i) => (i * 37 + k * 11) % 1000)) };
  const value = { name: "Mary Kelly", i: "MK", at: new Date().toISOString(), sig };
  assert.ok(JSON.stringify(value).length > 2000);
  const merged = C.mergeFields({}, { [C.signKey("am")]: { v: value, t: Date.now() } });
  assert.deepEqual(merged.fields[C.signKey("am")].v, value);
});

test("FLAW 3 fixed: days are archived, so old days don't have to be thrown away", async () => {
  const archive = archiveOver(memoryIo());
  const store = S.createStore(hooks(), { archive });
  const old = daysAgo(40);
  await store.open(old);
  store.set(C.signKey("am"), { name: "Old Day", i: "OD" });
  assert.equal(await store.archiveDayNow(old), true);
  await store.open(today);
  store.set(C.signKey("am"), { name: "Today", i: "T" });
  await store.archiveDayNow(today);
  const removed = await store.pruneLocal(today);
  assert.deepEqual(removed, [old], "the 40-day-old day leaves localStorage...");
  assert.equal(data.has("lc:day:" + old), false);
  const reopened = await store.open(old);
  assert.equal(reopened.f[C.signKey("am")].v.name, "Old Day", "...but opens from the archive");
  assert.equal(data.has("lc:day:" + today), true, "recent days stay in localStorage");
});

test("pruning only removes a day once the archive has every box of it", async () => {
  const archive = archiveOver(memoryIo());
  const store = S.createStore(hooks(), { archive });
  const old = daysAgo(30);
  await store.open(old);
  store.set(C.signKey("am"), { name: "A", i: "A" });
  await store.archiveDayNow(old);
  await store.open(today);
  // A change to the old day the archive hasn't seen yet (written by another tab, say).
  const rec = JSON.parse(data.get("lc:day:" + old));
  rec.f[C.signKey("pm")] = { v: { name: "B", i: "B" }, t: Date.now() + 1000 };
  data.set("lc:day:" + old, JSON.stringify(rec));
  await store.pruneLocal(today);
  const archived = await archive.getDay(old);
  assert.ok(archived.f[C.signKey("pm")], "the newer box reached the archive before the local copy was removed");
});

test("storage full: archived days make room first and today's entry is saved", async () => {
  const archive = archiveOver(memoryIo());
  const h = hooks();
  const store = S.createStore(h, { archive });
  for (const d of [daysAgo(3), daysAgo(2)]) {
    await store.open(d);
    store.set(C.signKey("am"), { name: "Kept", i: "K" });
    await store.archiveDayNow(d);
  }
  await store.open(today);
  store.set(C.signKey("am"), { name: "x", i: "x" });
  limit = used() + 10; // no room for today's next change
  assert.equal(store.set(C.signKey("pm"), { name: "Today PM", i: "TP" }), true);
  assert.deepEqual(h.dropped, [], "nothing that wasn't archived was lost");
  assert.ok((await archive.getDay(daysAgo(3))).f[C.signKey("am")], "the removed day is still in the archive");
});

test("storage full with no archive: the oldest day goes and that's reported; nothing left = NOT saved", async () => {
  const h = hooks();
  const store = S.createStore(h, { archive: null });
  for (const d of [daysAgo(9), daysAgo(8)]) { await store.open(d); store.set(C.signKey("am"), { name: "Old", i: "O" }); }
  await store.open(today);
  store.set(C.signKey("am"), { name: "x", i: "x" });
  limit = used() + 10;
  assert.equal(store.set(C.signKey("pm"), { name: "PM", i: "P" }), true);
  assert.deepEqual(h.dropped, [daysAgo(9)]);
  limit = 10;
  assert.equal(store.set(C.signKey("pm"), { name: "PM2", i: "P2" }), false);
  assert.equal(h.statuses.at(-1).state, "error");
});

test("the checklist a day was started with stays with that day", async () => {
  const store = S.createStore(hooks(), { archive: null });
  await store.open(today);
  store.set(C.signKey("am"), { name: "x", i: "x" });
  // Simulate an older checklist: rename an item in the stored copy.
  const rec = JSON.parse(data.get("lc:day:" + today));
  const tplKey = "lc:tpl:" + rec.tplId;
  const tpl = JSON.parse(data.get(tplKey));
  tpl.line[0].items[0].name = "Old name";
  data.set(tplKey, JSON.stringify(tpl));
  const day = await S.createStore(hooks(), { archive: null }).open(today);
  assert.equal(day.tpl.line[0].items[0].name, "Old name");
});

test("old-format boxes are stored small", async () => {
  const key = C.lineKey(items[0].id, "am");
  data.set("lc:day:" + today, JSON.stringify({ date: today, tplId: "none", f: { [key]: { v: { s: "ok", t: "", c: [], n: "" }, t: 5 } } }));
  const day = await S.createStore(hooks(), { archive: null }).open(today);
  assert.deepEqual(day.f[key].v, { s: "ok" });
});

test("backup and restore: everything comes back, newer boxes win, old backups still work", async () => {
  const store = S.createStore(hooks(), { archive: archiveOver(memoryIo()) });
  await store.open(daysAgo(60));
  store.set(C.signKey("am"), { name: "Sixty", i: "S" });
  await store.archiveDayNow(daysAgo(60));
  await store.open(today);
  store.set(C.signKey("pm"), { name: "Mary Kelly", i: "MK" });
  const backup = JSON.stringify(await store.backupData());
  data.clear();
  const fresh = S.createStore(hooks(), { archive: archiveOver(memoryIo()) });
  await fresh.open(today);
  fresh.set(C.signKey("am"), { name: "Newer", i: "N" });
  const res = await fresh.restore(backup);
  assert.equal(res.days, 2);
  const day = await fresh.open(today);
  assert.equal(day.f[C.signKey("pm")].v.name, "Mary Kelly");
  assert.equal(day.f[C.signKey("am")].v.name, "Newer", "a box changed after the backup keeps its newer value");
  assert.equal((await fresh.open(daysAgo(60))).f[C.signKey("am")].v.name, "Sixty");
  // First-version backups: { days: { date: { date, tpl, f } } }
  const v1 = JSON.stringify({ app: "hard-rock-line-check", days: { [daysAgo(1)]: { date: daysAgo(1), tpl: C.buildTemplate(), f: { [C.signKey("am")]: { v: { i: "JD" }, t: 9 } } } } });
  assert.equal((await fresh.restore(v1)).days, 1);
  await assert.rejects(fresh.restore('{"hello":1}'), /backup/);
});

test("history lists archived and local days with their summary", async () => {
  const archive = archiveOver(memoryIo());
  const store = S.createStore(hooks(), { archive });
  await store.open(today);
  store.set(C.lineKey(items[0].id, "am"), { s: "ok" });
  await store.archiveDayNow(today);
  const list = await store.listMonth(today.slice(0, 7));
  assert.equal(list[0].date, today);
  assert.equal(list[0].summary.am.d, 1);
  assert.equal(list[0].summary.am.n, 218);
});
