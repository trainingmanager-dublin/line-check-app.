/*
 * Fills in the original Excel templates (public/templates/) and hands them
 * back as a download, so the result is the same file as the paper process,
 * with the same layout, logo and print settings - just filled in.
 *
 * Only the cell values are touched: the workbook is unzipped, the sheet XML
 * edited, and zipped again.
 */
import { unzipSync, zipSync, strToU8, strFromU8 } from "../vendor/fflate.mjs";
import {
  normLine, fieldValue, lineKey, signKey, tempKey, parseTemp, FRIDGE_SLOTS, HOT_SLOTS,
} from "./core.mjs";

const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const XML_NS = "http://www.w3.org/XML/1998/namespace";
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';

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

class Workbook {
  constructor(bytes) {
    this.files = unzipSync(bytes);
    this.parser = new DOMParser();
    this.docs = new Map();
    this.wrapped = new Map();
    this.shared = [];
    if (this.files["xl/sharedStrings.xml"]) {
      const doc = this.xml("xl/sharedStrings.xml");
      this.shared = [...doc.getElementsByTagNameNS(NS, "si")].map((si) =>
        [...si.getElementsByTagNameNS(NS, "t")].filter((t) => t.parentNode.localName !== "rPh").map((t) => t.textContent).join(""));
    }
  }

  xml(path) {
    if (!this.docs.has(path)) {
      const doc = this.parser.parseFromString(strFromU8(this.files[path]), "application/xml");
      if (doc.getElementsByTagName("parsererror").length) throw new Error("Couldn't read " + path + " in the template.");
      this.docs.set(path, doc);
    }
    return this.docs.get(path);
  }

  sheet(name) {
    const wb = this.xml("xl/workbook.xml");
    const sheet = [...wb.getElementsByTagNameNS(NS, "sheet")].find((s) => s.getAttribute("name") === name);
    if (!sheet) throw new Error('The template has no sheet called "' + name + '".');
    const rid = sheet.getAttributeNS(REL_NS, "id");
    const rels = this.xml("xl/_rels/workbook.xml.rels");
    const rel = [...rels.getElementsByTagName("Relationship")].find((r) => r.getAttribute("Id") === rid);
    const target = rel.getAttribute("Target").replace(/^\/?xl\//, "").replace(/^\//, "");
    return new Sheet(this, "xl/" + target);
  }

  /** A copy of cell style `id` with text wrapping on (for comments). */
  wrapStyle(id) {
    id = String(id || "0");
    if (this.wrapped.has(id)) return this.wrapped.get(id);
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
    align.setAttribute("vertical", "center");
    copy.setAttribute("applyAlignment", "1");
    xfs.appendChild(copy);
    xfs.setAttribute("count", String(list.length + 1));
    const newId = String(list.length);
    this.wrapped.set(id, newId);
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
   * 22-26pt cells are too big for most entries); opts.wrap turns wrapping on.
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
    if (opts.wrap) cell.setAttribute("s", this.book.wrapStyle(cell.getAttribute("s")));
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
}

async function openTemplate(url) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error("Couldn't load the Excel template (" + res.status + ").");
  return new Workbook(new Uint8Array(await res.arrayBuffer()));
}

function slashDate(date) {
  const [y, m, d] = date.split("-");
  return d + "/" + m + "/" + y;
}

function timeOf(iso) {
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleTimeString("en-IE", { hour: "2-digit", minute: "2-digit" });
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

/**
 * Returns { blob, missing } - missing lists items the app has that the
 * Excel sheet doesn't (so they couldn't be written into it).
 */
export async function lineCheckWorkbook(record, url = LINE_TEMPLATE) {
  const book = await openTemplate(url);
  const sheet = book.sheet("Horizontal");

  // Items still to place, by section then name, in order.
  const queue = new Map();
  for (const section of record.tpl.line) {
    for (const item of section.items) {
      const k = norm(section.name) + "|" + norm(item.name);
      if (!queue.has(k)) queue.set(k, []);
      queue.get(k).push(item);
    }
  }
  const placed = new Set();

  let section = null;
  let initialsRow = null;
  for (const row of sheet.rows()) {
    const n = Number(row.getAttribute("r"));
    if (n < 6) continue;
    const a = sheet.text("A" + n), b = sheet.text("B" + n), e = sheet.text("E" + n), f = sheet.text("F" + n);
    if (norm(e) === "manager initials") { initialsRow = n; break; }
    if (!norm(a)) continue;
    if (norm(f) === "am" || norm(b) === "temp" || (["miscellaneous", "line area", "prep kitchen"].includes(norm(a)) && !norm(e))) {
      section = norm(a);
      continue;
    }
    const list = queue.get(section + "|" + norm(a));
    const item = list && list.shift();
    const am = item ? fieldValue(record, lineKey(item.id, "am")) : null;
    const pm = item ? fieldValue(record, lineKey(item.id, "pm")) : null;
    sheet.set("F" + n, lineMarkText(am), MARK);
    sheet.set("G" + n, lineCommentText(am), COMMENT);
    sheet.set("H" + n, lineMarkText(pm), MARK);
    sheet.set("I" + n, lineCommentText(pm), COMMENT);
    if (item) placed.add(item.id);
  }

  sheet.set("F4", slashDate(record.date));
  if (initialsRow) {
    for (const [shift, mark, time] of [["am", "F", "G"], ["pm", "H", "I"]]) {
      const s = fieldValue(record, signKey(shift));
      sheet.set(mark + initialsRow, s && s.i ? s.i : "", { size: 14, font: "Calibri" });
      sheet.set(time + initialsRow, s && s.at ? timeOf(s.at) : "", { size: 12, font: "Calibri" });
    }
  }

  const missing = record.tpl.line.flatMap((s) => s.items).filter((it) => !placed.has(it.id) && !isEmptyItem(record, it.id)).map((it) => it.name);
  return { blob: book.blob(), missing };
}

function isEmptyItem(record, id) {
  return !fieldValue(record, lineKey(id, "am")) && !fieldValue(record, lineKey(id, "pm"));
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

  sheet.set("A3", "Date : " + slashDate(record.date));

  const TEXT = { size: 14, font: "Calibri", wrap: true };
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

  [...T.hot.slice(0, 8), T.dish].forEach((row, i) => {
    const n = 21 + i;
    blankName(row, n);
    for (const [slot] of HOT_SLOTS) sheet.set(HOT_COLS[slot] + n, row === T.dish ? val(row.id, slot) : num(row.id, slot));
    sheet.set("B" + n, val(row.id, "food"), TEXT);
    sheet.set("L" + n, val(row.id, "ca"), TEXT);
  });

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
