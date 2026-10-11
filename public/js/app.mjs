/*
 * Hard Rock Cafe Dublin - digital line check, made for the office tablet.
 *
 * Line check and temperature checklist on one scrolling page each (no Next
 * buttons between screens); every box saves itself on the tablet the moment
 * it's touched. AM and PM fill their own column of the same day and each
 * shift signs off with name and signature. Days print like the paper sheets
 * or download as the original Excel files, filled in.
 */
import { h, icon, replace } from "./dom.mjs";
import * as C from "./core.mjs";
import { ctx, day, signed, toast, safe, crashed, sessionGet, sessionSet, prefGet, prefSet, closeModal } from "./ctx.mjs";
import { createStore, storageWorks, askToKeepStorage } from "./store.mjs";
import { installKeypad, hide as hideKeypad } from "./keypad.mjs";
import { lineView, refreshLine, jumpToNextLine, showLineItem } from "./view-line.mjs";
import { tempsView, refreshTemps, jumpToNextTemp, showTempRow, showTempField } from "./view-temps.mjs";
import { printView } from "./view-print.mjs";
import { openSignOff, openReopen } from "./signoff.mjs";
import { releasePhotoUrls } from "./photos.mjs";

const app = document.getElementById("app");
const NAME = C.SHIFT_NAME;
const VIEWS = ["line", "temps", "print"];

/* ---------- State (kept per tab, so a reload lands where you were) ---------- */

const state = ctx.state;
state.date = C.isDate(sessionGet("lc:date")) && sessionGet("lc:date") <= C.tradingDate() ? sessionGet("lc:date") : C.tradingDate();
state.shift = C.SHIFTS.includes(sessionGet("lc:shift")) ? sessionGet("lc:shift") : C.currentShift();
state.view = VIEWS.includes(sessionGet("lc:view")) ? sessionGet("lc:view") : "line";

function remember() {
  sessionSet("lc:date", state.date);
  sessionSet("lc:shift", state.shift);
  sessionSet("lc:view", state.view);
}

/* ---------- Saving ---------- */

let statusEl = null;
const store = createStore({
  onChange(keys) {
    if (keys.some((k) => k.startsWith("S:") || k.startsWith("P:")) || state.view === "print") return render();
    for (const key of keys) {
      if (key.startsWith("L:")) { const r = ctx.rows.get(key.split(":")[1]); if (r) r.update(); }
      else if (ctx.fields.has(key)) ctx.fields.get(key).update();
    }
    refresh();
  },
  onStatus: renderStatus,
  onDropped(date) {
    toast("The tablet's storage was full, so " + C.prettyDate(date) + " had to be removed from it. Download a backup regularly (Print & history).", "error");
  },
});
ctx.store = store;

/* ---------- Layout ---------- */

function render() {
  try {
    remember();
    ctx.rows.clear();
    ctx.fields.clear();
    hideKeypad();
    const views = { line: lineView, temps: tempsView, print: printView };
    replace(app, header(), banners(), h("main", { id: "main", class: "main view-" + state.view }, views[state.view]()), actionBar());
    document.body.classList.toggle("has-bar", state.view !== "print");
    renderStatus(store.status());
    refresh();
    measureHeader();
  } catch (err) {
    crashed(err);
  }
}

