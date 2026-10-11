/*
 * Printouts laid out like the paper templates:
 *   - Line Check Sheet (Item | Temp | Shelf Life | Utensil | Quality Identifiers | AM | COMMENT | PM | COMMENT)
 *   - Temperature Checklist (fridges by time of day, hot holding, fryers, grill, flat top)
 */
import { h } from "./dom.mjs";
import {
  normLine, fieldValue, lineKey, signKey, tempKey, judgeTemp, dishBad, FRIDGE_SLOTS, HOT_SLOTS, prettyDate,
} from "./core.mjs";

const LOGO = "img/hard-rock-logo-dark.png";

function slashDate(date) {
  const [y, m, d] = date.split("-");
  return d + "/" + m + "/" + y;
}

function timeOf(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleTimeString("en-IE", { hour: "2-digit", minute: "2-digit" });
}

function lineMark(v, item) {
  v = normLine(v);
  const parts = [];
  if (v.s === "ok") parts.push(h("span", { class: "pm-ok", text: "✓" }));
  if (v.s === "no") parts.push(h("span", { class: "pm-no", text: "✗" }));
  if (v.t) parts.push(h("span", { class: judgeTemp(v.t, item.limit) === "bad" ? "pm-bad" : "", text: " " + v.t + "°" }));
  if (v.c.length) parts.push(h("span", { class: "pm-codes", text: " " + v.c.join(" ") }));
  return parts;
}

export function linePrint(record) {
  const tpl = record.tpl;
  const sign = { am: fieldValue(record, signKey("am")), pm: fieldValue(record, signKey("pm")) };
  const cols = h("colgroup", null,
    ["c-item", "c-temp", "c-life", "c-ut", "c-q", "c-mark", "c-com", "c-mark", "c-com"].map((c) => h("col", { class: c })));

  const head = h("thead", null,
    h("tr", { class: "p-top" },
      h("td", { class: "p-brand" }, h("div", { text: "Hard Rock Cafe" }), h("div", { class: "p-title", text: "Line Check Sheet" })),
      h("td", { colspan: 4, class: "p-gloss" },
        h("div", { class: "p-gloss-title", text: "Glossary of Shorthand" }),
        h("div", { class: "p-gloss-grid" }, tpl.glossary.map(([k, v]) => [h("b", { text: k + " =" }), h("span", { text: v })]))),
      h("td", { colspan: 2, class: "p-date" }, h("div", { class: "p-date-label", text: "Date" }), h("div", { class: "p-date-value", text: slashDate(record.date) }),
        h("div", { class: "p-day", text: prettyDate(record.date, { weekday: "long" }) })),
      h("td", { colspan: 2, class: "p-logo" }, h("img", { src: LOGO, alt: "Hard Rock Cafe" }))));

  const body = h("tbody");
  for (const section of tpl.line) {
    body.appendChild(h("tr", { class: "p-sec" },
      h("th", { text: section.name }),
      section.columns ? ["Temp", "Shelf Life", "Utensil", "Quality Identifiers"].map((t) => h("th", { text: t })) : h("th", { colspan: 4 }),
      ["AM", "COMMENT", "PM", "COMMENT"].map((t) => h("th", { class: "p-small", text: t }))));
    for (const item of section.items) {
      const am = fieldValue(record, lineKey(item.id, "am"));
      const pm = fieldValue(record, lineKey(item.id, "pm"));
      body.appendChild(h("tr", null,
        h("td", { class: "p-name", text: item.name }),
        h("td", { class: "p-small", text: item.temp }),
        h("td", { class: "p-center", text: item.life }),
        h("td", { class: "p-center p-small", text: item.utensil }),
        h("td", { class: "p-q", text: item.quality }),
        h("td", { class: "p-mark" }, lineMark(am, item)),
        h("td", { class: "p-com", text: normLine(am).n }),
        h("td", { class: "p-mark" }, lineMark(pm, item)),
        h("td", { class: "p-com", text: normLine(pm).n })));
    }
  }
  body.appendChild(h("tr", { class: "p-initials" },
    h("td", { colspan: 4 }),
    h("td", { class: "p-right", text: "MANAGER INITIALS" }),
    h("td", { class: "p-mark", text: (sign.am && sign.am.i) || "" }),
    h("td", { class: "p-com", text: sign.am && sign.am.at ? "Signed " + timeOf(sign.am.at) : "" }),
    h("td", { class: "p-mark", text: (sign.pm && sign.pm.i) || "" }),
    h("td", { class: "p-com", text: sign.pm && sign.pm.at ? "Signed " + timeOf(sign.pm.at) : "" })));

  return h("section", { class: "print-doc print-line" },
    h("table", { class: "p-table" }, cols, head, body),
    h("p", { class: "p-foot", text: "✓ = OK   ✗ = not OK (see comment)   Temperatures in °C. Printed " + new Date().toLocaleString("en-IE") + "." }));
}

/* ---------- Temperature Checklist ---------- */

function cellText(record, rowId, slot) {
  const v = fieldValue(record, tempKey(rowId, slot));
  return v == null ? "" : String(v);
}

