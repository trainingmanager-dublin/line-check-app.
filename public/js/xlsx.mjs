/*
 * Fills in the original Excel templates (public/templates/) and hands them
 * back as a download: the same file as the paper process, with the same
 * layout, logo and print settings, filled in.
 *
 * The workbook is unzipped, the sheet XML edited (cell values, plus the
 * signature pictures), and zipped again. Rows are matched to the checklist
 * by name, then by position, so an item renamed or spelled differently in
 * the app still lands on its row - with the app's wording written in.
 */
import { unzipSync, zipSync, strToU8, strFromU8 } from "../vendor/fflate.mjs";
import * as C from "./core.mjs";
import { sigPng, isSig } from "./signature.mjs";

const { normLine, fieldValue, lineKey, tempKey, parseTemp, FRIDGE_SLOTS, HOT_SLOTS, slashDate, timeOf } = C;
const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const XDR_NS = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing";
const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const XML_NS = "http://www.w3.org/XML/1998/namespace";
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const EMU = 9525; // per pixel

export const LINE_TEMPLATE = "templates/line-check.xlsx";
export const TEMP_TEMPLATE = "templates/temperature-checklist.xlsx";

const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();

function colNumber(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function splitRef(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  return { col: colNumber(m[1]), row: Number(m[2]) };
}

function resolvePath(base, target) {
  if (target.startsWith("/")) return target.slice(1);
  const parts = base.split("/").slice(0, -1);
  for (const p of target.split("/")) {
    if (p === "..") parts.pop();
    else if (p !== ".") parts.push(p);
  }
  return parts.join("/");
}

class Workbook {
  constructor(bytes) {
    this.files = unzipSync(bytes);
    this.parser = new DOMParser();
    this.docs = new Map();
    this.styles = new Map();
    this.shared = [];
    if (this.files["xl/sharedStrings.xml"]) {
      const doc = this.xml("xl/sharedStrings.xml");
      this.shared = [...doc.getElementsByTagNameNS(NS, "si")].map((si) =>
        [...si.getElementsByTagNameNS(NS, "t")].filter((t) => t.parentNode.localName !== "rPh").map((t) => t.textContent).join(""));
    }
  }

  xml(path) {
    if (!this.docs.has(path)) {
      if (!this.files[path]) throw new Error("The template is missing " + path + ".");
      const doc = this.parser.parseFromString(strFromU8(this.files[path]), "application/xml");
      if (doc.getElementsByTagName("parsererror").length) throw new Error("Couldn't read " + path + " in the template.");
      this.docs.set(path, doc);
    }
    return this.docs.get(path);
  }

  rels(path) {
    const relPath = path.replace(/([^/]+)$/, "_rels/$1.rels");
    return { relPath, doc: this.files[relPath] ? this.xml(relPath) : null };
  }

  sheet(name) {
    const wb = this.xml("xl/workbook.xml");
    const sheet = [...wb.getElementsByTagNameNS(NS, "sheet")].find((s) => s.getAttribute("name") === name);
    if (!sheet) throw new Error('The template has no sheet called "' + name + '".');
    const rid = sheet.getAttributeNS(REL_NS, "id");
    const rel = [...this.rels("xl/workbook.xml").doc.getElementsByTagName("Relationship")].find((r) => r.getAttribute("Id") === rid);
    return new Sheet(this, resolvePath("xl/workbook.xml", rel.getAttribute("Target")));
  }

  /** A copy of cell style `id` with wrapping on and the given vertical alignment. */
  wrapStyle(id, vertical = "center") {
    id = String(id || "0");
    const cacheKey = id + "|" + vertical;
    if (this.styles.has(cacheKey)) return this.styles.get(cacheKey);
    const doc = this.xml("xl/styles.xml");
    const xfs = doc.getElementsByTagNameNS(NS, "cellXfs")[0];
    const list = [...xfs.getElementsByTagNameNS(NS, "xf")].filter((x) => x.parentNode === xfs);
    const copy = (list[Number(id)] || list[0]).cloneNode(true);
    let align = [...copy.childNodes].find((n) => n.localName === "alignment");
    if (!align) {
      align = doc.createElementNS(NS, "alignment");
      copy.insertBefore(align, copy.firstChild);
    }
    align.setAttribute("wrapText", "1");
    align.setAttribute("vertical", vertical);
    copy.setAttribute("applyAlignment", "1");
    xfs.appendChild(copy);
    xfs.setAttribute("count", String(list.length + 1));
    const newId = String(list.length);
    this.styles.set(cacheKey, newId);
    return newId;
  }

  blob() {
    for (const [path, doc] of this.docs) {
      let text = new XMLSerializer().serializeToString(doc);
      if (!text.startsWith("<?xml")) text = XML_DECL + text;
      this.files[path] = strToU8(text);
    }
    const zipped = zipSync(this.files, { level: 6 });
    return new Blob([zipped], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  }
}

class Sheet {
  constructor(book, path) {
    this.book = book;
    this.path = path;
    this.doc = book.xml(path);
    this.data = this.doc.getElementsByTagNameNS(NS, "sheetData")[0];
  }

  rows() {
    return [...this.data.getElementsByTagNameNS(NS, "row")];
  }

  rowEl(n, create) {
    const rows = this.rows();
    let row = rows.find((r) => Number(r.getAttribute("r")) === n);
    if (row || !create) return row || null;
    row = this.doc.createElementNS(NS, "row");
    row.setAttribute("r", String(n));
    this.data.insertBefore(row, rows.find((r) => Number(r.getAttribute("r")) > n) || null);
    return row;
  }

  cellEl(ref, create) {
    const { col, row: n } = splitRef(ref);
    const row = this.rowEl(n, create);
    if (!row) return null;
    const cells = [...row.getElementsByTagNameNS(NS, "c")];
    let cell = cells.find((c) => c.getAttribute("r") === ref);
    if (cell || !create) return cell || null;
    cell = this.doc.createElementNS(NS, "c");
    cell.setAttribute("r", ref);
    row.insertBefore(cell, cells.find((c) => splitRef(c.getAttribute("r")).col > col) || null);
    return cell;
  }

  text(ref) {
    const cell = this.cellEl(ref, false);
    if (!cell) return "";
    const type = cell.getAttribute("t");
    if (type === "inlineStr") return [...cell.getElementsByTagNameNS(NS, "t")].map((t) => t.textContent).join("");
    const v = cell.getElementsByTagNameNS(NS, "v")[0];
    if (!v) return "";
    return type === "s" ? this.book.shared[Number(v.textContent)] || "" : v.textContent;
  }

  /**
   * Write text or a number into a cell, keeping its formatting. "" clears it.
   * opts.size / opts.font set the text's own size and font (the template's
   * 22-26pt cells are too big for most entries); opts.wrap turns wrapping on
   * (opts.valign: "top" | "center").
   */
  set(ref, value, opts) {
    opts = opts || {};
    const cell = this.cellEl(ref, value !== "" && value != null);
    if (!cell) return;
    while (cell.firstChild) cell.removeChild(cell.firstChild);
    cell.removeAttribute("t");
    if (value === "" || value == null) return;
    if (typeof value === "number" && Number.isFinite(value)) {
      const v = this.doc.createElementNS(NS, "v");
      v.textContent = String(value);
      cell.appendChild(v);
      return;
    }
    cell.setAttribute("t", "inlineStr");
    if (opts.wrap) cell.setAttribute("s", this.book.wrapStyle(cell.getAttribute("s"), opts.valign));
    const is = this.doc.createElementNS(NS, "is");
    const t = this.doc.createElementNS(NS, "t");
    t.setAttributeNS(XML_NS, "xml:space", "preserve");
    t.textContent = String(value);
    if (opts.size || opts.font) {
      const r = this.doc.createElementNS(NS, "r");
      const rPr = this.doc.createElementNS(NS, "rPr");
      if (opts.font) { const f = this.doc.createElementNS(NS, "rFont"); f.setAttribute("val", opts.font); rPr.appendChild(f); }
      if (opts.size) { const z = this.doc.createElementNS(NS, "sz"); z.setAttribute("val", String(opts.size)); rPr.appendChild(z); }
      r.appendChild(rPr);
      r.appendChild(t);
      is.appendChild(r);
    } else {
      is.appendChild(t);
    }
    cell.appendChild(is);
  }

  /** Only rewrite a cell when its text actually differs (keeps any special formatting). */
  setText(ref, value) {
    const same = (x) => String(x || "").replace(/\s+/g, " ").trim();
    if (same(this.text(ref)) !== same(value)) this.set(ref, value || "");
  }

  /**
   * Put a PNG picture over a cell (col/row are 0-based), using the sheet's
   * existing drawing part. Returns false if the template has no drawing part.
   */
  addPicture(png, name, col, row, { dx = 0, dy = 0, width, height }) {
    const book = this.book;
    const sheetRels = book.rels(this.path).doc;
    if (!sheetRels) return false;
    const drawRel = [...sheetRels.getElementsByTagName("Relationship")].find((r) => /\/drawing$/.test(r.getAttribute("Type")));
    if (!drawRel) return false;
    const drawingPath = resolvePath(this.path, drawRel.getAttribute("Target"));
    const drawing = book.xml(drawingPath);
    let { relPath, doc: rels } = book.rels(drawingPath);
    if (!rels) {
      rels = book.parser.parseFromString('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="' + PKG_REL_NS + '"/>', "application/xml");
      book.files[relPath] = strToU8("");
      book.docs.set(relPath, rels);
    }
    // A free file name, relationship id and picture id.
    let k = 1;
    while (book.files["xl/media/line-check-" + k + ".png"]) k++;
    const media = "xl/media/line-check-" + k + ".png";
    book.files[media] = png;
    const ids = new Set([...rels.getElementsByTagName("Relationship")].map((r) => r.getAttribute("Id")));
    let rid = "rIdLc" + k;
    while (ids.has(rid)) rid += "x";
    const rel = rels.createElementNS(PKG_REL_NS, "Relationship");
    rel.setAttribute("Id", rid);
    rel.setAttribute("Type", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image");
    rel.setAttribute("Target", resolveRelative(drawingPath, media));
    rels.documentElement.appendChild(rel);
    const used = [...drawing.getElementsByTagNameNS(XDR_NS, "cNvPr")].map((e) => Number(e.getAttribute("id")) || 0);
    const picId = Math.max(1000, ...used) + 1;

    const x = (tag, ...kids) => { const e = drawing.createElementNS(XDR_NS, "xdr:" + tag); kids.forEach((c) => e.appendChild(c)); return e; };
    const a = (tag, attrs, ...kids) => {
      const e = drawing.createElementNS(A_NS, "a:" + tag);
      for (const [k2, v] of Object.entries(attrs || {})) e.setAttribute(k2, String(v));
      kids.forEach((c) => e.appendChild(c));
      return e;
    };
    const num = (tag, n) => { const e = x(tag); e.textContent = String(Math.round(n)); return e; };
    const ext = x("ext");
    ext.setAttribute("cx", String(Math.round(width * EMU)));
    ext.setAttribute("cy", String(Math.round(height * EMU)));
    const cNvPr = x("cNvPr");
    cNvPr.setAttribute("id", String(picId));
    cNvPr.setAttribute("name", name);
    const blip = a("blip");
    blip.setAttributeNS(REL_NS, "r:embed", rid);
    const anchor = x("oneCellAnchor",
      x("from", num("col", col), num("colOff", dx * EMU), num("row", row), num("rowOff", dy * EMU)),
      ext,
      x("pic",
        x("nvPicPr", cNvPr, x("cNvPicPr", a("picLocks", { noChangeAspect: 1 }))),
        x("blipFill", blip, a("stretch", null, a("fillRect"))),
        x("spPr", a("xfrm", null, a("off", { x: 0, y: 0 }), a("ext", { cx: Math.round(width * EMU), cy: Math.round(height * EMU) })), a("prstGeom", { prst: "rect" }, a("avLst")))),
      x("clientData"));
    drawing.documentElement.appendChild(anchor);
    // PNG needs a content type.
    const types = book.xml("[Content_Types].xml");
    const hasPng = [...types.documentElement.childNodes].some((n) => n.localName === "Default" && (n.getAttribute("Extension") || "").toLowerCase() === "png");
    if (!hasPng) {
      const d = types.createElementNS(types.documentElement.namespaceURI, "Default");
      d.setAttribute("Extension", "png");
      d.setAttribute("ContentType", "image/png");
      types.documentElement.insertBefore(d, types.documentElement.firstChild);
    }
    return true;
  }
}

/** Relative target from one part to another ("xl/drawings/d.xml" -> "xl/media/x.png" = "../media/x.png"). */
function resolveRelative(from, to) {
  const a = from.split("/").slice(0, -1), b = to.split("/");
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return "../".repeat(a.length - i) + b.slice(i).join("/");
}

async function openTemplate(url) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error("Couldn't load the Excel template (" + res.status + ").");
  return new Workbook(new Uint8Array(await res.arrayBuffer()));
}

/* ---------- Line check ("Horizontal" sheet) ---------- */

const MARK = { size: 20, font: "Segoe UI Symbol" };
const COMMENT = { size: 14, font: "Calibri", wrap: true };

export function lineMarkText(v) {
  v = normLine(v);
  return v.s === "ok" ? "✓" : v.s === "no" ? "✗" : "";
}

export function lineCommentText(v) {
  v = normLine(v);
  return [v.t ? v.t + "°C" : "", v.c.join(" "), v.n].filter(Boolean).join(" · ");
}

const SECTION_NAMES = ["miscellaneous", "line area", "prep kitchen"];

/** The sheet's sections and item rows: [{ name, rows: [{ n, name }] }], plus the MANAGER INITIALS row. */
function readLineSheet(sheet) {
  const sections = [];
  let cur = null;
  let initialsRow = null;
  for (const row of sheet.rows()) {
    const n = Number(row.getAttribute("r"));
    if (n < 6) continue;
    const a = sheet.text("A" + n), b = sheet.text("B" + n), e = sheet.text("E" + n), f = sheet.text("F" + n);
    if (norm(e) === "manager initials") { initialsRow = n; break; }
    if (!norm(a)) continue;
    if (norm(f) === "am" || norm(b) === "temp" || (SECTION_NAMES.includes(norm(a)) && !norm(e))) {
      cur = { name: norm(a), rows: [] };
      sections.push(cur);
      continue;
    }
    if (cur) cur.rows.push({ n, name: norm(a) });
  }
  return { sections, initialsRow };
}

/** Pair things by key first, then the leftovers in order. */
function pairUp(left, right, keyL, keyR) {
  const pairs = [];
  const freeR = right.slice();
  const unL = [];
  for (const l of left) {
    const i = freeR.findIndex((r) => keyR(r) === keyL(l));
    if (i >= 0) pairs.push([l, freeR.splice(i, 1)[0]]);
    else unL.push(l);
  }
  while (unL.length && freeR.length) pairs.push([unL.shift(), freeR.shift()]);
  return { pairs, leftL: unL, leftR: freeR };
}

/** Returns { blob, missing } - missing lists items the Excel sheet has no row for. */
export async function lineCheckWorkbook(record, url = LINE_TEMPLATE) {
  const book = await openTemplate(url);
  const sheet = book.sheet("Horizontal");
  const { sections, initialsRow } = readLineSheet(sheet);
  const missing = [];

  const secPairs = pairUp(record.tpl.line, sections, (s) => norm(s.name), (s) => s.name);
  for (const s of secPairs.leftL) missing.push(...s.items.map((it) => it.name));
  for (const s of secPairs.leftR) for (const r of s.rows) for (const col of "FGHI") sheet.set(col + r.n, "");

  for (const [appSec, xlSec] of secPairs.pairs) {
    const rowPairs = pairUp(appSec.items, xlSec.rows, (it) => norm(it.name), (r) => r.name);
    for (const [item, r] of rowPairs.pairs) {
      const n = r.n;
      sheet.setText("A" + n, item.name);
      if (appSec.columns) {
        sheet.setText("B" + n, item.temp);
        sheet.setText("C" + n, item.life);
        sheet.setText("D" + n, item.utensil);
      }
      sheet.setText("E" + n, item.quality);
      const am = fieldValue(record, lineKey(item.id, "am"));
      const pm = fieldValue(record, lineKey(item.id, "pm"));
      sheet.set("F" + n, lineMarkText(am), MARK);
      sheet.set("G" + n, lineCommentText(am), COMMENT);
      sheet.set("H" + n, lineMarkText(pm), MARK);
      sheet.set("I" + n, lineCommentText(pm), COMMENT);
    }
    for (const r of rowPairs.leftR) for (const col of "FGHI") sheet.set(col + r.n, "");
    for (const item of rowPairs.leftL) if (fieldValue(record, lineKey(item.id, "am")) || fieldValue(record, lineKey(item.id, "pm"))) missing.push(item.name);
  }

  sheet.set("F4", slashDate(record.date));
  if (initialsRow) {
    for (const [shift, mark, nameCol, colIndex] of [["am", "F", "G", 6], ["pm", "H", "I", 8]]) {
      const s = C.signedBy(record, shift);
      sheet.set(mark + initialsRow, s ? s.i || C.initialsOf(s.name) : "", { size: 14, font: "Calibri" });
      sheet.set(nameCol + initialsRow, s ? (s.name || s.i) + (s.at ? " · " + timeOf(s.at) : "") : "", { size: 11, font: "Calibri", wrap: true, valign: "top" });
      if (s && isSig(s.sig)) {
        try {
          const png = await sigPng(s.sig, 520, 156);
          sheet.addPicture(png, "Signature " + shift.toUpperCase(), colIndex, initialsRow - 1, { dx: 3, dy: 22, width: 130, height: 39 });
        } catch { /* the name and time are there; the picture is a bonus */ }
      }
    }
  }
  return { blob: book.blob(), missing };
}

/* ---------- Temperature Checklist ---------- */

const FRIDGE_COLS = { food: "B", open: "D", "12i": "E", "12f": "F", "16i": "G", "16f": "H", "20i": "I", "20f": "J", close: "K", ca: "L" };
const HOT_COLS = { food: "B", 12: "E", 16: "G", 20: "I", ca: "L" };

export async function temperatureWorkbook(record, url = TEMP_TEMPLATE) {
  const book = await openTemplate(url);
  const sheet = book.sheet("Temperature");
  const T = record.tpl.temps;
  const val = (rowId, slot) => {
    const v = fieldValue(record, tempKey(rowId, slot));
    return v == null ? "" : String(v);
  };
  const num = (rowId, slot) => {
    const v = val(rowId, slot);
    const n = parseTemp(v);
    return n == null ? v : n;
  };
  const TEXT = { size: 14, font: "Calibri", wrap: true };

  sheet.set("A3", "Date : " + slashDate(record.date));
  const who = C.SHIFTS.map((sh) => {
    const s = C.signedBy(record, sh);
    return s ? C.SHIFT_NAME[sh] + ": " + (s.name || s.i) + " " + timeOf(s.at) : "";
  }).filter(Boolean);
  if (who.length) sheet.set("D3", "Checked and signed - " + who.join("   ·   "), { size: 14, font: "Calibri" });

  const blankName = (row, n) => {
    if (!row.name && val(row.id, "name")) sheet.set("A" + n, val(row.id, "name"));
  };

  T.fridges.slice(0, 14).forEach((row, i) => {
    const n = 7 + i;
    blankName(row, n);
    for (const [slot] of FRIDGE_SLOTS) sheet.set(FRIDGE_COLS[slot] + n, num(row.id, slot));
    sheet.set("B" + n, val(row.id, "food"), TEXT);
    sheet.set("L" + n, val(row.id, "ca"), TEXT);
  });

  T.hot.slice(0, 8).forEach((row, i) => {
    const n = 21 + i;
    blankName(row, n);
    for (const [slot] of HOT_SLOTS) sheet.set(HOT_COLS[slot] + n, num(row.id, slot));
    sheet.set("B" + n, val(row.id, "food"), TEXT);
    sheet.set("L" + n, val(row.id, "ca"), TEXT);
  });
  // Dish washer (row 29): "wash / rinse" (older days kept "66/84" in one box).
  for (const [slot] of HOT_SLOTS) {
    const w = val("dish", slot + "w"), r = val("dish", slot + "r");
    sheet.set(HOT_COLS[slot] + "29", w || r ? (w || "–") + " / " + (r || "–") : val("dish", slot));
  }
  sheet.set("L29", val("dish", "ca"), TEXT);

  [["B", "C", "D"], ["E", "F", "G"], ["H", "I", "J"], ["K", "L", "M"]].forEach(([t, p, notes], i) => {
    const f = T.fryers[i];
    if (!f) return;
    sheet.set(t + "33", num(f.id, "temp"));
    sheet.set(p + "33", num(f.id, "tpm"));
    sheet.set(notes + "33", val(f.id, "notes"), TEXT);
  });

  for (const [rows, valueRow, notesRow] of [[T.grill, 37, 36], [T.flat, 40, 39]]) {
    [["E", "F", "G"], ["H", "I", "J"], ["K", "L", "M"]].forEach(([am, pm, notes], i) => {
      const r = rows[i];
      if (!r) return;
      sheet.set(am + valueRow, num(r.id, "am"));
      sheet.set(pm + valueRow, num(r.id, "pm"));
      sheet.set(notes + notesRow, val(r.id, "notes"), TEXT);
    });
  }

  // Cover page: café and date.
  try {
    const cover = book.sheet("Cover");
    cover.set("D11", "Dublin");
    cover.set("D13", slashDate(record.date));
    cover.set("D15", slashDate(record.date));
  } catch { /* template without a cover */ }

  return { blob: book.blob() };
}

export function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 10000);
}
