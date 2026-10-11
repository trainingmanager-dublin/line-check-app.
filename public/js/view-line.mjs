/*
 * The line check: every section on one page, laid out like the paper sheet
 * (item and quality identifiers | temp | shelf life | utensil | check).
 * "Still to do" hides what's finished, so the list shrinks as you go.
 */
import { h, icon, replace } from "./dom.mjs";
import * as C from "./core.mjs";
import { ctx, day, value, save, signed, toast, safe, jumpTo, prefSet } from "./ctx.mjs";
import { keypadAttrs, hide as hideKeypad } from "./keypad.mjs";
import { cameraButton, thumbStrip } from "./photos.mjs";
import { signedBanner } from "./signoff.mjs";

const NAME = C.SHIFT_NAME;
let sectionEls = [];

/** Done for the "still to do" filter: ticked, or a problem with its comment written. */
const isDone = (v) => v.s === "ok" || (v.s === "no" && !!v.n.trim());

export function lineView() {
  const tpl = day().tpl;
  const shift = ctx.state.shift;
  const locked = !!signed(shift);
  sectionEls = [];

  const chips = tpl.line.map((section, i) => {
    const count = h("span", { class: "count" });
    const chip = h("a", { href: "#sec-" + i, class: "chip", onclick: safe((e) => { e.preventDefault(); showSection(i); }) },
      h("span", { text: section.name }), count);
    return { chip, count };
  });
  const nav = h("nav", { class: "section-nav", "aria-label": "Sections" }, chips.map((c) => c.chip));

  const todoSeg = h("div", { class: "seg light", role: "group", "aria-label": "Show" },
    [["0", "All items"], ["1", "Still to do"]].map(([v, label]) => h("button", {
      type: "button", class: "seg-btn" + ((ctx.state.todo ? "1" : "0") === v ? " on" : ""), "aria-pressed": String((ctx.state.todo ? "1" : "0") === v),
      onclick: safe(() => { ctx.state.todo = v === "1"; prefSet("todo", v); ctx.render(); }),
    }, label)));
  const photoSwitch = h("label", { class: "switch" },
    h("input", { type: "checkbox", checked: ctx.state.photos, onchange: safe((e) => { ctx.state.photos = e.target.checked; prefSet("photos", e.target.checked ? "1" : "0"); ctx.render(); }) }),
    h("span", { class: "switch-ui", "aria-hidden": "true" }), icon("camera", 18), h("span", { text: "Photos" }));

  const tools = h("div", { class: "tools" },
    h("div", { class: "progress-wrap" },
      h("div", { class: "progress-text", id: "line-progress" }),
      h("div", { class: "progress-bar" }, h("div", { class: "progress-fill", id: "line-fill" }))),
    todoSeg, photoSwitch);

  const hint = locked ? null : h("p", { class: "hint" },
    "Tap ", h("b", { text: "✓" }), " when an item is right, ", h("b", { text: "!" }), " if there's a problem. Type a temperature and it ticks itself when it's in range; ",
    h("b", { text: "Next" }), " goes to the next one. Tap an item's name to add a comment.");

  const sections = tpl.line.map((section, i) => {
    const count = h("span", { class: "sec-count" });
    const card = h("section", { class: "card sec", id: "sec-" + i, "aria-labelledby": "sech-" + i },
      h("div", { class: "card-head" },
        h("h2", { id: "sech-" + i, text: section.name }), count,
        locked ? null : h("button", { class: "btn small ghost", type: "button", onclick: safe(() => markSectionOk(section, shift)) }, icon("checks", 16), h("span", { text: "Rest OK" }))),
      h("div", { class: "col-head", "aria-hidden": "true" },
        h("span", { text: section.columns ? "Item · quality identifiers" : "Item" }),
        h("span", { text: section.columns ? "Temp" : "" }), h("span", { text: section.columns ? "Shelf life" : "" }), h("span", { text: section.columns ? "Utensil" : "" }),
        h("span", { class: "col-check", text: NAME[shift] + " check" })),
      section.items.map((item) => lineRow(item, shift, locked)),
      h("p", { class: "sec-done", text: "✓ " + section.name + " is done" }));
    sectionEls.push({ card, count, chip: chips[i], items: section.items });
    return card;
  });

  document.body.classList.toggle("todo", ctx.state.todo);
  return [nav, h("div", { class: "wrap" }, signedBanner(shift), tools, hint, sections)];
}

