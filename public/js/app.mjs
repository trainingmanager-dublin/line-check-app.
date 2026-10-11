/*
 * Hard Rock Cafe Dublin - digital line check.
 *
 * Made for the office tablet. One scrolling page per checklist (no Next
 * buttons); each box saves itself on the tablet the moment it's touched.
 * AM and PM fill their own column of the same day, so the PM manager just
 * opens the day and carries on. Finished days print, or download as the
 * original Excel sheets filled in.
 */
import { h, icon, replace } from "./dom.mjs";
import * as C from "./core.mjs";
import { createStore, local, storageWorks, askToKeepStorage, daySummaries, backupJson, restoreBackup } from "./store.mjs";
import { linePrint, tempPrint } from "./print.mjs";
import { lineCheckWorkbook, temperatureWorkbook, downloadBlob } from "./xlsx.mjs";

const app = document.getElementById("app");
const toastsEl = document.getElementById("toasts");
const printRoot = document.getElementById("print-root");

/* ---------- State (kept per tab so a reload lands where you were) ---------- */

function sessionGet(key) { try { return sessionStorage.getItem(key); } catch { return null; } }
function sessionSet(key, v) { try { sessionStorage.setItem(key, v); } catch { /* ignore */ } }

const state = {
  date: C.isDate(sessionGet("lc:date")) ? sessionGet("lc:date") : C.tradingDate(),
  shift: C.SHIFTS.includes(sessionGet("lc:shift")) ? sessionGet("lc:shift") : C.currentShift(),
  view: ["line", "temps", "print"].includes(sessionGet("lc:view")) ? sessionGet("lc:view") : "line",
  showQuality: local.get("lc:quality") === "1",
  open: new Set(),        // line items with their detail panel open
  month: null,
};

function remember() {
  sessionSet("lc:date", state.date);
  sessionSet("lc:shift", state.shift);
  sessionSet("lc:view", state.view);
}

const initials = {
  get: () => local.get("lc:initials") || "",
  set: (v) => local.set("lc:initials", String(v || "").trim().toUpperCase().slice(0, C.MAX_INITIALS)),
};

/* ---------- Saving ---------- */

const rows = new Map();      // line item id -> { update() }
const tempInputs = new Map(); // temp field key -> { update() }
let statusEl = null;
let progressEls = [];

const store = createStore({
  onChange(keys) {
    let full = false;
    for (const key of keys) {
      if (key.startsWith("S:")) full = true;
      else if (key.startsWith("L:")) { const r = rows.get(key.split(":")[1]); if (r) r.update(); }
      else if (key.startsWith("T:") && tempInputs.has(key)) tempInputs.get(key).update();
    }
    if (full || state.view === "print") render(); else refreshProgress();
  },
  onStatus: renderStatus,
  onDropped(date) {
    toast("The tablet's storage was full, so the oldest saved day (" + C.prettyDate(date) + ") was removed.", "error");
  },
});

const day = () => store.current();
const value = (key) => C.fieldValue(day(), key);
const signed = (shift) => { const s = value(C.signKey(shift)); return s && s.i ? s : null; };

function save(key, v) {
  const ok = store.set(key, v);
  if (!ok) toast("NOT saved - the tablet's storage is full or blocked. Print or download the sheet now.", "error");
  return ok;
}

/* ---------- Small helpers ---------- */

function toast(message, tone, action) {
  const el = h("div", { class: "toast " + (tone || "ok"), role: tone === "error" ? "alert" : "status" },
    h("span", { text: message }),
    action ? h("button", { class: "toast-btn", type: "button", text: action.label, onclick: () => { action.run(); el.remove(); } }) : null);
  toastsEl.appendChild(el);
  // Only the latest two stay, so a run of "Rest OK" taps doesn't cover the screen.
  while (toastsEl.children.length > 2) toastsEl.firstElementChild.remove();
  setTimeout(() => el.classList.add("out"), action ? 7500 : 3800);
  setTimeout(() => el.remove(), action ? 8000 : 4300);
}

/** Run a handler; if anything goes wrong the entries are already saved, so say so. */
function safe(fn) {
  return function (...args) {
    try { return fn.apply(this, args); } catch (err) { crashed(err); }
  };
}

function crashed(err) {
  console.error(err);
  const bar = document.getElementById("crash");
  if (bar) bar.hidden = false;
}

const SHIFT_NAME = { am: "AM", pm: "PM" };
const otherShift = (s) => (s === "am" ? "pm" : "am");

/* ---------- Layout ---------- */

function render() {
  try {
    remember();
    rows.clear();
    tempInputs.clear();
    progressEls = [];
    const views = { line: lineView, temps: tempsView, print: printView };
    replace(app, header(), banners(), h("main", { id: "main", class: "main" }, views[state.view]()));
    renderStatus(store.status());
    refreshProgress();
    measureHeader();
  } catch (err) {
    crashed(err);
  }
}

/** The section chips stick just under the top bar, whatever its height. */
function measureHeader() {
  const bar = app.querySelector(".topbar");
  if (bar) document.documentElement.style.setProperty("--head", bar.offsetHeight + "px");
}
window.addEventListener("resize", () => measureHeader());