function tempCell(record, row, slot, attrs) {
  const text = cellText(record, row.id, slot);
  const bad = row.limit && judgeTemp(text, row.limit) === "bad";
  return h("td", Object.assign({ class: "p-center" + (bad ? " pm-bad" : "") }, attrs || {}), text);
}


export function tempPrint(record) {
  const T = record.tpl.temps;
  const name = (row, label) => (row.name || cellText(record, row.id, "name")) + (label ? " (" + label + ")" : "");
  const lim = (l) => (l.max != null ? l.max + "°C" : l.min + "°C");

  const main = h("table", { class: "p-table t-main" },
    h("colgroup", null, h("col", { class: "t-station" }), h("col", { class: "t-food" }),
      Array.from({ length: 8 }, () => h("col", { class: "t-val" })), h("col", { class: "t-ca" })),
    h("thead", null,
      h("tr", null,
        h("th", { rowspan: 3, class: "t-big", text: "Station" }), h("th", { rowspan: 3, text: "Food Item" }),
        h("th", { colspan: 8, text: "TEMPERATURES" }), h("th", { rowspan: 3, text: "CORRECTIVE ACTION" })),
      h("tr", null, h("th", { text: "OPENING" }), h("th", { colspan: 2, text: "12:00" }), h("th", { colspan: 2, text: "16:00" }),
        h("th", { colspan: 2, text: "20:00" }), h("th", { text: "CLOSING" })),
      h("tr", null, FRIDGE_SLOTS.map(([, , kind]) => h("th", { class: "p-small", text: kind })))),
    h("tbody", null,
      T.fridges.map((row) => h("tr", null,
        h("td", { class: "p-name", text: name(row, lim(row.limit)) }),
        h("td", { class: "p-small", text: cellText(record, row.id, "food") }),
        FRIDGE_SLOTS.map(([slot]) => tempCell(record, row, slot)),
        h("td", { class: "p-com", text: cellText(record, row.id, "ca") }))),
      h("tr", { class: "t-gap" }, h("td", { colspan: 11 })),
      [...T.hot, T.dish].map((row) => h("tr", null,
        h("td", { class: "p-name", text: row === T.dish ? row.name + " (" + row.label + ")" : name(row, lim(row.limit)) }),
        h("td", { class: "p-small", text: cellText(record, row.id, "food") }),
        h("td", { class: "t-black" }),
        HOT_SLOTS.map(([slot]) => row === T.dish
          ? h("td", { colspan: 2, class: "p-center" + (dishBad(cellText(record, row.id, slot), row.limit) ? " pm-bad" : ""), text: cellText(record, row.id, slot) })
          : tempCell(record, row, slot, { colspan: 2 })),
        h("td", { class: "t-black" }),
        h("td", { class: "p-com", text: cellText(record, row.id, "ca") })))));

  const fryer = h("table", { class: "p-table t-side" },
    h("tbody", null,
      h("tr", null, h("th", { rowspan: 3, class: "t-big", text: "FRYER" }),
        T.fryers.map((f) => [h("th", { colspan: 2, class: "p-small", text: f.name + " - " + f.target + "°C (" + f.use + ")" }), h("th", { rowspan: 2, class: "p-small", text: "NOTES" })])),
      h("tr", null, T.fryers.map(() => [h("th", { class: "p-small", text: "TEMP" }), h("th", { class: "p-small", text: "TPM %" })])),
      h("tr", null, T.fryers.map((f) => [
        h("td", { class: "p-center", text: cellText(record, f.id, "temp") }),
        h("td", { class: "p-center", text: cellText(record, f.id, "tpm") }),
        h("td", { class: "p-com", text: cellText(record, f.id, "notes") })]))));

  const surface = (title, rows) => h("table", { class: "p-table t-side" },
    h("tbody", null,
      h("tr", null, h("th", { rowspan: 3, class: "t-big", text: title }),
        h("td", { rowspan: 3, class: "p-small t-targets" }, rows.map((r) => h("div", { text: r.name + " - " + r.target + "°C" }))),
        rows.map((r) => [h("th", { colspan: 2, class: "p-small", text: r.name }), h("th", { class: "p-small", text: "NOTES" })])),
      h("tr", null, rows.map((r) => [h("th", { class: "p-small", text: "AM" }), h("th", { class: "p-small", text: "PM" }),
        h("td", { rowspan: 2, class: "p-com", text: cellText(record, r.id, "notes") })])),
      h("tr", null, rows.map((r) => [
        h("td", { class: "p-center", text: cellText(record, r.id, "am") }),
        h("td", { class: "p-center", text: cellText(record, r.id, "pm") })]))));

  return h("section", { class: "print-doc print-temps" },
    h("div", { class: "t-head" },
      h("div", { class: "t-date", text: "Date : " + slashDate(record.date) + "  (" + prettyDate(record.date, { weekday: "long" }) + ")" }),
      h("h1", { text: "Temperature Checklist" }),
      h("img", { src: LOGO, alt: "Hard Rock Cafe" })),
    main, fryer, surface("GRILL", T.grill), surface("FLAT TOP", T.flat),
    h("p", { class: "p-foot", text: "This page is for one day. Readings in °C; out-of-range readings are shown in bold red. Printed " + new Date().toLocaleString("en-IE") + "." }));
}
