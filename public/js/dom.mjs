/*
 * Tiny DOM helpers. Everything is built with createElement/textContent,
 * never innerHTML, so nothing typed in a comment can turn into markup.
 */
const SVG_NS = "http://www.w3.org/2000/svg";

// Lucide icons (ISC licence) as [tag, attributes] lists.
const ICONS = {
  check: [["path", { d: "M20 6 9 17l-5-5" }]],
  alert: [["path", { d: "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" }], ["path", { d: "M12 9v4" }], ["path", { d: "M12 17h.01" }]],
  left: [["path", { d: "m15 18-6-6 6-6" }]],
  right: [["path", { d: "m9 18 6-6-6-6" }]],
  down: [["path", { d: "m6 9 6 6 6-6" }]],
  printer: [["path", { d: "M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" }], ["path", { d: "M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6" }], ["rect", { x: 6, y: 14, width: 12, height: 8, rx: 1 }]],
  list: [["path", { d: "M3 12h.01" }], ["path", { d: "M3 18h.01" }], ["path", { d: "M3 6h.01" }], ["path", { d: "M8 12h13" }], ["path", { d: "M8 18h13" }], ["path", { d: "M8 6h13" }]],
  thermo: [["path", { d: "M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z" }]],
  cloud: [["path", { d: "M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" }]],
  cloudOff: [["path", { d: "m2 2 20 20" }], ["path", { d: "M5.782 5.782A7 7 0 0 0 9 19h8.5a4.5 4.5 0 0 0 1.307-.193" }], ["path", { d: "M21.532 16.5A4.5 4.5 0 0 0 17.5 10h-1.79A7.008 7.008 0 0 0 10 5.07" }]],
  lock: [["rect", { width: 18, height: 11, x: 3, y: 11, rx: 2, ry: 2 }], ["path", { d: "M7 11V7a5 5 0 0 1 10 0v4" }]],
  unlock: [["rect", { width: 18, height: 11, x: 3, y: 11, rx: 2, ry: 2 }], ["path", { d: "M7 11V7a5 5 0 0 1 9.9-1" }]],
  calendar: [["path", { d: "M8 2v4" }], ["path", { d: "M16 2v4" }], ["rect", { width: 18, height: 18, x: 3, y: 4, rx: 2 }], ["path", { d: "M3 10h18" }]],
  checks: [["path", { d: "M18 6 7 17l-5-5" }], ["path", { d: "m22 10-7.5 7.5L13 16" }]],
  download: [["path", { d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" }], ["path", { d: "m7 10 5 5 5-5" }], ["path", { d: "M12 15V3" }]],
  upload: [["path", { d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" }], ["path", { d: "m17 8-5-5-5 5" }], ["path", { d: "M12 3v12" }]],
  info: [["circle", { cx: 12, cy: 12, r: 10 }], ["path", { d: "M12 16v-4" }], ["path", { d: "M12 8h.01" }]],
};

export function icon(name, size) {
  const svg = document.createElementNS(SVG_NS, "svg");
  const attrs = { viewBox: "0 0 24 24", width: size || 18, height: size || 18, fill: "none", stroke: "currentColor",
    "stroke-width": 2.2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false" };
  for (const k in attrs) svg.setAttribute(k, attrs[k]);
  for (const [tag, a] of ICONS[name] || []) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const k in a) el.setAttribute(k, a[k]);
    svg.appendChild(el);
  }
  return svg;
}

/**
 * h("button", { class: "x", onclick: fn, text: "Hi" }, child, [children])
 * "on*" keys add listeners; class/text/value/checked/disabled/hidden are properties.
 */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "text") el.textContent = value;
    else if (["value", "checked", "disabled", "hidden", "selected"].includes(key)) el[key] = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? "" : value);
  }
  append(el, children);
  return el;
}

export function append(parent, child) {
  if (child == null || child === false) return;
  if (Array.isArray(child)) child.forEach((c) => append(parent, c));
  else parent.appendChild(typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child);
}

export function replace(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}
