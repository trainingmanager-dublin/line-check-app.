/*
 * The temperature checklist, laid out like the paper sheet: a row per
 * fridge / station, a column per time of day for this shift, the column
 * that's due now highlighted. Out-of-range readings turn red and the
 * corrective action box asks to be filled.
 */
import { h, icon, replace } from "./dom.mjs";
import * as C from "./core.mjs";
import { ctx, day, value, save, signed, toast, safe, jumpTo, prefSet } from "./ctx.mjs";
import { keypadAttrs, hide as hideKeypad } from "./keypad.mjs";
import { cameraButton, thumbStrip } from "./photos.mjs";
import { signedBanner } from "./signoff.mjs";

const NAME = C.SHIFT_NAME;
const text = (key) => { const v = value(key); return v == null ? "" : String(v); };

/** Which time column is due now (today only), e.g. "12" for 12:00-15:59. */
function dueHour() {
  if (day().date !== C.tradingDate()) return null;
  const hr = new Date().getHours();
  if (hr >= 5 && hr < 12) return 9;
  if (hr >= 12 && hr < 16) return 12;
  if (hr >= 16 && hr < 20) return 16;
  if (hr >= 20 && hr < 22) return 20;
  return 23;
}

export function tempsView() {
  const T = day().tpl.temps;
  const shift = ctx.state.shift;
  const lockedShift = !!signed(shift);
  const lockedShared = !!(signed("am") && signed("pm"));
  const due = dueHour();
  const fridgeSlots = C.FRIDGE_SLOTS.filter((s) => s[3] === shift);
  const hotSlots = C.HOT_SLOTS.filter((s) => s[2] === shift);
  const isDue = (slot) => C.SLOT_HOURS[slot] === due;

  const photoSwitch = h("label", { class: "switch" },
    h("input", { type: "checkbox", checked: ctx.state.photos, onchange: safe((e) => { ctx.state.photos = e.target.checked; prefSet("photos", e.target.checked ? "1" : "0"); ctx.render(); }) }),
    h("span", { class: "switch-ui", "aria-hidden": "true" }), icon("camera", 18), h("span", { text: "Photos" }));

  const tools = h("div", { class: "tools" },
    h("div", { class: "progress-wrap" },
      h("div", { class: "progress-text", id: "temps-progress" }),
      h("div", { class: "progress-bar" }, h("div", { class: "progress-fill", id: "temps-fill" }))),
    photoSwitch);

  // ---- Fridges & freezers ----
  const fridgeHead = h("div", { class: "tgrid-head" },
    h("span", { text: "Station" }), h("span", { text: "Food item probed" }),
    fridgeSlots.map(([slot, time, kind]) => h("span", { class: "slot-head" + (isDue(slot) ? " due" : "") }, h("b", { text: time }), h("small", { text: kind }), isDue(slot) ? h("em", { text: "due now" }) : null)),
    h("span", { text: "Corrective action" }), h("span"));
  const fridgeRows = T.fridges.map((row) => {
    const otherSlots = C.FRIDGE_SLOTS.filter((s) => s[3] !== shift);
    return tempRow(row, {
      slots: fridgeSlots.map(([slot, time, kind]) => ({ slot, label: time + " " + kind.toLowerCase(), check: (v) => C.judgeTemp(v, row.limit) })),
      others: otherSlots.map(([slot, time, kind]) => [slot, (time === "Opening" || time === "Closing" ? time : time + " " + kind.toLowerCase())]),
      lockedShift, lockedShared, shift, otherWord: "other fridge",
    });
  });
  const fridges = h("section", { class: "card tcard", "data-slots": fridgeSlots.length },
    h("div", { class: "card-head" }, h("h2", { text: "Fridges & freezers" }), h("span", { class: "sec-count", text: NAME[shift] + ": " + fridgeSlots.map((s) => s[1] + " " + s[2].toLowerCase()).join(" · ") })),
    fridgeHead, fridgeRows);

  // ---- Hot holding, cooking, dish washer ----
  const hotHead = h("div", { class: "tgrid-head" },
    h("span", { text: "Station" }), h("span", { text: "Food item" }),
    hotSlots.map(([slot, time]) => h("span", { class: "slot-head" + (isDue(slot) ? " due" : "") }, h("b", { text: time }), isDue(slot) ? h("em", { text: "due now" }) : null)),
    h("span", { text: "Corrective action" }), h("span"));
  const hotRows = T.hot.map((row) => tempRow(row, {
    slots: hotSlots.map(([slot, time]) => ({ slot, label: time, check: (v) => C.judgeTemp(v, row.limit) })),
    others: C.HOT_SLOTS.filter((s) => s[2] !== shift).map(([slot, time]) => [slot, time]),
    lockedShift, lockedShared, shift, otherWord: "other station",
  }));
  const dish = dishRow(T.dish, hotSlots, lockedShift, lockedShared);
  const hot = h("section", { class: "card tcard", "data-slots": hotSlots.length },
    h("div", { class: "card-head" }, h("h2", { text: "Hot holding & cooking" }), h("span", { class: "sec-count", text: NAME[shift] + ": " + hotSlots.map((s) => s[1]).join(" · ") })),
    hotHead, hotRows, dish);

  // ---- Fryers (once a day, with the AM check) ----
  const fryLocked = !!signed("am");
  const fryers = h("section", { class: "card tcard simple" },
    h("div", { class: "card-head" }, h("h2", { text: "Fryers" }), h("span", { class: "sec-count", text: "Once a day (AM)" })),
    h("div", { class: "sgrid-head" }, h("span", { text: "Fryer" }), h("span", { text: "Temp °C" }), h("span", { text: "TPM %" }), h("span", { text: "Notes" })),
    T.fryers.map((f) => h("div", { class: "srow", "data-row": f.id },
      h("div", { class: "trow-name" }, h("b", { text: f.name }), h("span", { class: "spec", text: f.target + "°C · " + f.use })),
      numField(C.tempKey(f.id, "temp"), f.name + " temperature (" + f.target + "°C)", { target: f.target, disabled: fryLocked, short: "Temp °C" }),
      numField(C.tempKey(f.id, "tpm"), f.name + " TPM %", { disabled: fryLocked, plain: true, short: "TPM %" }),
      textField(C.tempKey(f.id, "notes"), f.name + " notes", { disabled: lockedShared, placeholder: "Notes", short: "Notes" }))));

  // ---- Grill & flat top ----
  const surface = (title, list) => h("section", { class: "card tcard simple" },
    h("div", { class: "card-head" }, h("h2", { text: title }), h("span", { class: "sec-count", text: "AM and PM" })),
    h("div", { class: "sgrid-head" }, h("span", { text: "Zone" }), h("span", { text: NAME[shift] + " °C" }), h("span", { text: NAME[C.otherShift(shift)] }), h("span", { text: "Notes" })),
    list.map((r) => h("div", { class: "srow", "data-row": r.id },
      h("div", { class: "trow-name" }, h("b", { text: r.name }), h("span", { class: "spec", text: r.target + "°C" })),
      numField(C.tempKey(r.id, shift), title + " " + r.name + " " + NAME[shift] + " (" + r.target + "°C)", { target: r.target, disabled: lockedShift, short: NAME[shift] + " °C" }),
      otherValue(C.tempKey(r.id, C.otherShift(shift))),
      textField(C.tempKey(r.id, "notes"), title + " " + r.name + " notes", { disabled: lockedShared, placeholder: "Notes", short: "Notes" }))));

  const hint = lockedShift ? null : h("p", { class: "hint", text: "Type each reading - Next jumps to the next empty box. Anything out of range turns red and the corrective action box needs filling in. Switch AM / PM at the top for the other times." });
  return h("div", { class: "wrap" }, signedBanner(shift), tools, hint, fridges, hot, fryers, surface("Grill", T.grill), surface("Flat top", T.flat));
}

