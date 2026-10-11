/*
 * Print & history: print or download the day (as the original Excel files),
 * look back at saved days, backups and a few settings.
 */
import { h, icon, replace } from "./dom.mjs";
import * as C from "./core.mjs";
import { ctx, day, signed, toast, safe, sessionGet, sessionSet, prefGet, prefSet } from "./ctx.mjs";
import { linePrint, tempPrint, photosPrint } from "./print.mjs";
import { lineCheckWorkbook, temperatureWorkbook, downloadBlob } from "./xlsx.mjs";
import { dayPhotos, exportPhotos, importPhotos, photoStats, deletePhotosBefore } from "./photos.mjs";
import { storageUsage } from "./store.mjs";
import { keypadOn, setKeypad } from "./keypad.mjs";
import { openSignOff } from "./signoff.mjs";

const NAME = C.SHIFT_NAME;
const mb = (bytes) => (bytes < 1048576 ? Math.max(1, Math.round(bytes / 1024)) + " KB" : (bytes / 1048576).toFixed(bytes > 104857600 ? 0 : 1) + " MB");

export function printView() {
  const rec = day();
  const statusLine = (shift) => {
    const p = C.shiftProgress(rec, shift);
    const s = signed(shift);
    return h("li", { class: s ? "ok" : "" },
      h("b", { text: NAME[shift] + ": " }),
      p.done + "/" + p.total + " line check, " + p.temps.done + "/" + p.temps.total + " temperatures" + (p.issues + p.temps.issues ? ", " + (p.issues + p.temps.issues) + " problem(s)" : "") + " - ",
      s ? "signed off by " + (s.name || s.i) + " at " + C.timeOf(s.at) : h("span", { class: "warn-text" }, "not signed off ",
        h("button", { class: "btn small", type: "button", text: "Sign off " + NAME[shift], onclick: safe(() => { ctx.state.shift = shift; openSignOff(shift); }) })));
  };

  const preview = h("div", { class: "preview" });
  const segBtns = [];
  const showPreview = (which) => {
    sessionSet("lc:preview", which);
    replace(preview, which === "temps" ? tempPrint(rec) : linePrint(rec));
    segBtns.forEach((b) => b.classList.toggle("on", b.dataset.which === which));
  };
  [["line", "Line check"], ["temps", "Temperatures"]].forEach(([w, l]) =>
    segBtns.push(h("button", { type: "button", class: "seg-btn", "data-which": w, onclick: safe(() => showPreview(w)) }, l)));
  showPreview(sessionGet("lc:preview") === "temps" ? "temps" : "line");

  const btn = (label, ic, fn, cls) => h("button", { class: "btn " + (cls || ""), type: "button", onclick: safe(fn) }, icon(ic, 18), h("span", { text: label }));
  const photoCount = C.photoRefs(rec).length;

  return h("div", { class: "wrap" },
    h("section", { class: "card" },
      h("div", { class: "card-head" }, h("h2", { text: C.prettyDate(rec.date, { weekday: "long", day: "numeric", month: "long", year: "numeric" }) })),
      h("ul", { class: "day-status" }, statusLine("am"), statusLine("pm")),
      h("div", { class: "out-grid" },
        h("div", { class: "out-box" },
          h("h3", { text: "Line Check Sheet" }),
          btn("Print", "printer", () => doPrint(["line"]), "primary"),
          btn("Excel file", "download", () => downloadExcel("line"))),
        h("div", { class: "out-box" },
          h("h3", { text: "Temperature Checklist" }),
          btn("Print", "printer", () => doPrint(["temps"]), "primary"),
          btn("Excel file", "download", () => downloadExcel("temps"))),
        h("div", { class: "out-box" },
          h("h3", { text: "Everything" }),
          btn("Print both" + (photoCount ? " + photos" : ""), "printer", () => doPrint(["line", "temps", "photos"]), "primary"),
          photoCount ? btn("Print photos (" + photoCount + ")", "camera", () => doPrint(["photos"])) : null)),
      h("p", { class: "muted", text: "Print is A4 landscape, laid out like the paper sheets - pick \"Save as PDF\" as the printer to keep a PDF. \"Excel file\" downloads your original Excel template with this day filled in, signatures included." })),
    h("section", { class: "card" },
      h("div", { class: "card-head" }, h("h2", { text: "Preview" }), h("div", { class: "seg" }, segBtns)),
      h("div", { class: "preview-scroll" }, preview)),
    historyCard(),
    backupCard(),
    settingsCard());
}

