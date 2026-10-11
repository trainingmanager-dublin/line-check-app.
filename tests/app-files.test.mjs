/*
 * The offline copy (service worker) must list every file the app needs, or
 * the tablet can't open the app without Wi-Fi.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../public/", import.meta.url).pathname;
const sw = readFileSync(join(root, "sw.js"), "utf8");
const shell = JSON.parse("[" + /const SHELL = \[([\s\S]*?)\];/.exec(sw)[1].replace(/,\s*$/, "") + "]");

function files(dir) {
  return readdirSync(join(root, dir)).flatMap((f) => {
    const rel = dir ? dir + "/" + f : f;
    return statSync(join(root, rel)).isDirectory() ? files(rel) : [rel];
  });
}

test("every file in the offline list exists", () => {
  for (const f of shell) if (f !== "./") assert.ok(existsSync(join(root, f)), f);
});

test("every script, style, image and template is in the offline list", () => {
  const needed = files("").filter((f) => /\.(mjs|js|css|png|svg|xlsx|webmanifest|html)$/.test(f) && f !== "sw.js");
  for (const f of needed) assert.ok(shell.includes(f), f + " is missing from SHELL in sw.js");
});

test("every module import points at a file that exists", () => {
  for (const f of files("js").filter((x) => x.endsWith(".mjs"))) {
    const src = readFileSync(join(root, f), "utf8");
    for (const m of src.matchAll(/from "(\.[^"]+)"/g)) {
      assert.ok(existsSync(join(root, "js", m[1])), f + " imports " + m[1]);
    }
  }
});
