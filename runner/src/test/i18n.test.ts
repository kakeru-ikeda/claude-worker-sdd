import assert from "node:assert/strict";
import test from "node:test";
import { readyGateError } from "../doctor.js";
import { MESSAGES, resolveLang, t } from "../i18n.js";

test("English and Japanese catalogs expose the same keys", () => {
  assert.deepEqual(Object.keys(MESSAGES.en).sort(), Object.keys(MESSAGES.ja).sort());
});

test("resolveLang selects Japanese only for the exact ja value", () => {
  assert.equal(resolveLang("ja"), "ja");
  assert.equal(resolveLang("en"), "en");
  assert.equal(resolveLang(true), "en");
  assert.equal(resolveLang(undefined), "en");
  assert.equal(resolveLang("fr"), "en");
});

test("t interpolates supplied parameters and preserves unknown placeholders", () => {
  assert.equal(
    t("en", "setup_model_catalog", { source: "cache" }),
    "Model catalog: cache ({count} models)",
  );
});

test("readyGateError retains its exact English default", () => {
  assert.equal(readyGateError(), "Not ready. Run `sdd-worker setup` first.");
});
