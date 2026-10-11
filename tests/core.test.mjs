import { test } from "node:test";
import assert from "node:assert/strict";
import * as C from "../public/js/core.mjs";

test("the line check has every section and item from the Excel sheet", () => {
  const tpl = C.buildTemplate();
  assert.equal(tpl.line.length, 13);
  assert.equal(C.lineItems(tpl).length, 218);
  const ids = C.lineItems(tpl).map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length, "item ids are unique");
  for (const id of ids) assert.ok(C.isValidKey(C.lineKey(id, "am")), id);
});

test("item ids stay the same between builds", () => {
  assert.deepEqual(C.buildTemplate(), C.buildTemplate());
});

test("temperature limits are read from the Temp column", () => {
  assert.deepEqual(C.limitFromText("41°F/5° C"), { max: 5 });
  assert.deepEqual(C.limitFromText("40°F/5°C"), { max: 5 });
  assert.deepEqual(C.limitFromText("41°F/5° C cold"), { max: 5 });
  assert.deepEqual(C.limitFromText("167°F/75°C"), { min: 75 });
  assert.deepEqual(C.limitFromText("0°F/-18°C"), { max: -18 });
  assert.deepEqual(C.limitFromText("10°F/-12,2°C"), { max: -12.2 });
  assert.equal(C.limitFromText("Room Temp"), null);
  assert.equal(C.limitFromText("Chilled"), null);
  const withTemp = C.lineItems(C.buildTemplate()).filter((i) => i.limit);
  assert.equal(withTemp.length, 134);
});

test("typed temperatures", () => {
  assert.equal(C.parseTemp("4"), 4);
  assert.equal(C.parseTemp(" 4,5 "), 4.5);
  assert.equal(C.parseTemp("-18°"), -18);
  assert.equal(C.parseTemp("3°C"), 3);
  assert.equal(C.parseTemp("abc"), null);
  assert.equal(C.parseTemp(""), null);
  assert.equal(C.parseTemp("4..5"), null);
  assert.equal(C.judgeTemp("5", { max: 5 }), "ok");
  assert.equal(C.judgeTemp("5.1", { max: 5 }), "bad");
  assert.equal(C.judgeTemp("-17", { max: -18 }), "bad");
  assert.equal(C.judgeTemp("74", { min: 75 }), "bad");
  assert.equal(C.judgeTemp("80", { min: 75 }), "ok");
  assert.equal(C.judgeTemp("", { max: 5 }), null);
  assert.equal(C.dishBad("66/84", { wash: 64, rinse: 82 }), false);
  assert.equal(C.dishBad("60/84", { wash: 64, rinse: 82 }), true);
  assert.equal(C.dishBad("66 / 80", { wash: 64, rinse: 82 }), true);
  assert.equal(C.dishBad("66", { wash: 64, rinse: 82 }), false);
});

test("merging keeps the newest value of each box", () => {
  const a = { "L:x:am": { v: { s: "ok" }, t: 10 }, "L:y:am": { v: { s: "no" }, t: 30 } };
  const b = { "L:x:am": { v: { s: "no" }, t: 20 }, "L:y:am": { v: { s: "ok" }, t: 25 }, "L:z:pm": { v: { s: "ok" }, t: 5 } };
  const { fields, changed } = C.mergeFields(a, b);
  assert.deepEqual(fields["L:x:am"].v, { s: "no" });
  assert.deepEqual(fields["L:y:am"].v, { s: "no" });
  assert.ok(fields["L:z:pm"]);
  assert.deepEqual(changed.sort(), ["L:x:am", "L:z:pm"]);
});

test("merging ignores bad entries and breaks ties the same way both ways", () => {
  const bad = { "nope": { v: 1, t: 5 }, "L:x:am": { v: "x".repeat(5000), t: 9 }, "L:y:am": { v: 1, t: -1 } };
  assert.deepEqual(C.mergeFields({}, bad).fields, {});
  const p = { "L:x:am": { v: { s: "ok" }, t: 7 } };
  const q = { "L:x:am": { v: { s: "no" }, t: 7 } };
  assert.deepEqual(C.mergeFields(p, q).fields, C.mergeFields(q, p).fields);
});

test("progress and summary", () => {
  const tpl = C.buildTemplate();
  const [first, second] = C.lineItems(tpl);
  const leaf = C.lineItems(tpl).find((i) => i.name === "Leaf Lettuce");
  const record = { tpl, f: {
    [C.lineKey(first.id, "am")]: { v: { s: "ok" }, t: 1 },
    [C.lineKey(second.id, "am")]: { v: { s: "no", n: "chipped" }, t: 1 },
    [C.lineKey(leaf.id, "am")]: { v: { s: "ok", t: "9" }, t: 1 },
    [C.signKey("am")]: { v: { i: "JD", at: "2026-10-11T11:00:00Z" }, t: 1 },
    [C.tempKey("fr-freezer", "open")]: { v: "-19", t: 1 },
  } };
  const am = C.shiftProgress(record, "am");
  assert.equal(am.done, 3);
  assert.equal(am.issues, 2, "a flagged item and an out-of-range temperature");
  assert.equal(am.signed.i, "JD");
  assert.equal(C.shiftProgress(record, "pm").done, 0);
  assert.deepEqual(C.summarize(record), { am: [3, 218, 2, "JD"], pm: [0, 218, 0, ""], temps: 1 });
});

test("trading day and shift", () => {
  assert.equal(C.tradingDate(new Date(2026, 9, 11, 9, 0)), "2026-10-11");
  assert.equal(C.tradingDate(new Date(2026, 9, 12, 1, 30)), "2026-10-11", "after midnight still belongs to the night before");
  assert.equal(C.currentShift(new Date(2026, 9, 11, 9, 0)), "am");
  assert.equal(C.currentShift(new Date(2026, 9, 11, 16, 0)), "pm");
  assert.equal(C.currentShift(new Date(2026, 9, 12, 1, 0)), "pm");
  assert.equal(C.addDays("2026-10-31", 1), "2026-11-01");
  assert.equal(C.isDate("2026-02-30"), true); // shape only
  assert.equal(C.isDate("2026-13-01"), false);
});

test("temperature checklist rows match the paper sheet", () => {
  const T = C.buildTemplate().temps;
  assert.equal(T.fridges.length, 14, "rows 7-20");
  assert.equal(T.hot.length, 8, "rows 21-28, dish washer on 29");
  assert.equal(T.fryers.length, 4);
  assert.equal(T.grill.length, 3);
  assert.equal(T.flat.length, 3);
  const keys = [...T.fridges, ...T.hot, T.dish, ...T.fryers, ...T.grill, ...T.flat].flatMap((r) =>
    ["open", "12i", "12f", "16i", "16f", "20i", "20f", "close", "12", "16", "20", "food", "ca", "name", "temp", "tpm", "notes", "am", "pm"].map((s) => C.tempKey(r.id, s)));
  for (const k of keys) assert.ok(C.isValidKey(k), k);
});