/** Counts, progress bars and the bottom bar (cheap; runs after every change). */
function refresh() {
  if (!day()) return;
  if (state.view === "line") refreshLine();
  if (state.view === "temps") refreshTemps();
  const p = C.shiftProgress(day(), state.shift);
  const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
  set("tab-line-count", p.done + "/" + p.total);
  set("tab-temps-count", p.temps.done + "/" + p.temps.total);
  set("ab-line", "Line check " + p.done + "/" + p.total);
  set("ab-temps", "Temperatures " + p.temps.done + "/" + p.temps.total);
  const issues = p.issues + p.temps.issues;
  const iss = document.getElementById("ab-issues");
  if (iss) { iss.hidden = !issues; iss.textContent = issues + " problem" + (issues === 1 ? "" : "s"); }
  const next = document.getElementById("ab-next");
  if (next) {
    const left = state.view === "temps" ? p.temps.total - p.temps.done : p.total - p.done;
    next.hidden = !left || !!signed(state.shift);
    next.lastChild.textContent = "Next (" + left + " left)";
  }
  const sign = document.getElementById("ab-sign");
  if (sign) sign.classList.toggle("ready", p.done === p.total && p.temps.done === p.temps.total);
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
    type: "date", class: "date-input", value: state.date, max: today, "aria-label": "Choose day",
    onchange: safe((e) => { if (C.isDate(e.target.value)) goToDate(e.target.value); }),
  });
  const shiftBtn = (s) => {
    const sg = signed(s);
    return h("button", {
      type: "button", class: "shift-btn" + (state.shift === s ? " on" : "") + (sg ? " signed" : ""), "aria-pressed": String(state.shift === s),
      onclick: safe(() => { state.shift = s; state.open.clear(); render(); window.scrollTo(0, 0); }),
    }, h("span", { text: NAME[s] + " shift" }), sg ? h("small", null, icon("lock", 12), " " + C.initialsOf(sg.name || sg.i)) : null);
  };
  const tab = (v, label, ic, countId) => h("button", {
    type: "button", class: "tab" + (state.view === v ? " on" : ""), "aria-current": state.view === v ? "page" : null,
    onclick: safe(() => { state.view = v; render(); window.scrollTo(0, 0); }),
  }, icon(ic, 18), h("span", { text: label }), countId ? h("small", { class: "tab-count", id: countId }) : null);

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
      h("div", { class: "shift-switch", role: "group", "aria-label": "Shift" }, C.SHIFTS.map(shiftBtn)),
      h("nav", { class: "tabs", "aria-label": "Screens" },
        tab("line", "Line check", "checks", "tab-line-count"),
        tab("temps", "Temperatures", "thermo", "tab-temps-count"),
        tab("print", "Print & history", "printer"))));
}

function actionBar() {
  if (state.view === "print") return null;
  const shift = state.shift;
  const s = signed(shift);
  return h("div", { class: "actionbar", role: "region", "aria-label": NAME[shift] + " shift" },
    h("div", { class: "ab-info" },
      h("b", { class: "ab-shift", text: NAME[shift] }),
      h("span", { id: "ab-line" }), h("span", { id: "ab-temps" }),
      h("button", { id: "ab-issues", class: "ab-issues", type: "button", hidden: true, onclick: safe(() => openSignOff(shift)) })),
    h("div", { class: "ab-actions" },
      s ? [
        h("span", { class: "ab-signed" }, icon("lock", 16), " Signed by " + (s.name || s.i) + " · " + C.timeOf(s.at)),
        h("button", { class: "btn small", type: "button", onclick: safe(() => openReopen(shift)) }, icon("unlock", 16), h("span", { text: "Reopen" })),
      ] : [
        h("button", { id: "ab-next", class: "btn", type: "button", onclick: safe(jumpToNext) }, icon("down", 18), h("span", { text: "Next" })),
        h("button", { id: "ab-sign", class: "btn primary", type: "button", onclick: safe(() => openSignOff(shift)) }, icon("pen", 18), h("span", { text: "Sign off " + NAME[shift] })),
      ]));
}

/** Next thing to do; focus: false only scrolls to it (no number pad popping up). */
function jumpToNext(opts) {
  const focus = !(opts && opts.focus === false);
  const found = state.view === "temps" ? jumpToNextTemp(focus) : jumpToNextLine(focus);
  if (!found) toast(state.view === "temps" ? "All the temperatures for " + NAME[state.shift] + " are in." : "Everything on the " + NAME[state.shift] + " line check is done.");
}

async function goToDate(date) {
  if (!C.isDate(date) || date > C.tradingDate()) return;
  closeModal();
  const changed = date !== state.date;
  state.date = date;
  state.open.clear();
  if (changed) { state.month = null; releasePhotoUrls(); }
  await store.open(date);
  render();
  window.scrollTo(0, 0);
}

