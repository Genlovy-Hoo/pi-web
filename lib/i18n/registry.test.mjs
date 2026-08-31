import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  getLocalePlugin,
  getSupportedLocales,
  registerLocale,
  resolveBrowserLocale,
} = await jiti.import("./registry.ts");

test("uses the first supported browser language and falls back to English", () => {
  assert.equal(resolveBrowserLocale(["zh-CN", "en-US"]), "zh-CN");
  assert.equal(resolveBrowserLocale(["zh", "en-US"]), "zh-CN");
  assert.equal(resolveBrowserLocale(["zh-Hans", "zh-TW"]), "zh-CN");
  assert.equal(resolveBrowserLocale(["zh-Hans-HK", "en-US"]), "zh-CN");
  assert.equal(resolveBrowserLocale(["zh-SG", "en-US"]), "zh-CN");
  assert.equal(resolveBrowserLocale(["zh-TW", "en-US"]), "zh-TW");
  assert.equal(resolveBrowserLocale(["ZH-tW", "en-US"]), "zh-TW");
  assert.equal(resolveBrowserLocale(["zh-Hant", "en-US"]), "zh-TW");
  assert.equal(resolveBrowserLocale(["zh-Hant-HK", "en-US"]), "zh-TW");
  assert.equal(resolveBrowserLocale(["zh-HK", "en-US"]), "zh-TW");
  assert.equal(resolveBrowserLocale(["zh-MO", "en-US"]), "zh-TW");
  assert.equal(resolveBrowserLocale(["en-US", "zh-CN"]), "en");
  assert.equal(resolveBrowserLocale(["fr-FR", "zh-CN"]), "zh-CN");
  assert.equal(resolveBrowserLocale(["fr-FR"]), "en");
  assert.equal(resolveBrowserLocale([]), "en");
});

test("returns only registered locales", () => {
  assert.deepEqual(getSupportedLocales(), ["en", "zh-CN", "zh-TW"]);
  assert.equal(getLocalePlugin("en").id, "en");
  assert.equal(getLocalePlugin("zh-TW")?.label, "繁體中文");
  assert.equal(getLocalePlugin("zh-TW")?.messages["common.language"], "語言");
  assert.equal(getLocalePlugin("missing"), undefined);
});

test("allows a new locale plugin and rejects duplicate ids", () => {
  registerLocale({ id: "test", label: "Test", messages: { "common.ok": "OK" } });
  assert.equal(getLocalePlugin("test")?.label, "Test");
  assert.throws(() => registerLocale({ id: "test", label: "Again", messages: {} }));
});
