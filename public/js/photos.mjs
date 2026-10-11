/*
 * Photos for line check items and temperature rows (switched on with the
 * Photos toggle). Taken with the tablet camera, shrunk to at most 1280 px
 * (about 150-250 KB each) and kept in IndexedDB. The day itself only holds a
 * small reference per photo: P:<id> -> { on: what it belongs to, at, w, h }.
 */
import { h, icon, replace } from "./dom.mjs";
import * as C from "./core.mjs";
import { openDb, wrap } from "./db.mjs";
import { day, save, toast, modal, safe } from "./ctx.mjs";

const MAX_SIDE = 1280;
const QUALITY = 0.72;
const urls = new Map(); // photo id -> object URL

async function io() {
  const db = await openDb();
  return db ? wrap(db) : null;
}

export async function photosAvailable() {
  return !!(await io());
}

/** Shrink a camera picture to a JPEG of at most MAX_SIDE pixels. */
async function shrink(file) {
  let source, w, h2;
  if (window.createImageBitmap) {
    try {
      source = await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      source = null;
    }
  }
  if (!source) {
    source = await new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That picture couldn't be read.")); };
      img.src = url;
    });
  }
  w = source.width; h2 = source.height;
  const scale = Math.min(1, MAX_SIDE / Math.max(w, h2));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h2 * scale));
  canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
  if (source.close) source.close();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", QUALITY));
  if (!blob) throw new Error("That picture couldn't be saved.");
  return { data: await blob.arrayBuffer(), type: "image/jpeg", w: canvas.width, h: canvas.height };
}

/** Ask for a photo (camera on a tablet) and attach it to `on`. Calls done() when saved. */
export function takePhoto(on, label, done) {
  const input = h("input", { type: "file", accept: "image/*", capture: "environment", hidden: true });
  input.addEventListener("change", safe(async () => {
    const file = input.files && input.files[0];
    input.remove();
    if (!file) return;
    const db = await io();
    if (!db) { toast("Photos can't be stored on this browser.", "error"); return; }
    try {
      const pic = await shrink(file);
      const id = C.newPhotoId();
      const at = new Date().toISOString();
      await db.put("photos", { id, date: day().date, on, at, label, type: pic.type, w: pic.w, h: pic.h, data: pic.data });
      save(C.photoKey(id), { on, at, w: pic.w, h: pic.h, label });
      toast("Photo added.");
      if (done) done();
    } catch (err) {
      toast((err && err.message) || "The photo couldn't be saved.", "error");
    }
  }));
  document.body.appendChild(input);
  input.click();
}

export async function photoUrl(id) {
  if (urls.has(id)) return urls.get(id);
  const db = await io();
  const rec = db ? await db.get("photos", id) : null;
  if (!rec) return null;
  const url = URL.createObjectURL(new Blob([rec.data], { type: rec.type || "image/jpeg" }));
  urls.set(id, url);
  return url;
}

/** Free the memory used by photo previews (when changing day). */
export function releasePhotoUrls() {
  for (const url of urls.values()) URL.revokeObjectURL(url);
  urls.clear();
}

/** The photos of the open day attached to `on`, oldest first. */
export function photosOn(on) {
  return C.photoRefs(day()).filter((p) => p.on === on).sort((a, b) => (a.at < b.at ? -1 : 1));
}

/** Thumbnails for `on` (updates itself via the returned refresh()). */
export function thumbStrip(on, label) {
  const el = h("div", { class: "thumbs" });
  const refresh = () => {
    const list = photosOn(on);
    replace(el, list.map((p) => {
      const img = h("img", { alt: "Photo " + C.timeOf(p.at), loading: "lazy" });
      photoUrl(p.id).then((u) => { if (u) img.src = u; else img.replaceWith(h("span", { class: "thumb-missing", text: "photo removed" })); });
      return h("button", { type: "button", class: "thumb", "aria-label": "Open photo taken " + C.timeOf(p.at), onclick: safe(() => viewPhoto(p, label, refresh)) }, img);
    }));
    el.hidden = !list.length;
  };
  refresh();
  return { el, refresh };
}

export function viewPhoto(p, label, onChange) {
  const img = h("img", { class: "photo-big", alt: label || "Photo" });
  photoUrl(p.id).then((u) => { if (u) img.src = u; });
  const dlg = modal(label || "Photo", [
    img,
    h("p", { class: "muted", text: "Taken " + C.prettyDate(day().date) + " at " + C.timeOf(p.at) }),
    h("div", { class: "btn-row" },
      h("button", { class: "btn danger", type: "button", onclick: safe(async () => {
        if (!window.confirm("Delete this photo?")) return;
        save(C.photoKey(p.id), null);
        const db = await io();
        if (db) await db.del("photos", p.id);
        const u = urls.get(p.id);
        if (u) { URL.revokeObjectURL(u); urls.delete(p.id); }
        dlg.close();
        toast("Photo deleted.");
        if (onChange) onChange();
      }) }, icon("trash", 16), h("span", { text: "Delete photo" })),
      h("button", { class: "btn", type: "button", text: "Close", onclick: () => dlg.close() })),
  ], { wide: true });
}

/** Camera button for a row (only shown with the Photos toggle on). */
export function cameraButton(on, label, after, disabled) {
  return h("button", {
    class: "cam", type: "button", "aria-label": "Add photo: " + label, title: "Add photo", disabled,
    onclick: safe(() => takePhoto(on, label, after)),
  }, icon("camera", 22));
}

/* ---------- For printing, backup and housekeeping ---------- */

/** All photos of a day with loaded URLs: [{ id, on, at, label, url }] */
export async function dayPhotos(record) {
  const refs = C.photoRefs(record).sort((a, b) => (a.at < b.at ? -1 : 1));
  const out = [];
  for (const p of refs) {
    const url = await photoUrl(p.id);
    if (url) out.push(Object.assign({}, p, { url }));
  }
  return out;
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(text) {
  const s = atob(text);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes.buffer;
}

export async function exportPhotos() {
  const db = await io();
  if (!db) return [];
  return (await db.getAll("photos")).map((p) => Object.assign({}, p, { data: toBase64(p.data) }));
}

/** Store photos from a backup (ones already on the tablet are skipped). Returns how many were added. */
export async function importPhotos(list) {
  const db = await io();
  if (!db || !Array.isArray(list)) return 0;
  let n = 0;
  for (const p of list) {
    if (!p || typeof p.id !== "string" || typeof p.data !== "string" || !C.isDate(p.date)) continue;
    if (await db.get("photos", p.id)) continue;
    await db.put("photos", Object.assign({}, p, { data: fromBase64(p.data) }));
    n++;
  }
  return n;
}

export async function photoStats() {
  const db = await io();
  if (!db) return null;
  const all = await db.getAll("photos");
  return { count: all.length, bytes: all.reduce((n, p) => n + (p.data ? p.data.byteLength : 0), 0), oldest: all.map((p) => p.date).sort()[0] || null };
}

/** Delete photos of days before `date` from the tablet. Returns how many. */
export async function deletePhotosBefore(date) {
  const db = await io();
  if (!db) return 0;
  const old = await db.byIndex("photos", "date", db.range("0000-00-00", C.addDays(date, -1)));
  for (const p of old) await db.del("photos", p.id);
  releasePhotoUrls();
  return old.length;
}