function isIos() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
function isInstalled() {
  return window.navigator.standalone === true || (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
}

function banners() {
  const list = [];
  const st = store.status();
  if (st.state === "error") list.push(h("div", { class: "banner bad", role: "alert" }, icon("alert"), h("span", { text: st.message })));
  if (!storageWorks()) list.push(h("div", { class: "banner bad" }, icon("alert"), h("span", { text: "This browser is blocking storage (private browsing?). Nothing can be kept after this page closes - turn private browsing off." })));
  const today = C.tradingDate();
  if (state.date !== today) {
    list.push(h("div", { class: "banner info" }, icon("calendar"),
      h("span", { text: "You're looking at " + C.prettyDate(state.date, { weekday: "long", day: "numeric", month: "long" }) + ", not today." }),
      h("button", { class: "btn small", type: "button", text: "Go to today", onclick: safe(() => goToDate(today)) })));
  }
  // PM opened but AM never signed off: offer to finish it.
  if (state.shift === "pm" && state.view !== "print" && !signed("am") && state.date === today && new Date().getHours() >= 15) {
    const am = C.shiftProgress(day(), "am");
    list.push(h("div", { class: "banner warn" }, icon("alert"),
      h("span", { text: "The AM check isn't signed off yet (" + am.done + "/" + am.total + " line check, " + am.temps.done + "/" + am.temps.total + " temperatures)." }),
      h("button", { class: "btn small", type: "button", text: "Go to AM", onclick: safe(() => { state.shift = "am"; render(); }) })));
  }
  if (isIos() && !isInstalled() && prefGet("homeTip", "") !== "dismissed") {
    list.push(h("div", { class: "banner info" }, icon("info"),
      h("span", { text: "Tip: tap Share → \"Add to Home Screen\" and open the line check from there. Safari can clear a website's saved data if it isn't opened for a week; the Home Screen app keeps it." }),
      h("button", { class: "btn small", type: "button", text: "OK", onclick: safe(() => { prefSet("homeTip", "dismissed"); render(); }) })));
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
  const bannerShown = !!app.querySelector(".banner.bad[role=alert]");
  if (!ok !== bannerShown) {
    const b = app.querySelector(".banners");
    if (b) b.replaceWith(banners());
  }
}

/* ---------- Glue for the screens ---------- */

ctx.render = render;
ctx.refresh = refresh;
ctx.goToDate = goToDate;
ctx.jumpToNext = jumpToNext;
ctx.goPrint = () => { state.view = "print"; render(); window.scrollTo(0, 0); };
ctx.showLineItem = (id, focusNote) => {
  if (state.view !== "line") { state.view = "line"; render(); }
  setTimeout(() => showLineItem(id, focusNote), 50);
};
ctx.showTempRow = (rowId, what) => {
  if (state.view !== "temps") { state.view = "temps"; render(); }
  setTimeout(() => showTempRow(rowId, what), 50);
};
ctx.showTempField = (key) => {
  if (state.view !== "temps") { state.view = "temps"; render(); }
  setTimeout(() => showTempField(key), 50);
};

/* ---------- Start ---------- */

window.addEventListener("error", (e) => crashed(e.error || e.message));
window.addEventListener("unhandledrejection", (e) => crashed(e.reason));

// Keep the scroll position so a reload (or the tablet going to sleep) lands where you were.
let scrollTimer = null;
window.addEventListener("scroll", () => {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => sessionSet("lc:scroll", state.view + "|" + state.date + "|" + state.shift + "|" + Math.round(window.scrollY)), 250);
}, { passive: true });

async function start() {
  installKeypad();
  askToKeepStorage();
  await store.open(state.date);
  render();
  window.lcStarted = true;
  const saved = (sessionGet("lc:scroll") || "").split("|");
  if (saved[0] === state.view && saved[1] === state.date && saved[2] === state.shift) {
    requestAnimationFrame(() => window.scrollTo(0, Number(saved[3]) || 0));
  }
  // Housekeeping once the page has settled: old days leave localStorage once archived.
  setTimeout(() => store.pruneLocal().catch(() => {}), 8000);
  // A new trading day while the page stays open (e.g. tablet left on overnight).
  let seen = C.tradingDate();
  setInterval(() => {
    const today = C.tradingDate();
    if (today === seen) return;
    const wasOnToday = state.date === seen;
    seen = today;
    if (wasOnToday && !(document.activeElement && document.activeElement.matches("input"))) {
      state.shift = C.currentShift();
      goToDate(today).then(() => toast("It's a new day - opened today's line check."));
    }
  }, 60000);
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("sw.js").catch(() => { /* works without it */ });
  }
}

document.getElementById("crash-reload").addEventListener("click", () => location.reload());
start().catch(crashed);