function header() {
  const today = C.tradingDate();
  const dateInput = h("input", {
    type: "date", class: "date-input", value: state.date, "aria-label": "Choose day",
    onchange: safe((e) => { if (C.isDate(e.target.value)) goToDate(e.target.value); }),
  });
  return h("header", { class: "topbar" },
    h("div", { class: "topbar-row" },
      h("div", { class: "brand" },
        h("img", { src: "img/hard-rock-logo.png", alt: "Hard Rock Cafe", width: 64, height: 39 }),
        h("div", { class: "brand-text" }, "LINE CHECK", h("small", { text: "Dublin" }))),
      h("div", { class: "day-nav" },
        h("button", { class: "icon-btn", type: "button", "aria-label": "Previous day", onclick: safe(() => goToDate(C.addDays(state.date, -1))) }, icon("left")),
        h("label", { class: "day-label" },
          h("span", { class: "day-text", text: C.prettyDate(state.date) + (state.date === today ? " · Today" : "") }),
          dateInput),
        h("button", { class: "icon-btn", type: "button", "aria-label": "Next day", disabled: state.date >= today, onclick: safe(() => goToDate(C.addDays(state.date, 1))) }, icon("right"))),
      statusEl = h("div", { class: "status", role: "status" })),
    h("div", { class: "topbar-row second" },
      h("div", { class: "shift-switch", role: "group", "aria-label": "Shift" },
        C.SHIFTS.map((s) => h("button", {
          type: "button", class: "shift-btn" + (state.shift === s ? " on" : ""), "aria-pressed": String(state.shift === s),
          onclick: safe(() => { state.shift = s; state.open.clear(); render(); window.scrollTo(0, 0); }),
        }, SHIFT_NAME[s] + " shift", signed(s) ? icon("lock", 14) : null))),
      h("nav", { class: "tabs", "aria-label": "Sections" },
        [["line", "Line check", "checks"], ["temps", "Temperatures", "thermo"], ["print", "Print & history", "printer"]].map(([v, label, ic]) =>
          h("button", { type: "button", class: "tab" + (state.view === v ? " on" : ""), "aria-current": state.view === v ? "page" : null,
            onclick: safe(() => { state.view = v; render(); window.scrollTo(0, 0); }) }, icon(ic, 16), h("span", { text: label }))))));
}

function goToDate(date) {
  if (!C.isDate(date) || date > C.tradingDate()) return;
  state.date = date;
  state.open.clear();
  state.month = null;
  store.open(date);
  render();
  window.scrollTo(0, 0);
}

function banners() {
  const list = [];
  const st = store.status();
  if (st.state === "error") list.push(h("div", { class: "banner bad", role: "alert" }, icon("alert"), h("span", { text: st.message })));
  if (!storageWorks()) list.push(h("div", { class: "banner warn" }, icon("alert"), h("span", { text: "This browser is blocking storage (private browsing?). Entries are only kept while this page stays open - turn private browsing off." })));
  if (state.date !== C.tradingDate()) {
    list.push(h("div", { class: "banner info" }, icon("calendar"),
      h("span", { text: "You're looking at " + C.prettyDate(state.date, { weekday: "long", day: "numeric", month: "long" }) + ", not today." }),
      h("button", { class: "btn small", type: "button", text: "Go to today", onclick: safe(() => goToDate(C.tradingDate())) })));
  }
  return h("div", { class: "banners" }, list);
}

function renderStatus(st) {
  if (!statusEl) return;
  const ok = st.state !== "error";
  statusEl.className = "status " + (ok ? "ok" : "bad");
  statusEl.title = ok ? "Everything is saved on this tablet." : st.message;
  replace(statusEl, icon(ok ? "check" : "alert", 16),
    h("span", { text: ok ? (st.savedAt ? "Saved " + st.savedAt.toLocaleTimeString("en-IE", { hour: "2-digit", minute: "2-digit" }) : "Saved") : "NOT saved" }));
  const bannerShown = !!app.querySelector(".banner.bad");
  if (!ok !== bannerShown) {
    const b = app.querySelector(".banners");
    if (b) b.replaceWith(banners());
  }
}

/* ---------- Line check ---------- */

