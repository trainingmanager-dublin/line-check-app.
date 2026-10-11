/*
 * The Excel download writes into the original templates. Rows are matched to
 * the checklist by name and then by position (the app's wording is written
 * in, so spelling fixes and renames in the app are fine), but every section
 * needs at least as many rows in the "Horizontal" sheet as it has items.
 * If this fails after adding items to public/js/line-template.mjs, add rows
 * to public/templates/line-check.xlsx too.
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

test("every line check section has room for all its items in the Excel template", () => {
  const cells = readSheet("line-check.xlsx", "Horizontal");
  const sections = [];
  for (let r = 6; r < 400; r++) {
    const a = norm(cells.get("A" + r)), b = norm(cells.get("B" + r)), e = norm(cells.get("E" + r)), f = norm(cells.get("F" + r));
    if (e === "manager initials") break;
    if (!a) continue;
    if (f === "am" || b === "temp" || (["miscellaneous", "line area", "prep kitchen"].includes(a) && !e)) { sections.push({ name: a, rows: [] }); continue; }
    sections.at(-1).rows.push(a);
  }
  const app = buildTemplate().line;
  assert.equal(sections.length, app.length, "same number of sections");
  let renamed = 0;
  app.forEach((s, i) => {
    const sheet = sections.find((x) => x.name === norm(s.name)) || sections[i];
    assert.ok(sheet.rows.length >= s.items.length, s.name + ": " + sheet.rows.length + " rows for " + s.items.length + " items");
    renamed += s.items.filter((it) => !sheet.rows.includes(norm(it.name))).length;
  });
  // Spelling fixed in the app (e.g. Guiness -> Guinness): matched by position and rewritten.
  assert.ok(renamed < 20, renamed + " items don't match a row by name");
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