async function doPrint(which) {
  const rec = day();
  const root = document.getElementById("print-root");
  const docs = [];
  if (which.includes("line")) docs.push(linePrint(rec));
  if (which.includes("temps")) docs.push(tempPrint(rec));
  if (which.includes("photos")) {
    const pics = photosPrint(rec, await dayPhotos(rec));
    if (pics) docs.push(pics);
    else if (which.length === 1) { toast("No photos on this day."); return; }
  }
  replace(root, docs);
  const done = () => { replace(root); window.removeEventListener("afterprint", done); };
  window.addEventListener("afterprint", done);
  // Let the logo and photos load before the print dialog opens.
  const imgs = [...root.querySelectorAll("img")];
  await Promise.all(imgs.map((img) => (img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; setTimeout(r, 3000); }))));
  window.print();
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
      if (missing.length) toast("No row in the Excel template for: " + missing.join(", ") + " - they're in the printout.", "error");
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
  const month = ctx.state.month || day().date.slice(0, 7);
  const [y, m] = month.split("-").map(Number);
  const shiftMonth = (n) => { ctx.state.month = C.isoDate(new Date(y, m - 1 + n, 1)).slice(0, 7); ctx.render(); };
  const monthName = new Date(y, m - 1, 1).toLocaleDateString("en-IE", { month: "long", year: "numeric" });
  const list = h("div", { class: "history-list" }, h("p", { class: "muted pad", text: "Loading…" }));

  const part = (s, name) => {
    if (!s || Array.isArray(s)) return h("span", { class: "muted", text: name + " -" });
    return h("span", { class: "hist-shift" + (s.s ? " signed" : "") },
      h("b", { text: name + " " }), s.d + "/" + s.n, s.tn ? " · " + s.td + "/" + s.tn + "°" : "",
      s.i ? h("span", { class: "issues", text: " ⚠" + s.i }) : null, s.s ? h("span", { text: " ✓ " + s.s }) : null);
  };

  ctx.store.listMonth(month).then(safe((days) => {
    if (!days.length) { replace(list, h("p", { class: "muted pad", text: "Nothing saved on this tablet for " + monthName + "." })); return; }
    replace(list, days.map(({ date, summary: s }) =>
      h("div", { class: "hist-row" + (date === day().date ? " current" : "") },
        h("div", { class: "hist-date" }, h("b", { text: C.prettyDate(date, { weekday: "short", day: "numeric", month: "short" }) }), date === today ? h("span", { class: "spec", text: "Today" }) : null),
        h("div", { class: "hist-parts" }, part(s && s.am, "AM"), part(s && s.pm, "PM"), s && s.photos ? h("span", { class: "muted", text: s.photos + " photo" + (s.photos > 1 ? "s" : "") }) : null),
        h("div", { class: "hist-actions" },
          h("button", { class: "btn small", type: "button", text: "Open", onclick: safe(() => { ctx.state.view = "line"; ctx.goToDate(date); }) }),
          h("button", { class: "btn small ghost", type: "button", onclick: safe(() => { ctx.state.view = "print"; ctx.goToDate(date); }) }, icon("printer", 15), h("span", { text: "Print / Excel" }))))));
  }));

  return h("section", { class: "card" },
    h("div", { class: "card-head" },
      h("h2", { text: "Saved days" }),
      h("div", { class: "month-nav" },
        h("button", { class: "icon-btn", type: "button", "aria-label": "Previous month", onclick: safe(() => shiftMonth(-1)) }, icon("left")),
        h("span", { text: monthName }),
        h("button", { class: "icon-btn", type: "button", "aria-label": "Next month", disabled: month >= today.slice(0, 7), onclick: safe(() => shiftMonth(1)) }, icon("right")))),
    list);
}