function lineView() {
  const tpl = day().tpl;
  const shift = state.shift;
  const sign = signed(shift);
  const locked = !!sign;

  const nav = h("div", { class: "section-nav", role: "navigation", "aria-label": "Jump to section" },
    tpl.line.map((section, i) => {
      const count = h("span", { class: "count" });
      progressEls.push({ el: count, items: section.items });
      return h("a", { href: "#sec-" + i, class: "chip", onclick: safe((e) => { e.preventDefault(); jumpTo(document.getElementById("sec-" + i)); }) },
        h("span", { text: section.name }), count);
    }));

  const other = otherShift(shift);
  const head = h("div", { class: "line-head" },
    h("div", { class: "progress-wrap" },
      h("div", { class: "progress-text", id: "progress-text" }),
      h("div", { class: "progress-bar" }, h("div", { class: "progress-fill", id: "progress-fill" }))),
    h("label", { class: "toggle" },
      h("input", { type: "checkbox", checked: state.showQuality, onchange: safe((e) => { state.showQuality = e.target.checked; local.set("lc:quality", e.target.checked ? "1" : "0"); document.body.classList.toggle("show-quality", state.showQuality); }) }),
      h("span", { text: "Show quality identifiers" })));
  document.body.classList.toggle("show-quality", state.showQuality);

  const lockBanner = locked ? h("div", { class: "banner done" }, icon("lock"),
    h("span", { text: SHIFT_NAME[shift] + " line check signed off by " + sign.i + (sign.at ? " at " + timeLabel(sign.at) : "") + "." }),
    h("button", { class: "btn small", type: "button", text: "Reopen " + SHIFT_NAME[shift], onclick: safe(() => reopen(shift)) })) : null;

  const otherSign = signed(other);
  const otherNote = h("p", { class: "hint" },
    "Tap ", h("b", { text: "✓" }), " when an item is right, ", h("b", { text: "!" }), " if there's a problem. For temperatures just type the reading - it ticks itself when it's in range, and Enter jumps to the next one. ",
    otherSign ? SHIFT_NAME[other] + " was signed off by " + otherSign.i + "." : null);

  const sections = tpl.line.map((section, i) => {
    const sectionRows = section.items.map((item) => lineRow(item, shift, locked));
    return h("section", { class: "card", id: "sec-" + i, "aria-labelledby": "sech-" + i },
      h("div", { class: "card-head" },
        h("h2", { id: "sech-" + i, text: section.name }),
        locked ? null : h("button", { class: "btn small ghost", type: "button", onclick: safe(() => markSectionOk(section, shift)) }, icon("checks", 16), h("span", { text: "Rest OK" }))),
      sectionRows);
  });

  return [nav, h("div", { class: "wrap" }, head, lockBanner, otherNote, sections, signOff(shift)), nextButton()];
}

function timeLabel(iso) {
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleTimeString("en-IE", { hour: "2-digit", minute: "2-digit" });
}