function showSection(i) {
  const s = sectionEls[i];
  if (s) jumpTo(s.card);
}

function lineRow(item, shift, locked) {
  const key = C.lineKey(item.id, shift);
  const otherKey = C.lineKey(item.id, C.otherShift(shift));
  const get = () => C.normLine(value(key));
  let autoAt = 0; // when a reading last ticked/flagged the item by itself
  const put = (patch) => {
    const next = Object.assign(get(), patch);
    save(key, C.compactLine(next));
    update();
    ctx.refresh();
  };

  const tempIn = item.limit ? h("input", Object.assign({
    class: "temp", type: "text", placeholder: "°C", disabled: locked,
    "aria-label": item.name + " temperature (" + C.limitLabel(item.limit) + ")",
  }, keypadAttrs(item.name + " · " + C.limitLabel(item.limit)))) : null;
  const tick = h("button", { class: "tick", type: "button", "aria-label": item.name + " OK", disabled: locked }, icon("check", 24));
  const flag = h("button", { class: "flag", type: "button", "aria-label": item.name + " problem", disabled: locked }, h("span", { text: "!" }));
  const photoOn = key;
  const thumbs = thumbStrip(photoOn, item.name + " (" + NAME[shift] + ")");
  const cam = ctx.state.photos ? cameraButton(photoOn, item.name + " (" + NAME[shift] + ")", () => thumbs.refresh(), locked) : null;
  const nameBtn = h("button", { class: "item-name", type: "button", "aria-expanded": "false" }, item.name);
  const codeBtns = C.CODES.map(([code, label]) => h("button", { type: "button", class: "code", "data-code": code, title: label, disabled: locked, "aria-pressed": "false" },
    h("b", { text: code }), h("span", { text: label })));
  const note = h("input", { class: "note", type: "text", maxlength: 300, placeholder: "Comment / corrective action", "aria-label": item.name + " comment", disabled: locked, enterkeyhint: "done" });
  const other = h("div", { class: "other" });
  const narrow = h("div", { class: "specs-narrow" },
    item.temp ? h("span", { class: "spec" + (item.limit ? " spec-temp" : ""), text: item.temp }) : null,
    item.life ? h("span", { class: "spec", text: item.life }) : null,
    item.utensil ? h("span", { class: "spec", text: item.utensil }) : null);
  const detail = h("div", { class: "detail" }, h("div", { class: "codes" }, codeBtns), note);
  const el = h("div", { class: "item", "data-id": item.id },
    h("div", { class: "item-main" }, nameBtn, item.quality ? h("p", { class: "item-q", text: item.quality }) : null, narrow, other, thumbs.el),
    h("div", { class: "cell cell-temp" + (item.limit ? " has-limit" : ""), text: item.temp }),
    h("div", { class: "cell", text: item.life }),
    h("div", { class: "cell", text: item.utensil }),
    h("div", { class: "item-actions" }, tempIn, tick, flag, cam),
    detail);

  const judgeBad = (t) => C.judgeTemp(t, item.limit) === "bad";

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
    const open = ctx.state.open.has(item.id) || v.s === "no" || bad || !!v.n || v.c.length > 0;
    el.classList.toggle("open", open);
    nameBtn.setAttribute("aria-expanded", String(open));
    note.placeholder = bad ? "Out of range - what did you do? (e.g. moved to walk-in, re-probed, discarded)"
      : v.s === "no" ? "What's wrong and what did you do?" : "Comment / corrective action";
    note.classList.toggle("needed", (v.s === "no" || bad) && !v.n.trim());
    const o = C.normLine(value(otherKey));
    replace(other, C.isLineEmpty(o) ? null : [
      h("b", { text: NAME[C.otherShift(shift)] + ": " }),
      o.s === "ok" ? "✓ " : o.s === "no" ? "✗ " : "",
      o.t ? o.t + "°C " : "", o.c.length ? o.c.join(" ") + " " : "", o.n ? "- " + o.n : ""]);
    // "Still to do": a finished row slides away a moment after it's done.
    const done = isDone(v);
    if (done && !el.classList.contains("done") && !el.classList.contains("leaving")) {
      if (ctx.state.todo && el.isConnected) {
        el.classList.add("leaving");
        setTimeout(() => { el.classList.remove("leaving"); if (isDone(get())) el.classList.add("done"); ctx.refresh(); }, 900);
      } else {
        el.classList.add("done");
      }
    } else if (!done) {
      el.classList.remove("done", "leaving");
    }
  }

  nameBtn.addEventListener("click", safe(() => {
    if (ctx.state.open.has(item.id)) ctx.state.open.delete(item.id); else ctx.state.open.add(item.id);
    update();
    if (ctx.state.open.has(item.id) && !locked) note.focus({ preventScroll: true });
  }));
  tick.addEventListener("click", safe(() => {
    const v = get();
    // A reading typed a moment ago already ticked it; this tap means "yes, OK", not "undo".
    if (v.s === "ok" && Date.now() - autoAt < 800) return;
    put({ s: v.s === "ok" ? "" : "ok" });
  }));
  flag.addEventListener("click", safe(() => {
    const v = get();
    if (v.s === "no" && Date.now() - autoAt < 800) { note.focus(); return; }
    const s = v.s === "no" ? "" : "no";
    if (s === "no") ctx.state.open.add(item.id);
    put({ s });
    if (s === "no") note.focus();
  }));
  codeBtns.forEach((b) => b.addEventListener("click", safe(() => {
    const v = get();
    put({ c: v.c.includes(b.dataset.code) ? v.c.filter((x) => x !== b.dataset.code) : v.c.concat(b.dataset.code) });
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
      const text = C.cleanTemp(tempIn.value);
      const v = get();
      if (text === v.t) return;
      const verdict = C.judgeTemp(text, item.limit);
      const patch = { t: text };
      // An in-range reading ticks the item (and clears a "!" that only came from a bad reading).
      if (verdict === "ok" && (v.s !== "no" || judgeBad(v.t))) { patch.s = "ok"; autoAt = Date.now(); }
      if (verdict === "bad") { patch.s = "no"; ctx.state.open.add(item.id); autoAt = Date.now(); }
      if (!text && v.s === "ok" && !v.c.length && !v.n) patch.s = "";
      put(patch);
    };
    tempIn.addEventListener("input", () => {
      tempIn.classList.toggle("invalid", !!tempIn.value.trim() && C.parseTemp(tempIn.value) == null && tempIn.value.trim() !== "-");
      clearTimeout(tempTimer);
      tempTimer = setTimeout(safe(saveTemp), 700);
    });
    tempIn.addEventListener("change", safe(saveTemp));
    tempIn.addEventListener("blur", safe(saveTemp));
    tempIn.addEventListener("keydown", safe((e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      saveTemp();
      if (judgeBad(get().t)) { hideKeypad(); note.focus(); return; }
      focusNextTemp(tempIn);
    }));
  }

  ctx.rows.set(item.id, { update, el, refreshPhotos: () => thumbs.refresh() });
  update();
  return el;
}

/** The next temperature box still to do (wrapping round to the top), else finish. */
function focusNextTemp(current) {
  const all = [...document.querySelectorAll("#main .item input.temp:not(:disabled)")];
  const pending = (input) => {
    const row = input.closest(".item");
    return row && !row.classList.contains("done") && !row.classList.contains("leaving") && row.dataset.state !== "ok" && row.offsetParent !== null;
  };
  const start = all.indexOf(current);
  const order = all.slice(start + 1).concat(all.slice(0, Math.max(0, start)));
  const next = order.find(pending);
  if (next) {
    next.focus({ preventScroll: true });
    next.scrollIntoView({ block: "center", behavior: "smooth" });
  } else {
    current.blur();
    hideKeypad();
    toast("All the temperatures on the line check are in.");
  }
}

/**
 * Ticks every unchecked item in the section that doesn't need a temperature.
 * Temperature items need their reading (an in-range reading ticks itself),
 * so they're left, and the first one is opened ready to type.
 */
function markSectionOk(section, shift) {
  const before = [];
  const needReading = [];
  for (const item of section.items) {
    const key = C.lineKey(item.id, shift);
    const v = C.normLine(value(key));
    if (v.s) continue;
    if (item.limit) { needReading.push(item); continue; }
    before.push([key, value(key)]);
    save(key, C.compactLine(Object.assign(v, { s: "ok" })));
    const r = ctx.rows.get(item.id);
    if (r) r.update();
  }
  ctx.refresh();
  const readings = needReading.length ? needReading.length + " temperature" + (needReading.length === 1 ? "" : "s") + " still to take." : "";
  if (needReading.length) {
    const r = ctx.rows.get(needReading[0].id);
    if (r) jumpTo(r.el, "input.temp");
  }
  if (!before.length) {
    toast(readings ? "Only temperatures left in " + section.name + ": " + readings : "Everything in " + section.name + " is already done.");
    return;
  }
  toast(before.length + " item" + (before.length === 1 ? "" : "s") + " in " + section.name + " marked OK." + (readings ? " " + readings : ""), "ok", {
    label: "Undo",
    run: safe(() => {
      for (const [key, old] of before) save(key, old);
      for (const item of section.items) { const r = ctx.rows.get(item.id); if (r) r.update(); }
      ctx.refresh();
    }),
  });
}

/** Progress text, section counts and the "still to do" view. */
export function refreshLine() {
  const rec = day();
  const shift = ctx.state.shift;
  const p = C.shiftProgress(rec, shift);
  const text = document.getElementById("line-progress");
  const fill = document.getElementById("line-fill");
  if (text) replace(text, h("b", { text: NAME[shift] + " line check: " + p.done + " of " + p.total }),
    p.issues ? h("span", { class: "issues", text: " · " + p.issues + " problem" + (p.issues === 1 ? "" : "s") }) : null);
  if (fill) fill.style.width = (p.total ? Math.round((p.done / p.total) * 100) : 0) + "%";
  for (const s of sectionEls) {
    let done = 0, finished = 0;
    for (const it of s.items) {
      const v = C.normLine(value(C.lineKey(it.id, shift)));
      if (v.s) done++;
      if (isDone(v)) finished++;
    }
    s.count.textContent = done + "/" + s.items.length;
    s.chip.count.textContent = done + "/" + s.items.length;
    s.chip.chip.classList.toggle("complete", done === s.items.length);
    s.card.classList.toggle("complete", finished === s.items.length);
  }
}

/** The first item still to do below the top of the screen (else the first one). */
export function jumpToNextLine(focus = true) {
  const shift = ctx.state.shift;
  const left = C.lineItems(day().tpl).filter((it) => !C.normLine(value(C.lineKey(it.id, shift))).s);
  if (!left.length) return false;
  const els = left.map((it) => ctx.rows.get(it.id)).filter(Boolean).map((r) => r.el).filter((el) => el.offsetParent !== null);
  const target = els.find((el) => el.getBoundingClientRect().top > 200) || els[0];
  if (!target) return false;
  jumpTo(target, focus ? "input.temp:not(:disabled)" : null);
  return true;
}

/** Scroll to an item (from the sign-off sheet) and open its comment box. */
export function showLineItem(id, focusNote) {
  const r = ctx.rows.get(id);
  if (!r) return;
  ctx.state.open.add(id);
  r.update();
  r.el.classList.remove("done");
  jumpTo(r.el, focusNote ? "input.note" : "input.temp:not(:disabled)");
}
