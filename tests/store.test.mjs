import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// A tablet's localStorage, with a size limit to test "storage full".
const data = new Map();
let limit = Infinity;
globalThis.localStorage = {
  getItem: (k) => (data.has(k) ? data.get(k) : null),
  setItem: (k, v) => {
    const size = [...data].reduce((n, [key, val]) => n + (key === k ? 0 : val.length), 0) + String(v).length;
    if (size > limit) throw new Error("QuotaExceededError");
    data.set(k, String(v));
  },
  removeItem: (k) => data.delete(k),
};
Object.defineProperty(globalThis.localStorage, "length", { get: () => data.size });
globalThis.window = { addEventListener() {} };

const S = await import("../public/js/store.mjs");
const C = await import("../public/js/core.mjs");
Object.keys = ((orig) => (o) => (o === globalThis.localStorage ? [...data.keys()] : orig(o)))(Object.keys);

const hooks = () => ({ statuses: [], dropped: [], onChange() {}, onStatus(s) { this.statuses.push(s); }, onDropped(d) { this.dropped.push(d); } });

beforeEach(() => { data.clear(); limit = Infinity; });

test("every change is on the tablet straight away and survives reopening", () => {
  const h = hooks();
  const store = S.createStore(h);
  store.open("2026-10-11");
  const item = C.lineItems(store.current().tpl)[0];
  assert.equal(store.set(C.lineKey(item.id, "am"), { s: "ok", t: "", c: [], n: "" }), true);
  assert.equal(h.statuses.at(-1).state, "saved");

  const again = S.createStore(hooks());
  const day = again.open("2026-10-11");
  assert.equal(day.f[C.lineKey(item.id, "am")].v.s, "ok");
  assert.deepEqual(S.daySummaries("2026-10").map((d) => d.date), ["2026-10-11"]);
});

test("the checklists a day started with are kept with it", () => {
  const store = S.createStore(hooks());
  store.open("2026-10-10");
  store.set(C.signKey("am"), { i: "JD" });
  const tplKeys = [...data.keys()].filter((k) => k.startsWith("lc:tpl:"));
  assert.equal(tplKeys.length, 1);
  assert.deepEqual(S.loadDay("2026-10-10").tpl, C.buildTemplate());
});

test("when storage is full the oldest day is removed, never today", () => {
  const store = S.createStore(hooks());
  for (const d of ["2026-09-01", "2026-09-02"]) { store.open(d); store.set(C.signKey("am"), { i: "OLD" }); }
  const h = hooks();
  const today = S.createStore(h);
  today.open("2026-10-11");
  limit = [...data.values()].reduce((n, v) => n + v.length, 0) + 40; // room for less than one more day
  assert.equal(today.set(C.signKey("am"), { i: "JD" }), true);
  assert.deepEqual(h.dropped, ["2026-09-01"], "only the oldest day goes");
  assert.ok(S.loadDay("2026-09-02"));
  assert.ok(S.loadDay("2026-10-11"));
});

test("if nothing can be freed it says the entry was NOT saved", () => {
  const h = hooks();
  const store = S.createStore(h);
  store.open("2026-10-11");
  limit = 10;
  assert.equal(store.set(C.signKey("am"), { i: "JD" }), false);
  assert.equal(h.statuses.at(-1).state, "error");
});

test("backup and restore", () => {
  const store = S.createStore(hooks());
  store.open("2026-10-11");
  store.set(C.signKey("pm"), { i: "MK" });
  const backup = S.backupJson();
  data.clear();
  assert.equal(S.restoreBackup(backup), 1);
  assert.equal(S.loadDay("2026-10-11").f[C.signKey("pm")].v.i, "MK");
  assert.throws(() => S.restoreBackup('{"hello":1}'), /backup/);
});