function backupCard() {
  const last = prefGet("lastBackup", "");
  const info = h("p", { class: "muted", text: "Everything is kept on this tablet. Download a backup now and then (and before changing tablet) - it can be restored here or on a new tablet." });
  const lastEl = h("p", { class: last && Date.now() - Date.parse(last) < 8 * 864e5 ? "muted" : "warn-text", text: last ? "Last backup: " + C.prettyDate(C.isoDate(new Date(last))) + "." : "No backup downloaded yet on this tablet." });
  const withPhotos = h("input", { type: "checkbox", checked: true });
  const file = h("input", { type: "file", accept: ".json,application/json", hidden: true, onchange: safe(async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!f) return;
    try {
      const res = await ctx.store.restore(await f.text());
      const pics = await importPhotos(res.photos);
      await ctx.goToDate(day().date);
      toast("Restored " + res.days + " day" + (res.days === 1 ? "" : "s") + (pics ? " and " + pics + " photo" + (pics === 1 ? "" : "s") : "") + " from the backup.");
    } catch (err) {
      toast((err && err.message) || "Couldn't read that file.", "error");
    }
  }) });
  const download = safe(async () => {
    const data = await ctx.store.backupData(withPhotos.checked ? await exportPhotos() : []);
    downloadBlob(new Blob([JSON.stringify(data)], { type: "application/json" }), "line-check-backup-" + C.tradingDate() + ".json");
    prefSet("lastBackup", new Date().toISOString());
    toast("Backup downloaded (" + Object.keys(data.days).length + " days" + (data.photos.length ? ", " + data.photos.length + " photos" : "") + ").");
    ctx.render();
  });
  return h("section", { class: "card" },
    h("div", { class: "card-head" }, h("h2", { text: "Backup" })),
    info, lastEl,
    h("div", { class: "btn-row" },
      h("button", { class: "btn primary", type: "button", onclick: download }, icon("download", 18), h("span", { text: "Download backup" })),
      h("label", { class: "check-label" }, withPhotos, h("span", { text: "include photos" })),
      h("button", { class: "btn ghost", type: "button", onclick: () => file.click() }, icon("upload", 18), h("span", { text: "Restore backup" })),
      file));
}

function settingsCard() {
  const usage = h("p", { class: "muted", text: "Checking storage…" });
  const photosLine = h("p", { class: "muted" });
  Promise.all([storageUsage(), photoStats()]).then(safe(([u, p]) => {
    usage.textContent = u && u.quota ? "Storage used on this tablet: " + mb(u.usage || 0) + " of " + mb(u.quota) + " available." : "Storage use isn't reported by this browser.";
    usage.textContent += ctx.store.hasArchive() ? " History archive: on." : " History archive: not available on this browser (only the last weeks are kept).";
    if (p) {
      replace(photosLine, p.count ? p.count + " photo" + (p.count === 1 ? "" : "s") + " stored (" + mb(p.bytes) + ")" + (p.oldest ? ", oldest from " + C.prettyDate(p.oldest) : "") + ". " : "No photos stored. ",
        p.count ? h("button", { class: "btn small ghost", type: "button", text: "Delete photos older than 3 months", onclick: safe(async () => {
          if (!window.confirm("Delete photos from before " + C.prettyDate(C.addDays(C.tradingDate(), -92)) + " from this tablet? (Download a backup with photos first if you want to keep them.)")) return;
          const n = await deletePhotosBefore(C.addDays(C.tradingDate(), -92));
          toast(n + " photo" + (n === 1 ? "" : "s") + " deleted.");
          ctx.render();
        }) }) : null);
    }
  }));
  const keypad = h("label", { class: "switch" },
    h("input", { type: "checkbox", checked: keypadOn(), onchange: safe((e) => { setKeypad(e.target.checked); toast(e.target.checked ? "On-screen number pad on." : "Using the tablet's keyboard."); }) }),
    h("span", { class: "switch-ui", "aria-hidden": "true" }), h("span", { text: "On-screen number pad for temperatures" }));
  return h("section", { class: "card" },
    h("div", { class: "card-head" }, h("h2", { text: "Settings & storage" })),
    h("div", { class: "pad" }, keypad), usage, photosLine);
}