function otherValue(key) {
  const el = h("div", { class: "other-value" });
  const update = () => replace(el, text(key) ? h("b", { text: text(key) }) : h("span", { class: "muted", text: "-" }));
  ctx.fields.set(key, { update });
  update();
  return el;
}

/** A fridge / hot-holding row: station, food item, this shift's readings, corrective action. */
function tempRow(row, o) {
  const caKey = C.tempKey(row.id, "ca");
  const nameKey = C.tempKey(row.id, "name");
  const photoOn = C.tempPhotoTarget(row.id, o.shift);
  const label = () => C.rowName(day(), row) || "Other";
  const thumbs = thumbStrip(photoOn, label() + " (" + NAME[o.shift] + ")");
  const othersEl = h("div", { class: "other-readings" });
  const caField = textField(caKey, label() + " corrective action", { disabled: o.lockedShared, placeholder: "Corrective action", wide: true, short: "Corrective action" });
  const refreshRow = () => {
    const bad = o.slots.some((s) => s.check(text(C.tempKey(row.id, s.slot))) === "bad");
    caField.classList.toggle("needed", bad && !text(caKey).trim());
    el.classList.toggle("row-bad", bad);
    replace(othersEl, o.others.map(([slot, l]) => (text(C.tempKey(row.id, slot)) ? h("span", { class: "chip-small" }, l + " ", h("b", { text: text(C.tempKey(row.id, slot)) })) : null)));
  };
  const station = h("div", { class: "trow-name" },
    row.name ? h("b", { text: row.name }) : textField(nameKey, "Station name (" + o.otherWord + ")", { disabled: o.lockedShared, placeholder: o.otherWord[0].toUpperCase() + o.otherWord.slice(1) + " - name", short: "Name", onCommit: () => ctx.refresh() }),
    h("span", { class: "spec", text: C.limitLabel(row.limit) }), othersEl, thumbs.el);
  const el = h("div", { class: "trow", "data-row": row.id },
    station,
    textField(C.tempKey(row.id, "food"), label() + " food item probed", { disabled: o.lockedShared, placeholder: "Food item", short: "Food item probed" }),
    o.slots.map((s) => numField(C.tempKey(row.id, s.slot), label() + " " + s.label + " (" + C.limitLabel(row.limit) + ")", { check: s.check, disabled: o.lockedShift, onCommit: refreshRow, short: s.label[0].toUpperCase() + s.label.slice(1) })),
    caField,
    ctx.state.photos ? cameraButton(photoOn, label() + " (" + NAME[o.shift] + ")", () => thumbs.refresh(), o.lockedShift) : h("span"));
  ctx.fields.set(caKey, Object.assign({}, ctx.fields.get(caKey), { row: refreshRow, update: chain(ctx.fields.get(caKey), refreshRow) }));
  for (const [slot] of o.others) ctx.fields.set(C.tempKey(row.id, slot), { update: refreshRow });
  for (const s of o.slots) {
    const f = ctx.fields.get(C.tempKey(row.id, s.slot));
    ctx.fields.set(C.tempKey(row.id, s.slot), Object.assign({}, f, { update: chain(f, refreshRow) }));
  }
  refreshRow();
  return el;
}

