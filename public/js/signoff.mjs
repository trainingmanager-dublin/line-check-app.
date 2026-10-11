/*
 * Signing off a shift (line check and temperatures together): a summary,
 * anything that still needs a corrective action, the manager's name and a
 * finger-drawn signature. Reopening asks who is reopening and keeps a
 * history, so the printout shows who signed, who reopened and when.
 */
import { h, icon } from "./dom.mjs";
import * as C from "./core.mjs";
import { ctx, day, value, save, signed, toast, modal, safe, nameField, names } from "./ctx.mjs";
import { createPad, sigSvg } from "./signature.mjs";

const NAME = C.SHIFT_NAME;

export function history(shift) {
  const v = value(C.histKey(shift));
  return Array.isArray(v) ? v : [];
}

function addHistory(shift, entry) {
  save(C.histKey(shift), history(shift).concat([entry]).slice(-20));
}

/** What to fix before signing, and what's simply not done yet. */
export function shiftCheck(shift) {
  const rec = day();
  const p = C.shiftProgress(rec, shift);
  const lineBlock = C.lineNeedingAction(rec, shift).map((item) => ({ kind: "line", id: item.id, label: item.name, why: whyLine(item, shift) }));
  const tempBlock = C.tempsNeedingAction(rec, shift).map((t) => ({ kind: "temp", id: t.rowId, label: t.label, why: "out of range - write the corrective action" }));
  const lineLeft = C.lineItems(rec.tpl).filter((it) => !C.normLine(value(C.lineKey(it.id, shift))).s).map((it) => ({ kind: "line", id: it.id, label: it.name }));
  const tempLeft = C.tempTasks(rec, shift).filter((t) => !String(value(t.key) == null ? "" : value(t.key)).trim()).map((t) => ({ kind: "tempField", id: t.key, label: t.label }));
  return { p, block: lineBlock.concat(tempBlock), lineLeft, tempLeft };
}

function whyLine(item, shift) {
  const v = C.normLine(value(C.lineKey(item.id, shift)));
  if (C.judgeTemp(v.t, item.limit) === "bad") return v.t + "°C is out of range (" + C.limitLabel(item.limit) + ") - say what was done";
  return "marked as a problem - say what was done";
}

function goToProblem(entry) {
  if (entry.kind === "line") ctx.showLineItem(entry.id, true);
  else if (entry.kind === "temp") ctx.showTempRow(entry.id, "ca");
  else ctx.showTempField(entry.id);
}

function list(entries, max, button) {
  const shown = entries.slice(0, max);
  return h("ul", { class: "check-list" },
    shown.map((e) => h("li", null,
      h("span", null, h("b", { text: e.label }), e.why ? h("span", { class: "muted", text: " - " + e.why }) : null),
      h("button", { type: "button", class: "btn small ghost", text: button, onclick: safe(() => { closeAll(); goToProblem(e); }) }))),
    entries.length > max ? h("li", { class: "muted", text: "…and " + (entries.length - max) + " more" }) : null);
}

let current = null;
function closeAll() { if (current) current.close(); current = null; }

