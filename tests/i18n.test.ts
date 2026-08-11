import assert from "node:assert/strict";
import test from "node:test";
import en from "../src/i18n/locales/lang.en.json";
import ja from "../src/i18n/locales/lang.ja.json";
import ko from "../src/i18n/locales/lang.ko.json";
import zhCn from "../src/i18n/locales/lang.zh-cn.json";
import zhTw from "../src/i18n/locales/lang.zh-tw.json";
import { formatMessage, normalizeUiLanguage, resolveUiLocale, UI_LANGUAGES } from "../src/i18n/UiLanguage";

function leafKeys(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [prefix];
  }
  return Object.entries(value)
    .flatMap(([key, child]) => leafKeys(child, prefix ? `${prefix}.${key}` : key))
    .sort();
}

test("UI language preferences use a fixed allowlist and safe fallback", () => {
  assert.deepEqual(UI_LANGUAGES, ["auto", "en", "zh-CN", "zh-TW", "ja", "ko"]);
  for (const language of UI_LANGUAGES) {
    assert.equal(normalizeUiLanguage(language), language);
  }
  assert.equal(normalizeUiLanguage("fr"), "auto");
  assert.equal(normalizeUiLanguage(undefined), "auto");
});

test("all locale resources contain the same message keys", () => {
  const expected = leafKeys(en);
  for (const [locale, resource] of Object.entries({ ja, ko, "zh-CN": zhCn, "zh-TW": zhTw })) {
    assert.deepEqual(leafKeys(resource), expected, `${locale} locale keys differ from English`);
  }
});

test("Typora locale aliases resolve to supported interface resources", () => {
  assert.equal(resolveUiLocale("zh-Hant"), "zh-TW");
  assert.equal(resolveUiLocale("zh_HK"), "zh-TW");
  assert.equal(resolveUiLocale("zh-SG"), "zh-CN");
  assert.equal(resolveUiLocale("ja-JP"), "ja");
  assert.equal(resolveUiLocale("ko-KR"), "ko");
  assert.equal(resolveUiLocale("en-US"), "en");
  assert.equal(resolveUiLocale("fr-FR"), "en");
});

test("localized message formatting replaces known placeholders and preserves unknown ones", () => {
  assert.equal(formatMessage("Saved {count} file(s) to {path}", { count: 2, path: "cache" }), "Saved 2 file(s) to cache");
  assert.equal(formatMessage("Missing {unknown}", { count: 1 }), "Missing {unknown}");
});