function lineRow(item, shift, locked) {
  const key = C.lineKey(item.id, shift);
  const otherKey = C.lineKey(item.id, otherShift(shift));
  const get = () => C.normLine(value(key));
  const put = (patch) => {
    const next = Object.assign(get(), patch);
    save(key, C.isLineEmpty(next) ? null : next);
    update();
    refreshProgress();
  };

  const specs = [];
  if (item.temp) specs.push(h("span", { class: "spec" + (item.limit ? " spec-temp" : ""), text: item.temp }));
  if (item.life) specs.push(h("span", { class: "spec", text: item.life }));
  if (item.utensil) specs.push(h("span", { class: "spec", text: item.utensil }));

  const tempIn = item.limit ? h("input", {
    class: "temp", type: "text", inputmode: "decimal", enterkeyhint: "next", autocomplete: "off",
    placeholder: "°C", "aria-label": item.name + " temperature (" + C.limitLabel(item.limit) + ")", disabled: locked,
  }) : null;
  const tick = h("button", { class: "tick", type: "button", "aria-label": item.name + " OK", disabled: locked }, icon("check", 22));
  const flag = h("button", { class: "flag", type: "button", "aria-label": item.name + " problem", disabled: locked }, h("span", { text: "!" }));
  const nameBtn = h("button", { class: "item-name", type: "button", "aria-expanded": "false" },
    h("span", { class: "name", text: item.name }), h("span", { class: "specs" }, specs));
  const quality = h("p", { class: "quality", text: item.quality });
  const codeBtns = C.CODES.map(([code, label]) => h("button", { type: "button", class: "code", "data-code": code, title: label, disabled: locked, "aria-pressed": "false" },
    h("b", { text: code }), h("span", { text: label })));
  const note = h("input", { class: "note", type: "text", maxlength: 300, placeholder: "Comment / corrective action", "aria-label": item.name + " comment", disabled: locked, enterkeyhint: "done" });
  const otherLine = h("div", { class: "other" });
  const detail = h("div", { class: "detail" }, quality, h("div", { class: "codes" }, codeBtns), note);
  const el = h("div", { class: "item", "data-id": item.id },
    h("div", { class: "item-head" }, nameBtn, h("div", { class: "item-actions" }, tempIn, tick, flag)),
    h("p", { class: "quality-inline", text: item.quality }),
    otherLine, detail);

  function update() {
    const v = get();
    el.dataset.state = v.s;
    const bad = judgeBad(v.t);
    el.classList.toggle("temp-bad", bad);
    tick.setAttribute("aria-pressed", String(v.s === "ok"));
    flag.setAttribute("aria-pressed", String(v.s === "no"));
    if (tempIn && document.activeElement !== tempIn) tempIn.value = v.t;
    if (document.activeElement !== note) note.value = v.n;
    codeBtns.forEach((b) => b.setAttribute("aria-pressed", String(v.c.includes(b.dataset.code))));
    const open = state.open.has(item.id) || v.s === "no" || bad || !!v.n || v.c.length > 0;
    el.classList.toggle("open", open);
    nameBtn.setAttribute("aria-expanded", String(open));
    note.placeholder = bad ? "Out of range - what did you do? (e.g. moved to walk-in, discarded)" : "Comment / corrective action";
    const o = C.normLine(value(otherKey));
    replace(otherLine, C.isLineEmpty(o) ? null : [
      h("b", { text: SHIFT_NAME[otherShift(shift)] + ": " }),
      o.s === "ok" ? "✓ " : o.s === "no" ? "✗ " : "",
      o.t ? o.t + "°C " : "", o.c.length ? o.c.join(" ") + " " : "", o.n ? "- " + o.n : ""]);
  }

  function judgeBad(t) { return C.judgeTemp(t, item.limit) === "bad"; }

  nameBtn.addEventListener("click", safe(() => {
    if (state.open.has(item.id)) state.open.delete(item.id); else state.open.add(item.id);
    update();
  }));
  tick.addEventListener("click", safe(() => {
    const v = get();
    put({ s: v.s === "ok" ? "" : "ok" });
  }));
  flag.addEventListener("click", safe(() => {
    const v = get();
    const s = v.s === "no" ? "" : "no";
    if (s === "no") state.open.add(item.id);
    put({ s });
    if (s === "no") note.focus();
  }));
  codeBtns.forEach((b) => b.addEventListener("click", safe(() => {
    const v = get();
    const c = v.c.includes(b.dataset.code) ? v.c.filter((x) => x !== b.dataset.code) : v.c.concat(b.dataset.code);
    put({ c });
  })));

  let noteTimer = null;
  const saveNote = () => { clearTimeout(noteTimer); if (note.value !== get().n) put({ n: note.value }); };
  note.addEventListener("input", () => { clearTimeout(noteTimer); noteTimer = setTimeout(safe(saveNote), 500); });
  note.addEventListener("change", safe(saveNote));
  note.addEventListener("blur", safe(saveNote));
  note.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); note.blur(); } });

  if (tempIn) {
    let tempTimer = null;
    const saveTemp = () => {
      clearTimeout(tempTimer);
      const text = tempIn.value.trim().replace(",", ".").replace(/°\s*c?$/i, "");
      const v = get();
      if (text === v.t) return;
      const verdict = C.judgeTemp(text, item.limit);
      const patch = { t: text };
      if (verdict === "ok" && v.s !== "no") patch.s = "ok";
      if (verdict === "bad") { patch.s = "no"; state.open.add(item.id); }
      if (!text && v.s === "ok" && !v.c.length && !v.n) patch.s = "";
      put(patch);
    };
    tempIn.addEventListener("input", () => {
      tempIn.classList.toggle("invalid", !!tempIn.value.trim() && C.parseTemp(tempIn.value) == null);
      clearTimeout(tempTimer);
      tempTimer = setTimeout(safe(saveTemp), 700);
    });
    tempIn.addEventListener("change", safe(saveTemp));
    tempIn.addEventListener("blur", safe(saveTemp));
    tempIn.addEventListener("keydown", safe((e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      saveTemp();
      if (judgeBad(get().t)) { note.focus(); return; }
      focusNext(tempIn, "#main input.temp:not(:disabled)");
    }));
  }

  rows.set(item.id, { update });
  update();
  return el;
}

function focusNext(current, selector) {
  const all = [...document.querySelectorAll(selector)];
  const next = all[all.indexOf(current) + 1];
  if (next) {
    next.focus({ preventScroll: true });
    next.scrollIntoView({ block: "center", behavior: "smooth" });
  } else {
    current.blur();
  }
}

function markSectionOk(section, shift) {
  const before = [];
  for (const item of section.items) {
    const key = C.lineKey(item.id, shift);
    const v = C.normLine(value(key));
    if (v.s) continue;
    if (C.judgeTemp(v.t, item.limit) === "bad") continue;
    before.push([key, value(key)]);
    save(key, Object.assign(v, { s: "ok" }));
    const r = rows.get(item.id);
    if (r) r.update();
  }
  refreshProgress();
  if (!before.length) return toast("Everything in " + section.name + " is already done.");
  toast(before.length + " item" + (before.length === 1 ? "" : "s") + " in " + section.name + " marked OK.", "ok", {
    label: "Undo",
    run: safe(() => {
      for (const [key, old] of before) save(key, old);
      for (const item of section.items) { const r = rows.get(item.id); if (r) r.update(); }
      refreshProgress();
    }),
  });
}

function remaining(shift) {
  const tpl = day().tpl;
  return C.lineItems(tpl).filter((item) => !C.normLine(value(C.lineKey(item.id, shift))).s);
}

