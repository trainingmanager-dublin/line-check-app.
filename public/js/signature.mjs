/*
 * Finger-drawn signatures.
 *
 * Stored as strokes of points on a 1000 x 300 grid: { w, h, s: [[x, y, x, y, ...], ...] }
 * (a few KB), so they print sharply at any size and fit in a normal box.
 */
import { h } from "./dom.mjs";

export const SIG_W = 1000;
export const SIG_H = 300;
/** Kept well under core.MAX_VALUE_CHARS together with the name and time. */
export const MAX_SIG_CHARS = 30000;

/** Drop points closer than `tol` to the last one kept (always keeps the ends). */
export function simplify(flat, tol) {
  if (flat.length <= 4) return flat.slice();
  const out = [flat[0], flat[1]];
  for (let i = 2; i < flat.length - 2; i += 2) {
    const dx = flat[i] - out[out.length - 2], dy = flat[i + 1] - out[out.length - 1];
    if (dx * dx + dy * dy >= tol * tol) out.push(flat[i], flat[i + 1]);
  }
  out.push(flat[flat.length - 2], flat[flat.length - 1]);
  return out;
}

/** Strokes (arrays of numbers) -> a stored signature, simplified until it fits. Null if empty. */
export function encodeSig(strokes) {
  const clean = (strokes || [])
    .map((s) => s.map((n, i) => Math.max(0, Math.min(i % 2 ? SIG_H : SIG_W, Math.round(n)))))
    .filter((s) => s.length >= 2);
  if (!clean.length) return null;
  const fits = (sig) => JSON.stringify(sig).length <= MAX_SIG_CHARS;
  for (let tol = 2; tol <= 256; tol *= 2) {
    const sig = { w: SIG_W, h: SIG_H, s: clean.map((s) => simplify(s, tol)) };
    if (fits(sig)) return sig;
  }
  // An extreme scribble: keep as many strokes as fit (always at least the first).
  const coarse = clean.map((s) => simplify(s, 256));
  for (let n = coarse.length; n > 1; n--) {
    const sig = { w: SIG_W, h: SIG_H, s: coarse.slice(0, n) };
    if (fits(sig)) return sig;
  }
  return { w: SIG_W, h: SIG_H, s: [coarse[0].slice(0, 2000)] };
}

export function isSig(v) {
  return !!(v && v.w > 0 && v.h > 0 && Array.isArray(v.s) && v.s.some((s) => Array.isArray(s) && s.length >= 2));
}

/** SVG path data for a signature (smoothed through the midpoints). */
export function sigPath(sig) {
  if (!isSig(sig)) return "";
  return sig.s.map((p) => {
    if (p.length <= 2) return `M${p[0]} ${p[1]}h0.1`;
    let d = `M${p[0]} ${p[1]}`;
    for (let i = 2; i < p.length - 2; i += 2) {
      const mx = (p[i] + p[i + 2]) / 2, my = (p[i + 1] + p[i + 3]) / 2;
      d += `Q${p[i]} ${p[i + 1]} ${mx} ${my}`;
    }
    return d + `L${p[p.length - 2]} ${p[p.length - 1]}`;
  }).join("");
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** An <svg> of the signature (screens and printouts). */
export function sigSvg(sig, cls) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${SIG_W} ${SIG_H}`);
  svg.setAttribute("class", "sig " + (cls || ""));
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Signature");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", sigPath(sig));
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "9");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.appendChild(path);
  return svg;
}

function drawOn(ctx2d, sig, width, height, lineWidth) {
  const sx = width / SIG_W, sy = height / SIG_H;
  ctx2d.lineCap = "round";
  ctx2d.lineJoin = "round";
  ctx2d.lineWidth = lineWidth;
  ctx2d.strokeStyle = "#000";
  for (const p of sig.s) {
    ctx2d.beginPath();
    ctx2d.moveTo(p[0] * sx, p[1] * sy);
    if (p.length <= 2) ctx2d.lineTo(p[0] * sx + 0.1, p[1] * sy);
    for (let i = 2; i < p.length - 2; i += 2) {
      ctx2d.quadraticCurveTo(p[i] * sx, p[i + 1] * sy, ((p[i] + p[i + 2]) / 2) * sx, ((p[i + 1] + p[i + 3]) / 2) * sy);
    }
    if (p.length > 2) ctx2d.lineTo(p[p.length - 2] * sx, p[p.length - 1] * sy);
    ctx2d.stroke();
  }
}

/** PNG bytes of the signature (for the Excel file). */
export function sigPng(sig, width = 400, height = 120) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  drawOn(canvas.getContext("2d"), sig, width, height, Math.max(2, width / 160));
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? b.arrayBuffer().then((a) => resolve(new Uint8Array(a)), reject) : reject(new Error("No PNG"))), "image/png"));
}

/**
 * The drawing pad. Returns { el, isEmpty(), value(), clear() }.
 * onChange(empty) is called after each stroke and on clear.
 */
export function createPad(onChange) {
  const canvas = h("canvas", { class: "sig-canvas", "aria-label": "Sign here with your finger" });
  const strokes = [];
  let current = null;

  const resize = () => {
    const box = canvas.getBoundingClientRect();
    if (!box.width) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(box.width * ratio);
    canvas.height = Math.round(box.height * ratio);
    redraw();
  };
  const redraw = () => {
    const c = canvas.getContext("2d");
    c.clearRect(0, 0, canvas.width, canvas.height);
    const all = current ? strokes.concat([current]) : strokes;
    if (all.length) drawOn(c, { s: all }, canvas.width, canvas.height, Math.max(2, canvas.width / 220));
  };
  const point = (e) => {
    const box = canvas.getBoundingClientRect();
    return [((e.clientX - box.left) / box.width) * SIG_W, ((e.clientY - box.top) / box.height) * SIG_H];
  };

  canvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    current = point(e);
    redraw();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!current) return;
    e.preventDefault();
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of events.length ? events : [e]) current.push(...point(ev));
    redraw();
  });
  const end = () => {
    if (!current) return;
    strokes.push(current);
    current = null;
    redraw();
    onChange(false);
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);

  const clearBtn = h("button", { type: "button", class: "btn small ghost", text: "Clear", onclick: () => { strokes.length = 0; current = null; redraw(); onChange(true); } });
  const el = h("div", { class: "sig-pad" },
    h("div", { class: "sig-box" }, canvas, h("span", { class: "sig-line", "aria-hidden": "true", text: "✕" })),
    h("div", { class: "sig-actions" }, h("span", { class: "muted", text: "Sign with your finger" }), clearBtn));
  requestAnimationFrame(resize);
  window.addEventListener("resize", resize);

  return {
    el,
    isEmpty: () => !strokes.length,
    value: () => encodeSig(strokes),
    clear: () => clearBtn.click(),
    destroy: () => window.removeEventListener("resize", resize),
  };
}
