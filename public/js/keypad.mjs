/*
 * On-screen number pad for temperatures.
 *
 * Big keys, a minus key for freezers (the tablet's own number keyboard often
 * has none) and "Next" to jump to the next reading. Any input with
 * data-keypad uses it; the tablet's keyboard stays hidden (inputmode=none).
 * "Keyboard" switches back to the tablet's own keyboard if wanted.
 */
import { h } from "./dom.mjs";
import { prefGet, prefSet } from "./ctx.mjs";

let panel = null;
let labelEl = null;
let target = null;

export function keypadOn() {
  const fallback = window.matchMedia && window.matchMedia("(pointer: coarse)").matches ? "1" : "0";
  return prefGet("keypad", fallback) === "1";
}

export function setKeypad(on) {
  prefSet("keypad", on ? "1" : "0");
  for (const input of document.querySelectorAll("input[data-keypad]")) input.setAttribute("inputmode", on ? "none" : "decimal");
  if (!on) hide();
}

/** Attributes for a temperature input. */
export function keypadAttrs(label) {
  return { "data-keypad": label || "", inputmode: keypadOn() ? "none" : "decimal", autocomplete: "off", enterkeyhint: "next" };
}

function fire(input, type) {
  input.dispatchEvent(new Event(type, { bubbles: true }));
}

function press(key) {
  if (!target || target.disabled) return;
  const input = target;
  let v = input.value;
  if (key === "back") v = v.slice(0, -1);
  else if (key === "clear") v = "";
  else if (key === "minus") v = v.startsWith("-") ? v.slice(1) : "-" + v;
  else if (key === ".") { if (!v.includes(".")) v = (v === "" || v === "-" ? v + "0" : v) + "."; }
  else if (/^\d$/.test(key)) { if (v.replace(/[^0-9]/g, "").length < 4) v += key; }
  if (v !== input.value) {
    input.value = v;
    fire(input, "input");
  }
  if (document.activeElement !== input) input.focus({ preventScroll: true });
}

function next() {
  if (!target) return;
  target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
}

function build() {
  const key = (label, action, cls) => h("button", {
    type: "button", class: "kp-key " + (cls || ""), tabindex: "-1", "data-k": action, "aria-label": action === "back" ? "Delete" : action === "minus" ? "Minus" : label,
  }, label);
  labelEl = h("div", { class: "kp-label" });
  panel = h("div", { class: "keypad", hidden: true, role: "group", "aria-label": "Number pad" },
    h("div", { class: "kp-top" }, labelEl,
      h("button", { type: "button", class: "kp-mini", tabindex: "-1", "data-k": "keyboard", text: "Keyboard" }),
      h("button", { type: "button", class: "kp-mini", tabindex: "-1", "data-k": "done", text: "Done" })),
    h("div", { class: "kp-grid" },
      key("7", "7"), key("8", "8"), key("9", "9"), key("⌫", "back", "kp-fn"),
      key("4", "4"), key("5", "5"), key("6", "6"), key("−", "minus", "kp-fn"),
      key("1", "1"), key("2", "2"), key("3", "3"), key("Next ▸", "next", "kp-next"),
      key("0", "0", "kp-zero"), key(".", "."), key("C", "clear", "kp-fn")));
  // Act on pointerdown and cancel it, so the input keeps focus.
  panel.addEventListener("pointerdown", (e) => {
    const btn = e.target.closest("button[data-k]");
    e.preventDefault();
    if (!btn) return;
    const k = btn.dataset.k;
    btn.classList.add("down");
    setTimeout(() => btn.classList.remove("down"), 120);
    if (k === "next") next();
    else if (k === "done") { if (target) target.blur(); hide(); }
    else if (k === "keyboard") { setKeypad(false); const t = target; if (t) { t.blur(); setTimeout(() => t.focus(), 50); } }
    else press(k);
  });
  // Keyboard users / clicks that don't send pointer events.
  panel.addEventListener("click", (e) => e.preventDefault());
  document.body.appendChild(panel);
}

function show(input) {
  if (!panel) build();
  target = input;
  labelEl.textContent = input.getAttribute("data-keypad") || input.getAttribute("aria-label") || "";
  panel.hidden = false;
  document.body.classList.add("keypad-open");
  // Keep the box being typed in above the pad.
  requestAnimationFrame(() => {
    const box = input.getBoundingClientRect();
    const padTop = panel.getBoundingClientRect().top;
    if (box.bottom > padTop - 12 || box.top < 120) input.scrollIntoView({ block: "center", behavior: "smooth" });
  });
}

export function hide() {
  if (!panel) return;
  panel.hidden = true;
  target = null;
  document.body.classList.remove("keypad-open");
}

export function installKeypad() {
  document.addEventListener("focusin", (e) => {
    const el = e.target;
    if (el && el.matches && el.matches("input[data-keypad]") && keypadOn() && !el.disabled) show(el);
    else if (panel && !panel.contains(el)) hide();
  });
  // Tapping a number box that already has focus brings the pad back.
  document.addEventListener("click", (e) => {
    const el = e.target;
    if (el && el.matches && el.matches("input[data-keypad]") && keypadOn() && !el.disabled) show(el);
  });
  // Tapping anywhere else (not the pad, not a number box) finishes the entry and puts the pad away.
  document.addEventListener("pointerdown", (e) => {
    if (!panel || panel.hidden) return;
    if (panel.contains(e.target) || (e.target.matches && e.target.matches("input[data-keypad]"))) return;
    const t = target;
    hide();
    if (t && document.activeElement === t) t.blur();
  }, true);
}
