/*
 * Shared state and helpers for the screens. app.mjs fills in the parts that
 * need the store and the renderer when it starts.
 */
import { h, replace } from "./dom.mjs";
import * as C from "./core.mjs";

export function sessionGet(key) { try { return sessionStorage.getItem(key); } catch { return null; } }
export function sessionSet(key, v) { try { sessionStorage.setItem(key, v); } catch { /* ignore */ } }
export function prefGet(key, fallback) { try { const v = localStorage.getItem("lc:pref:" + key); return v == null ? fallback : v; } catch { return fallback; } }
export function prefSet(key, v) { try { localStorage.setItem("lc:pref:" + key, String(v)); } catch { /* ignore */ } }

export const ctx = {
  state: {
    date: null,
    shift: "am",
    view: "line",
    todo: prefGet("todo", "0") === "1",       // line check: show only what's left
    photos: prefGet("photos", "0") === "1",   // camera buttons on
    open: new Set(),                          // line items with their note panel open
    month: null,
  },
  store: null,
  /** line item id -> { update(), el } ; temperature field key -> { update() } */
  rows: new Map(),
  fields: new Map(),
  render: () => {},
  refresh: () => {},
  goToDate: async () => {},
};

export const day = () => ctx.store.current();
export const value = (key) => C.fieldValue(day(), key);
export const signed = (shift) => C.signedBy(day(), shift);

export function save(key, v) {
  const ok = ctx.store.set(key, v);
  if (!ok) toast("NOT saved - the tablet's storage is full or blocked. Print the sheet now.", "error");
  return ok;
}

/* ---------- Toasts ---------- */

export function toast(message, tone, action) {
  const box = document.getElementById("toasts");
  if (!box) return;
  const el = h("div", { class: "toast " + (tone || "ok"), role: tone === "error" ? "alert" : "status" },
    h("span", { text: message }),
    action ? h("button", { class: "toast-btn", type: "button", text: action.label, onclick: () => { el.remove(); action.run(); } }) : null);
  box.appendChild(el);
  // Only the latest two stay, so a run of taps doesn't cover the screen.
  while (box.children.length > 2) box.firstElementChild.remove();
  const life = action ? 8000 : tone === "error" ? 7000 : 3800;
  setTimeout(() => el.classList.add("out"), life - 500);
  setTimeout(() => el.remove(), life);
}

/* ---------- Errors: entries are already saved, so say so and offer a reload ---------- */

export function crashed(err) {
  console.error(err);
  const bar = document.getElementById("crash");
  if (bar) bar.hidden = false;
}

export function safe(fn) {
  return function (...args) {
    try {
      const r = fn.apply(this, args);
      if (r && typeof r.catch === "function") r.catch(crashed);
      return r;
    } catch (err) {
      crashed(err);
      return undefined;
    }
  };
}

/* ---------- Dialogs ---------- */

let openDialog = null;

/** A simple modal sheet. Returns { el, close }. */
export function modal(title, body, opts = {}) {
  closeModal();
  const root = document.getElementById("modal-root");
  const close = () => {
    if (openDialog !== api) return;
    openDialog = null;
    replace(root);
    document.body.classList.remove("modal-open");
    if (opts.onClose) opts.onClose();
  };
  const panel = h("div", { class: "sheet" + (opts.wide ? " wide" : ""), role: "dialog", "aria-modal": "true", "aria-label": title },
    h("div", { class: "sheet-head" },
      h("h2", { text: title }),
      h("button", { class: "icon-btn sheet-close", type: "button", "aria-label": "Close", onclick: close, text: "✕" })),
    h("div", { class: "sheet-body" }, body));
  const backdrop = h("div", { class: "backdrop", onclick: (e) => { if (e.target === backdrop && !opts.sticky) close(); } }, panel);
  replace(root, backdrop);
  document.body.classList.add("modal-open");
  const api = { el: panel, close };
  openDialog = api;
  return api;
}

export function closeModal() {
  if (openDialog) openDialog.close();
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && openDialog) openDialog.close();
});

/* ---------- Names used for signing (the two or three managers) ---------- */

export const names = {
  list() {
    try { return JSON.parse(localStorage.getItem("lc:names") || "[]").filter((n) => typeof n === "string" && n.trim()); } catch { return []; }
  },
  remember(name) {
    name = String(name || "").trim();
    if (!name) return;
    const list = [name, ...names.list().filter((n) => n.toLowerCase() !== name.toLowerCase())].slice(0, 6);
    try { localStorage.setItem("lc:names", JSON.stringify(list)); } catch { /* ignore */ }
  },
};

/** Text input + quick-pick buttons for a manager's name. */
export function nameField(label, initial, onInput) {
  const input = h("input", { class: "name-input", type: "text", maxlength: C.MAX_NAME, autocomplete: "off", autocapitalize: "words",
    placeholder: "First and last name", value: initial || "", "aria-label": label, oninput: () => onInput(input.value) });
  const picks = names.list().map((n) => h("button", { type: "button", class: "pick", text: n, onclick: () => { input.value = n; onInput(n); } }));
  return { el: h("div", { class: "name-field" }, h("label", { class: "field-label", text: label }), input, picks.length ? h("div", { class: "picks" }, picks) : null), input };
}

/* ---------- Scrolling to things ---------- */

export function jumpTo(el, focusSelector) {
  if (!el) return;
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.classList.remove("flash");
  void el.offsetWidth;
  el.classList.add("flash");
  if (focusSelector) {
    const target = el.matches(focusSelector) ? el : el.querySelector(focusSelector);
    if (target && !target.disabled) target.focus({ preventScroll: true });
  }
}

export const timeLabel = C.timeOf;