export function openSignOff(shift) {
  const { p, block, lineLeft, tempLeft } = shiftCheck(shift);
  // Not pre-filled: the PM manager mustn't sign with the AM manager's name by accident.
  let name = "";
  let pad = null;
  const signBtn = h("button", { class: "btn primary big", type: "button" }, icon("lock", 18), h("span", { text: "Sign off " + NAME[shift] }));
  const reason = h("p", { class: "sign-reason" });
  const refresh = () => {
    const missing = [];
    if (block.length) missing.push("write the corrective action" + (block.length > 1 ? "s" : "") + " above");
    if (!name.trim()) missing.push("add your name");
    if (!pad || pad.isEmpty()) missing.push("sign");
    signBtn.disabled = missing.length > 0;
    reason.textContent = missing.length ? "To sign off: " + missing.join(", ") + "." : "";
  };
  const nf = nameField("Manager name", name, (v) => { name = v; refresh(); });
  pad = createPad(refresh);

  const stats = h("div", { class: "sign-stats" },
    h("div", { class: "stat" + (p.done === p.total ? " ok" : "") }, h("b", { text: p.done + "/" + p.total }), h("span", { text: "line check items" })),
    h("div", { class: "stat" + (p.temps.done === p.temps.total ? " ok" : "") }, h("b", { text: p.temps.done + "/" + p.temps.total }), h("span", { text: "temperature readings" })),
    h("div", { class: "stat" + (p.issues + p.temps.issues ? " bad" : " ok") }, h("b", { text: String(p.issues + p.temps.issues) }), h("span", { text: "problems" })));

  const body = [
    stats,
    block.length ? h("div", { class: "sign-block bad" },
      h("h3", null, icon("alert", 18), h("span", { text: "Needs a corrective action before signing (" + block.length + ")" })),
      list(block, 12, "Add")) : null,
    lineLeft.length || tempLeft.length ? h("details", { class: "sign-block warn" },
      h("summary", { text: "Not done yet: " + [lineLeft.length ? lineLeft.length + " line check item" + (lineLeft.length > 1 ? "s" : "") : "", tempLeft.length ? tempLeft.length + " temperature reading" + (tempLeft.length > 1 ? "s" : "") : ""].filter(Boolean).join(" and ") + " (you can still sign)" }),
      lineLeft.length ? list(lineLeft, 10, "Go") : null,
      tempLeft.length ? list(tempLeft, 10, "Go") : null) : h("p", { class: "sign-allgood", text: "Everything for the " + NAME[shift] + " shift is done." }),
    nf.el,
    h("label", { class: "field-label", text: "Signature" }),
    pad.el,
    reason,
    h("div", { class: "btn-row end" },
      h("button", { class: "btn ghost", type: "button", text: "Cancel", onclick: () => closeAll() }),
      signBtn),
  ];
  current = modal("Sign off " + NAME[shift] + " · " + C.prettyDate(day().date, { weekday: "long", day: "numeric", month: "long" }), body, {
    wide: true, sticky: true, onClose: () => { pad.destroy(); current = null; },
  });
  signBtn.addEventListener("click", safe(() => {
    refresh();
    if (signBtn.disabled) return;
    const n = name.trim().slice(0, C.MAX_NAME);
    const at = new Date().toISOString();
    if (!save(C.signKey(shift), { name: n, i: C.initialsOf(n), at, sig: pad.value() })) return;
    addHistory(shift, { a: "sign", name: n, at });
    names.remember(n);
    closeAll();
    ctx.render();
    toast(NAME[shift] + " signed off by " + n + ". Saved and ready to print.", "ok", { label: "Print", run: () => ctx.goPrint() });
  }));
  refresh();
  // With names to pick from, don't pop up the keyboard; otherwise go straight to typing.
  setTimeout(() => { if (!names.list().length) nf.input.focus(); }, 60);
}

export function openReopen(shift) {
  let name = "";
  const btn = h("button", { class: "btn primary", type: "button", disabled: true }, icon("unlock", 18), h("span", { text: "Reopen " + NAME[shift] }));
  const nf = nameField("Who is reopening it?", "", (v) => { name = v; btn.disabled = !v.trim(); });
  const s = signed(shift);
  current = modal("Reopen " + NAME[shift] + "?", [
    h("p", { text: "Everything already filled in stays. " + (s ? NAME[shift] + " was signed off by " + (s.name || s.i) + " at " + C.timeOf(s.at) + "; " : "") + "it will need signing again." }),
    nf.el,
    h("div", { class: "btn-row end" }, h("button", { class: "btn ghost", type: "button", text: "Cancel", onclick: () => closeAll() }), btn),
  ], { onClose: () => { current = null; } });
  btn.addEventListener("click", safe(() => {
    const n = name.trim().slice(0, C.MAX_NAME);
    if (!n) return;
    save(C.signKey(shift), null);
    addHistory(shift, { a: "reopen", name: n, at: new Date().toISOString() });
    names.remember(n);
    closeAll();
    ctx.state.shift = shift;
    ctx.render();
    toast(NAME[shift] + " reopened by " + n + " - carry on where it was left.");
    setTimeout(() => ctx.jumpToNext({ focus: false }), 350);
  }));
  setTimeout(() => nf.input.focus(), 60);
}

/** "Signed off by … at …" with the signature, for the top of a signed shift. */
export function signedBanner(shift) {
  const s = signed(shift);
  if (!s) return null;
  return h("div", { class: "banner done signed" },
    icon("lock"),
    h("span", null, h("b", { text: NAME[shift] + " signed off" }), " by " + (s.name || s.i) + " at " + C.timeOf(s.at) + ". Locked."),
    s.sig ? sigSvg(s.sig, "sig-inline") : null,
    h("button", { class: "btn small", type: "button", onclick: safe(() => openReopen(shift)) }, icon("unlock", 16), h("span", { text: "Reopen" })));
}