function refreshProgress() {
  if (state.view !== "line" || !day()) return;
  const shift = state.shift;
  const p = C.shiftProgress(day(), shift);
  const text = document.getElementById("progress-text");
  const fill = document.getElementById("progress-fill");
  if (text) replace(text, h("b", { text: SHIFT_NAME[shift] + ": " + p.done + " of " + p.total + " checked" }),
    p.issues ? h("span", { class: "issues", text: " · " + p.issues + " problem" + (p.issues === 1 ? "" : "s") }) : null);
  if (fill) fill.style.width = (p.total ? Math.round((p.done / p.total) * 100) : 0) + "%";
  for (const { el, items } of progressEls) {
    const done = items.filter((it) => C.normLine(value(C.lineKey(it.id, shift))).s).length;
    el.textContent = done + "/" + items.length;
    el.parentElement.classList.toggle("complete", done === items.length);
  }
  const next = document.getElementById("next-btn");
  if (next) {
    const left = p.total - p.done;
    next.hidden = !left || !!signed(shift);
    const label = next.querySelector("span");
    if (label) label.textContent = left + " left - next";
  }
  const signInfo = document.getElementById("sign-remaining");
  if (signInfo) signInfo.textContent = p.total - p.done ? (p.total - p.done) + " item" + (p.total - p.done === 1 ? " is" : "s are") + " not checked yet." : "Everything is checked.";
}

function nextButton() {
  return h("button", { id: "next-btn", class: "next-btn", type: "button", onclick: safe(jumpToNext) }, icon("down", 18), h("span"));
}

function jumpToNext() {
  const left = remaining(state.shift);
  if (!left.length) return;
  // The first unchecked item below the top of the screen, else the first one.
  const els = left.map((it) => document.querySelector('.item[data-id="' + CSS.escape(it.id) + '"]')).filter(Boolean);
  const target = els.find((el) => el.getBoundingClientRect().top > 140) || els[0];
  jumpTo(target);
  const input = target && target.querySelector("input.temp:not(:disabled)");
  if (input) input.focus({ preventScroll: true });
}

function jumpTo(el) {
  if (!el) return;
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.classList.remove("flash");
  void el.offsetWidth;
  el.classList.add("flash");
}

function signOff(shift) {
  const sign = signed(shift);
  if (sign) return null;
  const input = h("input", { class: "initials", type: "text", maxlength: C.MAX_INITIALS, autocomplete: "off", autocapitalize: "characters",
    placeholder: "e.g. JD", value: initials.get(), "aria-label": "Manager initials" });
  const submit = safe((e) => {
    e.preventDefault();
    const i = input.value.trim().toUpperCase();
    if (!i) { input.focus(); toast("Add your initials to sign off.", "error"); return; }
    initials.set(i);
    const left = remaining(shift).length;
    if (left && !window.confirm(left + " item" + (left === 1 ? " is" : "s are") + " still not checked for " + SHIFT_NAME[shift] + ". Sign off anyway?")) return;
    save(C.signKey(shift), { i, at: new Date().toISOString() });
    toast(SHIFT_NAME[shift] + " line check signed off. It's saved and ready to print.");
    render();
  });
  return h("form", { class: "card sign", onsubmit: submit },
    h("h2", { text: "Sign off " + SHIFT_NAME[shift] + " line check" }),
    h("p", { class: "muted", id: "sign-remaining" }),
    h("div", { class: "sign-row" },
      h("label", { class: "field" }, h("span", { text: "Manager initials" }), input),
      h("button", { class: "btn primary", type: "submit" }, icon("lock", 16), h("span", { text: "Sign off " + SHIFT_NAME[shift] }))));
}

function reopen(shift) {
  if (!window.confirm("Reopen the " + SHIFT_NAME[shift] + " line check so it can be changed? Everything already filled in stays.")) return;
  save(C.signKey(shift), null);
  toast(SHIFT_NAME[shift] + " reopened - carry on where it was left.");
  render();
  setTimeout(jumpToNext, 300);
}

/* ---------- Temperatures ---------- */

function tempsView() {
  const T = day().tpl.temps;
  const shift = state.shift;
  const fridgeSlots = C.FRIDGE_SLOTS.filter((s) => s[3] === shift);
  const hotSlots = C.HOT_SLOTS.filter((s) => s[2] === shift);

  const fridges = h("section", { class: "card" },
    h("div", { class: "card-head" }, h("h2", { text: "Fridges & freezers" })),
    h("p", { class: "hint", text: SHIFT_NAME[shift] + " readings: " + fridgeSlots.map((s) => s[1] + " " + s[2].toLowerCase()).join(", ") + ". Switch to " + SHIFT_NAME[otherShift(shift)] + " at the top for the other times." }),
    T.fridges.map((row) => tempRow(row, fridgeSlots.map(([slot, time, kind]) => [slot, time + " " + kind, row.limit]), C.FRIDGE_SLOTS.filter((s) => s[3] !== shift))));

  const hot = h("section", { class: "card" },
    h("div", { class: "card-head" }, h("h2", { text: "Hot holding & cooking" })),
    T.hot.map((row) => tempRow(row, hotSlots.map(([slot, time]) => [slot, time, row.limit]), C.HOT_SLOTS.filter((s) => s[2] !== shift).map(([s, t]) => [s, t, ""]))),
    tempRow(T.dish, hotSlots.map(([slot, time]) => [slot, time + " wash/rinse", null, "dish"]), C.HOT_SLOTS.filter((s) => s[2] !== shift).map(([s, t]) => [s, t, ""])));

  const fryers = h("section", { class: "card" },
    h("div", { class: "card-head" }, h("h2", { text: "Fryers" })),
    T.fryers.map((f) => h("div", { class: "trow" },
      h("div", { class: "trow-name" }, h("b", { text: f.name }), h("span", { class: "spec", text: f.target + "°C · " + f.use })),
      h("div", { class: "trow-fields" },
        tempField(f.id, "temp", "Temp °C", { target: f.target }),
        tempField(f.id, "tpm", "TPM %", { text: false }),
        tempField(f.id, "notes", "Notes", { text: true, wide: true })))));

  const surface = (title, list) => h("section", { class: "card" },
    h("div", { class: "card-head" }, h("h2", { text: title })),
    list.map((r) => h("div", { class: "trow" },
      h("div", { class: "trow-name" }, h("b", { text: r.name }), h("span", { class: "spec", text: r.target + "°C" })),
      h("div", { class: "trow-fields" },
        tempField(r.id, shift, SHIFT_NAME[shift] + " °C", { target: r.target }),
        otherReading(r.id, otherShift(shift), SHIFT_NAME[otherShift(shift)]),
        tempField(r.id, "notes", "Notes", { text: true, wide: true })))));

  return h("div", { class: "wrap" },
    h("p", { class: "hint", text: "Type each reading; Enter jumps to the next box. Anything out of range turns red and asks for a corrective action." }),
    fridges, hot, fryers, surface("Grill", T.grill), surface("Flat top", T.flat));
}

