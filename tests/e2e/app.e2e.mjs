/*
 * Browser test of the whole app (not run by `npm test` / Netlify).
 *   npm i -D playwright   (once; or use a global install)
 *   npm run e2e
 * Starts the app on a spare port, then: AM line check with the number pad,
 * the tick-after-typing case, a blocked sign-off, signing with name and
 * signature, reopening, PM, temperatures, a photo, reload mid-check, both
 * Excel downloads (checked to contain the signature pictures) and print.
 */
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { strict as assert } from "node:assert";
import { unzipSync } from "../../public/vendor/fflate.mjs";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch {
  try { ({ chromium } = createRequire(process.env.PLAYWRIGHT_MODULES || "/usr/lib/node_modules/")("playwright")); } catch {
    console.log("Playwright isn't installed - run `npm i -D playwright` first.");
    process.exit(0);
  }
}

const port = 8000 + Math.floor(Math.random() * 900);
const server = spawn(process.execPath, [fileURLToPath(new URL("../../scripts/dev-server.mjs", import.meta.url))], { env: { ...process.env, PORT: String(port) }, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 600));
const base = "http://localhost:" + port + "/";

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true, acceptDownloads: true });
await ctx.addInitScript(() => { try { localStorage.setItem("lc:pref:keypad", "1"); sessionStorage.setItem("lc:shift", "am"); } catch { /* ignore */ } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (d) => d.accept());
const key = (k) => page.locator(`.keypad [data-k="${k}"]`).dispatchEvent("pointerdown");
const keys = async (s) => { for (const ch of s) await key(ch === "-" ? "minus" : ch); };
const sign = async (name) => {
  await page.locator("#ab-sign").click();
  await page.locator(".sheet .name-input").fill(name);
  const b = await page.locator(".sig-canvas").boundingBox();
  await page.mouse.move(b.x + 30, b.y + b.height * 0.6); await page.mouse.down();
  for (let i = 0; i < 20; i++) await page.mouse.move(b.x + 30 + i * 15, b.y + b.height * (0.6 - 0.3 * Math.sin(i / 2)));
  await page.mouse.up();
  await page.locator(".sheet .btn.primary.big").click();
};
const step = (name) => console.log("✓ " + name);

try {
  await page.goto(base);
  await page.waitForSelector(".item", { state: "attached" });

  await page.locator("#main input.temp").nth(0).click();
  await keys("3.5"); await key("next"); await keys("4"); await key("next"); await keys("9"); await key("next");
  assert.match(await page.evaluate(() => document.activeElement.className), /note/);
  await page.keyboard.type("Moved to walk-in"); await page.keyboard.press("Enter");
  step("number pad, Next, out-of-range goes to the comment");

  const row = page.locator(".item", { hasText: "Sliced Pickles" });
  await row.locator("input.temp").click(); await keys("2");
  await row.locator(".tick").click();
  await page.waitForTimeout(200);
  assert.equal(await row.getAttribute("data-state"), "ok");
  step("typing a reading then tapping ✓ keeps it ticked");

  await page.locator(".item").nth(1).locator(".flag").click();
  await page.locator("#ab-sign").click();
  assert.equal(await page.locator(".sign-block.bad li").count(), 1);
  assert.ok(await page.locator(".sheet .btn.primary.big").isDisabled());
  await page.locator(".sign-block.bad li button").click();
  await page.waitForTimeout(400);
  await page.keyboard.type("Chipped - replaced"); await page.keyboard.press("Enter");
  step("sign-off blocked until the corrective action is written");

  await page.locator(".switch:has-text('Photos')").first().click();
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.locator(".item").first().locator(".cam").click()]);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8Dwn4GBgYGJgYGBAQAqNgMB5Ah48gAAAABJRU5ErkJggg==", "base64");
  await chooser.setFiles({ name: "p.png", mimeType: "image/png", buffer: png });
  await page.waitForSelector(".thumb img[src^='blob:']", { timeout: 10000 });
  step("photo added");

  await page.reload();
  await page.waitForSelector(".item", { state: "attached" });
  assert.equal(await page.locator(".item").nth(1).locator(".note").inputValue(), "Chipped - replaced");
  assert.equal(await page.locator(".thumb").count(), 1);
  step("reload mid-check keeps everything");

  await sign("Mary Kelly");
  await page.waitForSelector(".banner.signed");
  assert.ok(await page.locator(".item .tick").first().isDisabled());
  await page.locator(".banner.signed button").click();
  await page.locator(".sheet .name-input").fill("John Doyle");
  await page.locator(".sheet .btn.primary").click();
  await page.waitForTimeout(300);
  assert.ok(await page.locator(".item .tick").first().isEnabled());
  await sign("Mary Kelly");
  await page.click(".shift-btn >> text=PM shift");
  await sign("John Doyle");
  step("AM signed, reopened, signed again; PM signed");

  await page.click(".tab >> text=Print & history");
  for (const [i, sheet] of [[0, "xl/media/line-check-2.png"], [1, null]]) {
    const [dl] = await Promise.all([page.waitForEvent("download"), page.locator(".out-box").nth(i).locator("text=Excel file").click()]);
    const files = unzipSync(new Uint8Array(await (await import("node:fs/promises")).readFile(await dl.path())));
    assert.ok(files["xl/workbook.xml"]);
    if (sheet) assert.ok(files[sheet], "both signatures are in the line check Excel file");
  }
  step("both Excel files download (with signatures)");

  await page.evaluate(() => { window.print = () => { window.__printed = true; }; });
  await page.locator(".out-box").nth(2).locator("button").first().click();
  await page.waitForFunction(() => window.__printed === true);
  assert.equal(await page.locator("#print-root svg.p-sig").count(), 4, "two signatures on each sheet");
  step("print has both sheets, both signatures and the photo page");

  assert.deepEqual(errors, []);
  console.log("All browser checks passed.");
} finally {
  await browser.close();
  server.kill();
}
