/*
 * The Excel download writes into the original templates, so every item in
 * the app must have its row in the "Horizontal" sheet (same section, same
 * name). If this fails after editing public/js/line-template.mjs, make the
 * same change in public/templates/line-check.xlsx.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { unzipSync, strFromU8 } from "../public/vendor/fflate.mjs";
import { buildTemplate } from "../public/js/core.mjs";

const decode = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();

function readSheet(file, sheetName) {
  const files = unzipSync(readFileSync(new URL("../public/templates/" + file, import.meta.url)));
  const shared = [...strFromU8(files["xl/sharedStrings.xml"]).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    decode([...m[1].replace(/<rPh[\s\S]*?<\/rPh>/g, "").matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")));
  const wb = strFromU8(files["xl/workbook.xml"]);
  const rid = new RegExp('<sheet name="' + sheetName + '"[^>]*r:id="(rId\\d+)"').exec(wb)[1];
  const rels = strFromU8(files["xl/_rels/workbook.xml.rels"]);
  const target = new RegExp('Id="' + rid + '"[^>]*Target="([^"]+)"').exec(rels) || new RegExp('Target="([^"]+)"[^>]*Id="' + rid + '"').exec(rels);
  const xml = strFromU8(files["xl/" + target[1].replace(/^\/?xl\//, "")]);
  const cells = new Map();
  for (const m of xml.matchAll(/<c r="([A-Z]+\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const v = /<v>([\s\S]*?)<\/v>/.exec(m[3] || "");
    if (!v) continue;
    cells.set(m[1], / t="s"/.test(m[2]) ? shared[Number(v[1])] : decode(v[1]));
  }
  return cells;
}

test("every line check item has a row in the Excel template", () => {
  const cells = readSheet("line-check.xlsx", "Horizontal");
  const rowsBySection = new Map();
  let section = null;
  for (let r = 6; r < 400; r++) {
    const a = norm(cells.get("A" + r)), b = norm(cells.get("B" + r)), e = norm(cells.get("E" + r)), f = norm(cells.get("F" + r));
    if (e === "manager initials") break;
    if (!a) continue;
    if (f === "am" || b === "temp" || (["miscellaneous", "line area", "prep kitchen"].includes(a) && !e)) { section = a; rowsBySection.set(a, []); continue; }
    rowsBySection.get(section).push(a);
  }
  for (const s of buildTemplate().line) {
    const rows = [...(rowsBySection.get(norm(s.name)) || [])];
    assert.ok(rowsBySection.has(norm(s.name)), "section " + s.name);
    for (const item of s.items) {
      const i = rows.indexOf(norm(item.name));
      assert.ok(i >= 0, s.name + ": " + item.name);
      rows.splice(i, 1);
    }
  }
});

test("the temperature template has the rows the app fills", () => {
  const cells = readSheet("temperature-checklist.xlsx", "Temperature");
  const T = buildTemplate().temps;
  T.fridges.forEach((row, i) => { if (row.name) assert.ok(norm(cells.get("A" + (7 + i))).startsWith(norm(row.name)), row.name); });
  T.hot.forEach((row, i) => { if (row.name) assert.ok(norm(cells.get("A" + (21 + i))).startsWith(norm(row.name)), row.name); });
  assert.ok(norm(cells.get("A29")).startsWith("dish washer"));
  assert.equal(norm(cells.get("A31")), "fryer");
  assert.equal(norm(cells.get("A35")), "grill");
  assert.equal(norm(cells.get("A38")), "flat top");
});