function otherReading(rowId, slot, label) {
  const key = C.tempKey(rowId, slot);
  const el = h("div", { class: "other-reading" });
  const update = () => {
    const v = value(key);
    replace(el, v ? [h("span", { text: label + ": " }), h("b", { text: String(v) })] : null);
  };
  tempInputs.set(key, { update });
  update();
  return el;
}

function tempRow(row, slots, otherSlots) {
  const caKey = C.tempKey(row.id, "ca");
  const nameField = row.name ? null : tempField(row.id, "name", "Station name", { text: true });
  const inputs = slots.map(([slot, label, limit, kind]) => tempField(row.id, slot, label, { limit, dish: kind === "dish" ? row.limit : null, onJudge: () => refreshCa() }));
  const others = h("div", { class: "other-reading" });
  const ca = tempField(row.id, "ca", "Corrective action", { text: true, wide: true });
  const el = h("div", { class: "trow" },
    h("div", { class: "trow-name" },
      row.name ? h("b", { text: row.name }) : h("b", { class: "muted", text: "Other" }),
      h("span", { class: "spec", text: row.label || C.limitLabel(row.limit) })),
    h("div", { class: "trow-fields" },
      nameField,
      tempField(row.id, "food", "Food item probed", { text: true }),
      inputs, others, ca));

  function refreshCa() {
    const anyBad = slots.some(([slot, , limit, kind]) => {
      const v = value(C.tempKey(row.id, slot));
      return kind === "dish" ? C.dishBad(v, row.limit) : C.judgeTemp(v, limit) === "bad";
    });
    ca.classList.toggle("needed", anyBad && !value(caKey));
  }
  const updateOthers = () => {
    replace(others, otherSlots.map((s) => {
      const v = value(C.tempKey(row.id, s[0]));
      return v ? h("span", { class: "chip-small" }, s[1] + (s[2] && typeof s[2] === "string" && s[3] ? " " + s[2] : "") + ": ", h("b", { text: String(v) })) : null;
    }));
  };
  otherSlots.forEach((s) => tempInputs.set(C.tempKey(row.id, s[0]), { update: updateOthers }));
  const caEntry = tempInputs.get(caKey);
  tempInputs.set(caKey, { update: () => { if (caEntry) caEntry.update(); refreshCa(); } });
  updateOthers();
  refreshCa();
  return el;
}


/** One box on the temperature sheet. Saves as you type. */
function tempField(rowId, slot, label, opts) {
  opts = opts || {};
  const key = C.tempKey(rowId, slot);
  const input = h("input", {
    class: "tfield" + (opts.text ? " text" : ""), type: "text", autocomplete: "off",
    inputmode: opts.text ? "text" : opts.dish ? "text" : "decimal", enterkeyhint: "next",
    maxlength: opts.text ? 200 : 12, placeholder: opts.dish ? "e.g. 66/84" : "", "aria-label": label,
  });
  const wrap = h("label", { class: "tbox" + (opts.wide ? " wide" : "") + (opts.text ? "" : " num") }, h("span", { text: label }), input);
  const judge = () => {
    const v = input.value.trim();
    let bad = false;
    if (opts.limit) bad = C.judgeTemp(v, opts.limit) === "bad";
    else if (opts.dish) bad = C.dishBad(v, opts.dish);
    else if (opts.target && C.parseTemp(v) != null) bad = Math.abs(C.parseTemp(v) - opts.target) > 15;
    wrap.classList.toggle("bad", bad);
    wrap.classList.toggle("good", !bad && !!v && (!!opts.limit || !!opts.dish));
  };
  const update = () => {
    if (document.activeElement !== input) input.value = value(key) == null ? "" : String(value(key));
    judge();
  };
  let timer = null;
  const commit = () => {
    clearTimeout(timer);
    let v = input.value.trim();
    if (!opts.text && !opts.dish) v = v.replace(",", ".").replace(/°\s*c?$/i, "");
    if (v === (value(key) == null ? "" : String(value(key)))) return;
    save(key, v || null);
    judge();
    if (opts.onJudge) opts.onJudge();
  };
  input.addEventListener("input", () => { judge(); clearTimeout(timer); timer = setTimeout(safe(commit), 700); });
  input.addEventListener("change", safe(commit));
  input.addEventListener("blur", safe(commit));
  input.addEventListener("keydown", safe((e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    commit();
    focusNext(input, "#main input.tfield:not(:disabled)");
  }));
  tempInputs.set(key, { update });
  update();
  return wrap;
}

