import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeSig, simplify, sigPath, isSig, MAX_SIG_CHARS, SIG_W, SIG_H } from "../public/js/signature.mjs";
import { MAX_VALUE_CHARS, mergeFields, signKey } from "../public/js/core.mjs";

test("simplify keeps the ends and drops points that are too close", () => {
  assert.deepEqual(simplify([0, 0, 1, 1, 2, 2, 50, 50], 5), [0, 0, 50, 50]);
  assert.deepEqual(simplify([0, 0, 10, 0, 20, 0], 5), [0, 0, 10, 0, 20, 0]);
});

test("a very long scribble is simplified until it fits in a box", () => {
  const strokes = Array.from({ length: 60 }, (_, k) => Array.from({ length: 2000 }, (_, i) => (i % 2 ? (Math.sin(i / 7 + k) + 1) * 140 : (i * 0.5 + k * 3) % SIG_W)));
  const sig = encodeSig(strokes);
  assert.ok(isSig(sig));
  assert.ok(JSON.stringify(sig).length <= MAX_SIG_CHARS, JSON.stringify(sig).length + " chars");
  const value = { name: "Mary Kelly", i: "MK", at: new Date().toISOString(), sig };
  assert.ok(JSON.stringify(value).length <= MAX_VALUE_CHARS);
  assert.ok(mergeFields({}, { [signKey("am")]: { v: value, t: 1 } }).fields[signKey("am")]);
});

test("points are kept inside the signature box", () => {
  const sig = encodeSig([[-50, -50, 5000, 900, 30, 30]]);
  for (const s of sig.s) s.forEach((n, i) => assert.ok(n >= 0 && n <= (i % 2 ? SIG_H : SIG_W)));
});

test("empty pads give no signature; paths are drawable", () => {
  assert.equal(encodeSig([]), null);
  assert.equal(encodeSig([[5]]), null);
  assert.match(sigPath(encodeSig([[10, 10, 100, 100, 200, 50]])), /^M10 10Q/);
  assert.equal(isSig(null), false);
});