function chain(field, then) {
  const first = field && field.update;
  return () => { if (first) first(); then(); };
}

/** Dish washer: wash and rinse for each of this shift's times. */
function dishRow(dish, hotSlots, lockedShift, lockedShared) {
  const caKey = C.tempKey(dish.id, "ca");
  const caField = textField(caKey, "Dish washer corrective action", { disabled: lockedShared, placeholder: "Corrective action", wide: true, short: "Corrective action" });
  const el = h("div", { class: "trow dish", "data-row": dish.id });
  const refreshRow = () => {
    const bad = hotSlots.some(([slot]) => C.judgeDish(text(C.tempKey(dish.id, slot + "w")), text(C.tempKey(dish.id, slot + "r")), dish.limit) === "bad");
    caField.classList.toggle("needed", bad && !text(caKey).trim());
    el.classList.toggle("row-bad", bad);
  };
  replace(el,
    h("div", { class: "trow-name" }, h("b", { text: dish.name }), h("span", { class: "spec", text: dish.label })),
    h("span", { class: "muted dish-note", text: "wash / rinse" }),
    hotSlots.map(([slot, time]) => h("div", { class: "dish-pair" },
      numField(C.tempKey(dish.id, slot + "w"), "Dish washer " + time + " wash (≥ " + dish.limit.wash + "°C)", { check: (v) => C.judgeTemp(v, { min: dish.limit.wash }), disabled: lockedShift, onCommit: refreshRow, placeholder: "W", short: time + " wash" }),
      numField(C.tempKey(dish.id, slot + "r"), "Dish washer " + time + " rinse (≥ " + dish.limit.rinse + "°C)", { check: (v) => C.judgeTemp(v, { min: dish.limit.rinse }), disabled: lockedShift, onCommit: refreshRow, placeholder: "R", short: time + " rinse" }))),
    caField,
    h("span"));
  const prev = ctx.fields.get(caKey);
  ctx.fields.set(caKey, { update: chain(prev, refreshRow) });
  refreshRow();
  return el;
}