/* ---------- Print, Excel & history ---------- */

function printView() {
  const rec = day();
  const sAm = signed("am"), sPm = signed("pm");
  const am = C.shiftProgress(rec, "am"), pm = C.shiftProgress(rec, "pm");
  const statusLine = (p, s, name) => h("li", null, h("b", { text: name + ": " }),
    p.done + "/" + p.total + " checked" + (p.issues ? ", " + p.issues + " problem" + (p.issues === 1 ? "" : "s") : "") + " - ",
    s ? "signed off by " + s.i + (s.at ? " at " + timeLabel(s.at) : "") : h("span", { class: "warn-text", text: "not signed off" }));

  const preview = h("div", { class: "preview" });
  const segBtns = [];
  const showPreview = (which) => {
    sessionSet("lc:preview", which);
    replace(preview, which === "temps" ? tempPrint(rec) : linePrint(rec));
    segBtns.forEach((b) => b.classList.toggle("on", b.dataset.which === which));
  };
  [["line", "Line check"], ["temps", "Temperature checklist"]].forEach(([w, l]) =>
    segBtns.push(h("button", { type: "button", class: "seg-btn", "data-which": w, onclick: safe(() => showPreview(w)) }, l)));
  showPreview(sessionGet("lc:preview") === "temps" ? "temps" : "line");

  const btn = (label, ic, fn, cls) => h("button", { class: "btn " + (cls || ""), type: "button", onclick: safe(fn) }, icon(ic, 18), h("span", { text: label }));

  return h("div", { class: "wrap" },
    h("section", { class: "card" },
      h("div", { class: "card-head" }, h("h2", { text: C.prettyDate(state.date, { weekday: "long", day: "numeric", month: "long", year: "numeric" }) })),
      h("ul", { class: "day-status" }, statusLine(am, sAm, "AM line check"), statusLine(pm, sPm, "PM line check"),
        h("li", null, h("b", { text: "Temperatures: " }), C.tempsFilled(rec) + " readings")),
      h("div", { class: "out-grid" },
        h("div", { class: "out-box" },
          h("h3", { text: "Line Check Sheet" }),
          btn("Print", "printer", () => doPrint("line"), "primary"),
          btn("Excel file", "download", () => downloadExcel("line"))),
        h("div", { class: "out-box" },
          h("h3", { text: "Temperature Checklist" }),
          btn("Print", "printer", () => doPrint("temps"), "primary"),
          btn("Excel file", "download", () => downloadExcel("temps"))),
        h("div", { class: "out-box" },
          h("h3", { text: "Both" }),
          btn("Print both", "printer", () => doPrint("both")))),
      h("p", { class: "muted", text: "Print uses A4 landscape, laid out like the paper sheets (choose \"Save as PDF\" to keep a PDF). \"Excel file\" downloads your original Excel template with this day filled in." })),
    h("section", { class: "card" },
      h("div", { class: "card-head" }, h("h2", { text: "Preview" }), h("div", { class: "seg" }, segBtns)),
      h("div", { class: "preview-scroll" }, preview)),
    historyCard(),
    backupCard());
}

function doPrint(which) {
  const rec = day();
  replace(printRoot, which === "temps" ? tempPrint(rec) : which === "both" ? [linePrint(rec), tempPrint(rec)] : linePrint(rec));
  const done = () => { replace(printRoot); window.removeEventListener("afterprint", done); };
  window.addEventListener("afterprint", done);
  // Let the logo load before the print dialog opens.
  const imgs = [...printRoot.querySelectorAll("img")];
  Promise.all(imgs.map((img) => (img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; setTimeout(r, 1500); }))))
    .then(() => window.print());
}

let excelBusy = false;
async function downloadExcel(which) {
  if (excelBusy) return;
  excelBusy = true;
  const rec = day();
  try {
    if (which === "temps") {
      const { blob } = await temperatureWorkbook(rec);
      downloadBlob(blob, "Temperature Checklist " + rec.date + ".xlsx");
    } else {
      const { blob, missing } = await lineCheckWorkbook(rec);
      downloadBlob(blob, "Line Check " + rec.date + ".xlsx");
      if (missing.length) toast("Not in the Excel template, so only in the printout: " + missing.join(", "), "error");
    }
    toast("Excel file downloaded.");
  } catch (err) {
    console.error(err);
    toast("Couldn't make the Excel file (" + (err && err.message ? err.message : "error") + "). You can still print.", "error");
  } finally {
    excelBusy = false;
  }
}

