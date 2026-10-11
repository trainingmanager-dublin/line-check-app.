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
  const bad = { "nope": { v: 1, t: 5 }, "L:x:am": { v: "x".repeat(C.MAX_VALUE_CHARS + 10), t: 9 }, "L:y:am": { v: 1, t: -1 } };
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
    [C.signKey("am")]: { v: { name: "John Doyle", i: "JD", at: "2026-10-11T11:00:00Z" }, t: 1 },
    [C.tempKey("fr-freezer", "open")]: { v: "-19", t: 1 },
  } };
  const am = C.shiftProgress(record, "am");
  assert.equal(am.done, 3);
  assert.equal(am.issues, 2, "a flagged item and an out-of-range temperature");
  assert.equal(am.signed.name, "John Doyle");
  assert.equal(C.shiftProgress(record, "pm").done, 0);
  const sum = C.summarize(record);
  assert.deepEqual([sum.am.d, sum.am.n, sum.am.i, sum.am.s], [3, 218, 2, "John Doyle"]);
  assert.deepEqual([sum.pm.d, sum.pm.i, sum.pm.s], [0, 0, ""]);
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

test("every key the app writes is one that merging and backups accept", () => {
  const tpl = C.buildTemplate();
  const record = { tpl, f: {} };
  const keys = [
    ...C.lineItems(tpl).flatMap((it) => C.SHIFTS.map((s) => C.lineKey(it.id, s))),
    ...C.SHIFTS.flatMap((s) => [C.signKey(s), C.histKey(s)]),
    ...C.SHIFTS.flatMap((s) => C.tempTasks(record, s).map((t) => t.key)),
    C.photoKey(C.newPhotoId()),
  ];
  for (const r of [...tpl.temps.fridges, ...tpl.temps.hot, tpl.temps.dish]) for (const slot of ["food", "ca", "name"]) keys.push(C.tempKey(r.id, slot));
  for (const r of [...tpl.temps.fryers, ...tpl.temps.grill, ...tpl.temps.flat]) keys.push(C.tempKey(r.id, "notes"));
  for (const k of keys) assert.ok(C.validEntry(k, { v: "x", t: 1 }), k);
  assert.equal(new Set(keys).size, keys.length, "no two boxes share a key");
});

test("what each shift has to take on the temperature sheet", () => {
  const tpl = C.buildTemplate();
  const record = { tpl, f: {} };
  // AM: 11 fridges x (opening, 12 item, 12 fridge) + 6 hot x 12:00 + dish wash/rinse + 4 fryers x 2 + 6 grill/flat
  assert.equal(C.tempTasks(record, "am").length, 33 + 6 + 2 + 8 + 6);
  // PM: 11 x 5 + 6 x 2 + dish 2 x 2 + 6
  assert.equal(C.tempTasks(record, "pm").length, 55 + 12 + 4 + 6);
  // A spare row counts once it has a name.
  const other = tpl.temps.fridges.find((r) => !r.name);
  record.f[C.tempKey(other.id, "name")] = { v: "Bar fridge", t: 1 };
  assert.equal(C.tempTasks(record, "am").length, 33 + 3 + 6 + 2 + 8 + 6);
});

test("sign-off is blocked by problems without a corrective action", () => {
  const tpl = C.buildTemplate();
  const leaf = C.lineItems(tpl).find((i) => i.name === "Leaf Lettuce");
  const freezer = tpl.temps.fridges[0];
  const record = { tpl, f: {
    [C.lineKey(leaf.id, "am")]: { v: { s: "no", t: "9" }, t: 1 },
    [C.tempKey(freezer.id, "open")]: { v: "-12", t: 1 },
  } };
  assert.deepEqual(C.lineNeedingAction(record, "am").map((i) => i.name), ["Leaf Lettuce"]);
  assert.equal(C.tempsNeedingAction(record, "am").length, 1);
  record.f[C.lineKey(leaf.id, "am")] = { v: { s: "no", t: "9", n: "Binned, new batch" }, t: 2 };
  record.f[C.tempKey(freezer.id, "ca")] = { v: "Door fixed, re-probed -19", t: 2 };
  assert.equal(C.lineNeedingAction(record, "am").length, 0);
  assert.equal(C.tempsNeedingAction(record, "am").length, 0);
  assert.equal(C.tempsNeedingAction(record, "pm").length, 0, "the PM shift isn't blocked by AM readings");
});

test("small helpers", () => {
  assert.equal(C.cleanTemp(" 4,5° "), "4.5");
  assert.equal(C.cleanTemp("-18"), "-18");
  assert.equal(C.cleanTemp("abc"), "abc");
  assert.equal(C.judgeDish("66", "84", { wash: 64, rinse: 82 }), "ok");
  assert.equal(C.judgeDish("60", "", { wash: 64, rinse: 82 }), "bad");
  assert.equal(C.judgeDish("", "", { wash: 64, rinse: 82 }), null);
  assert.equal(C.offTarget("150", 177), true);
  assert.equal(C.offTarget("170", 177), false);
  assert.equal(C.initialsOf("Mary Kelly"), "MK");
  assert.equal(C.initialsOf("  mary-kate o'brien "), "MKO");
  assert.deepEqual(C.compactLine({ s: "ok", t: "", c: [], n: "" }), { s: "ok" });
  assert.equal(C.compactLine({ s: "", t: "", c: [], n: "" }), null);
  assert.match(C.newPhotoId(), /^ph-[a-z0-9]+-[a-z0-9]{4}$/);
});

test("first-version dish washer readings are split into wash and rinse", () => {
  const f = { "T:dish:12": { v: "66/84", t: 7 } };
  C.upgradeFields(f);
  assert.deepEqual(f["T:dish:12w"], { v: "66", t: 7 });
  assert.deepEqual(f["T:dish:12r"], { v: "84", t: 7 });
  const g = { "T:dish:12": { v: "66/84", t: 7 }, "T:dish:12w": { v: "70", t: 9 } };
  C.upgradeFields(g);
  assert.equal(g["T:dish:12w"].v, "70", "a newer wash reading is kept");
});
