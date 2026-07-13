import assert from "node:assert/strict";
import test from "node:test";
import { normalizeStatus } from "./core.js";

test("normalizes status", () => {
  assert.equal(normalizeStatus(" Ready "), "ready");
});