/** A number box (temperature / TPM). Saves as you type; Next goes to the next empty one. */
function numField(key, label, opts = {}) {
  const input = h("input", Object.assign({ class: "tfield", type: "text", maxlength: 7, placeholder: opts.placeholder || "", "aria-label": label, disabled: opts.disabled, "data-key": key }, keypadAttrs(label)));
  const wrapEl = h("label", { class: "tbox num" }, h("span", { class: "tbox-label", text: opts.short || label }), input);
  const judge = () => {
    const v = input.value.trim();
    const verdict = opts.check ? opts.check(v) : null;
    const off = opts.target != null && C.offTarget(v, opts.target);
    wrapEl.classList.toggle("bad", verdict === "bad");
    wrapEl.classList.toggle("warn", off);
    wrapEl.classList.toggle("good", verdict === "ok");
    input.classList.toggle("invalid", !!v && !opts.plain && C.parseTemp(v) == null && v !== "-");
  };
  const update = () => {
    if (document.activeElement !== input) input.value = text(key);
    judge();
  };
  let timer = null;
  const commit = () => {
    clearTimeout(timer);
    const v = opts.plain ? input.value.trim() : C.cleanTemp(input.value);
    if (v === text(key)) return;
    save(key, v || null);
    judge();
    if (opts.onCommit) opts.onCommit();
    ctx.refresh();
  };
  input.addEventListener("input", () => { judge(); clearTimeout(timer); timer = setTimeout(safe(commit), 700); });
  input.addEventListener("change", safe(commit));
  input.addEventListener("blur", safe(commit));
  input.addEventListener("keydown", safe((e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    commit();
    const row = input.closest("[data-row]");
    if (opts.check && opts.check(input.value.trim()) === "bad" && row) {
      const ca = row.querySelector(".tbox.wide input");
      if (ca && !ca.value.trim()) { hideKeypad(); ca.focus(); return; }
    }
    focusNextEmpty(input);
  }));
  ctx.fields.set(key, { update });
  update();
  return wrapEl;
}

function textField(key, label, opts = {}) {
  const input = h("input", { class: "tfield text", type: "text", maxlength: 200, placeholder: opts.placeholder || "", "aria-label": label, disabled: opts.disabled, enterkeyhint: "done", "data-key": key });
  const wrapEl = h("label", { class: "tbox" + (opts.wide ? " wide" : "") }, h("span", { class: "tbox-label", text: opts.short || label }), input);
  const update = () => { if (document.activeElement !== input) input.value = text(key); };
  let timer = null;
  const commit = () => {
    clearTimeout(timer);
    const v = input.value.trim();
    if (v === text(key)) return;
    save(key, v || null);
    if (opts.onCommit) opts.onCommit();
    const f = ctx.fields.get(key);
    if (f && f.row) f.row();
    ctx.refresh();
  };
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(safe(commit), 600); });
  input.addEventListener("change", safe(commit));
  input.addEventListener("blur", safe(commit));
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); input.blur(); } });
  ctx.fields.set(key, { update });
  update();
  return wrapEl;
}

/** Next empty number box on the page (wrapping round), else finish. */
function focusNextEmpty(current) {
  const all = [...document.querySelectorAll("#main input.tfield[data-keypad]:not(:disabled)")];
  const start = all.indexOf(current);
  const order = all.slice(start + 1).concat(all.slice(0, Math.max(0, start)));
  const next = order.find((i) => !i.value.trim() && i.offsetParent !== null);
  if (next) {
    next.focus({ preventScroll: true });
    next.scrollIntoView({ block: "center", behavior: "smooth" });
  } else {
    current.blur();
    hideKeypad();
    toast("Every temperature box for this shift has a reading.");
  }
}

export function refreshTemps() {
  const rec = day();
  const shift = ctx.state.shift;
  const p = C.shiftProgress(rec, shift);
  const t = document.getElementById("temps-progress");
  const fill = document.getElementById("temps-fill");
  if (t) replace(t, h("b", { text: NAME[shift] + " temperatures: " + p.temps.done + " of " + p.temps.total }),
    p.temps.issues ? h("span", { class: "issues", text: " · " + p.temps.issues + " out of range" }) : null);
  if (fill) fill.style.width = (p.temps.total ? Math.round((p.temps.done / p.temps.total) * 100) : 0) + "%";
}

export function jumpToNextTemp(focus = true) {
  const all = [...document.querySelectorAll("#main input.tfield[data-keypad]:not(:disabled)")];
  const target = all.find((i) => !i.value.trim() && i.getBoundingClientRect().top > 160) || all.find((i) => !i.value.trim());
  if (!target) return false;
  jumpTo(target.closest(".trow, .srow") || target);
  if (focus) target.focus({ preventScroll: true });
  return true;
}

/** From the sign-off sheet: go to a row's corrective action, or to one reading. */
export function showTempRow(rowId, what) {
  const row = document.querySelector('#main [data-row="' + CSS.escape(rowId) + '"]');
  if (!row) return;
  jumpTo(row, what === "ca" ? ".tbox.wide input" : "input.tfield");
}

export function showTempField(key) {
  const f = [...document.querySelectorAll("#main input.tfield")].find((i) => i.dataset.key === key);
  if (f) { jumpTo(f.closest(".trow, .srow") || f); f.focus({ preventScroll: true }); }
}