function historyCard() {
  const today = C.tradingDate();
  const month = state.month || state.date.slice(0, 7);
  const [y, m] = month.split("-").map(Number);
  const shiftMonth = (n) => { state.month = C.isoDate(new Date(y, m - 1 + n, 1)).slice(0, 7); render(); };
  const monthName = new Date(y, m - 1, 1).toLocaleDateString("en-IE", { month: "long", year: "numeric" });
  const days = daySummaries(month);

  const part = (arr, name) => {
    const [done, total, issues, sig] = arr;
    return h("span", { class: "hist-shift" + (sig ? " signed" : "") },
      h("b", { text: name + " " }), done + "/" + total, issues ? h("span", { class: "issues", text: " ⚠" + issues }) : null, sig ? h("span", { text: " ✓ " + sig }) : null);
  };

  return h("section", { class: "card" },
    h("div", { class: "card-head" },
      h("h2", { text: "Saved days" }),
      h("div", { class: "month-nav" },
        h("button", { class: "icon-btn", type: "button", "aria-label": "Previous month", onclick: safe(() => shiftMonth(-1)) }, icon("left")),
        h("span", { text: monthName }),
        h("button", { class: "icon-btn", type: "button", "aria-label": "Next month", disabled: month >= today.slice(0, 7), onclick: safe(() => shiftMonth(1)) }, icon("right")))),
    days.length ? h("div", { class: "history-list" }, days.map(({ date, summary: s }) =>
      h("div", { class: "hist-row" + (date === state.date ? " current" : "") },
        h("div", { class: "hist-date" }, h("b", { text: C.prettyDate(date, { weekday: "short", day: "numeric", month: "short" }) }), date === today ? h("span", { class: "spec", text: "Today" }) : null),
        h("div", { class: "hist-parts" }, part(s.am, "AM"), part(s.pm, "PM"), h("span", { class: "muted", text: s.temps + " temps" })),
        h("div", { class: "hist-actions" },
          h("button", { class: "btn small", type: "button", text: "Open", onclick: safe(() => { state.view = "line"; goToDate(date); }) }),
          h("button", { class: "btn small ghost", type: "button", onclick: safe(() => { state.view = "print"; goToDate(date); }) }, icon("printer", 15), h("span", { text: "Print / Excel" }))))))
      : h("p", { class: "muted", text: "Nothing saved on this tablet for " + monthName + "." }));
}

function backupCard() {
  const file = h("input", { type: "file", accept: ".json,application/json", hidden: true, onchange: safe((e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    f.text().then(safe((text) => {
      const n = restoreBackup(text);
      store.open(state.date);
      toast("Restored " + n + " day" + (n === 1 ? "" : "s") + " from the backup.");
      render();
    })).catch((err) => toast(err.message || "Couldn't read that file.", "error"));
    e.target.value = "";
  }) });
  return h("section", { class: "card" },
    h("div", { class: "card-head" }, h("h2", { text: "Backup" })),
    h("p", { class: "muted", text: "Everything is kept on this tablet. Download a backup now and then (or before changing tablet) - it can be restored here or on a new tablet." }),
    h("div", { class: "btn-row" },
      h("button", { class: "btn", type: "button", onclick: safe(() => downloadBlob(new Blob([backupJson()], { type: "application/json" }), "line-check-backup-" + C.tradingDate() + ".json")) }, icon("download", 18), h("span", { text: "Download backup" })),
      h("button", { class: "btn ghost", type: "button", onclick: () => file.click() }, icon("upload", 18), h("span", { text: "Restore backup" })),
      file));
}

/* ---------- Start ---------- */

window.addEventListener("error", (e) => crashed(e.error || e.message));
window.addEventListener("unhandledrejection", (e) => crashed(e.reason));

// Keep the scroll position so a reload (or the tablet going to sleep) lands where you were.
let scrollTimer = null;
window.addEventListener("scroll", () => {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => sessionSet("lc:scroll", state.view + "|" + state.date + "|" + state.shift + "|" + Math.round(window.scrollY)), 250);
}, { passive: true });

function start() {
  askToKeepStorage();
  store.open(state.date);
  render();
  const saved = (sessionGet("lc:scroll") || "").split("|");
  if (saved[0] === state.view && saved[1] === state.date && saved[2] === state.shift) {
    requestAnimationFrame(() => window.scrollTo(0, Number(saved[3]) || 0));
  }
  // A new trading day while the page stays open (e.g. tablet left on overnight).
  setInterval(() => {
    const today = C.tradingDate();
    if (sessionGet("lc:day-seen") && sessionGet("lc:day-seen") !== today && state.date === sessionGet("lc:day-seen") && !document.activeElement.matches("input")) {
      sessionSet("lc:day-seen", today);
      goToDate(today);
      toast("It's a new day - opened today's line check.");
    } else if (!sessionGet("lc:day-seen")) sessionSet("lc:day-seen", today);
  }, 60000);
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("sw.js").catch(() => { /* works without it */ });
  }
}

document.getElementById("crash-reload").addEventListener("click", () => location.reload());
start();
