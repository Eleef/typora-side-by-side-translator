import assert from "node:assert/strict";
import test from "node:test";
import type { WindowLike } from "dompurify";
import { JSDOM } from "jsdom";
import type { PluginLocalizer } from "../src/i18n/PluginLocalizer";
import { createTranslationHtmlSanitizer } from "../src/ui/TranslationHtmlSanitizer";
import { TranslationPaneController } from "../src/ui/TranslationPaneController";

test("translation HTML sanitizer removes executable markup and external resource elements", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  const sanitize = createTranslationHtmlSanitizer(dom.window as unknown as WindowLike);
  const clean = sanitize([
    '<p class="safe" onclick="alert(1)">Text <strong>kept</strong></p>',
    '<script>alert(1)</script>',
    '<a href="javascript:alert(1)" ping="https://tracker.example">unsafe</a>',
    '<iframe src="https://tracker.example"></iframe>',
    '<img src="https://tracker.example/pixel.png" onerror="alert(1)">',
    '<video src="https://tracker.example/video.mp4"></video>'
  ].join(""));

  assert.match(clean, /<p class="safe">Text <strong>kept<\/strong><\/p>/);
  assert.match(clean, /<a>unsafe<\/a>/);
  assert.doesNotMatch(clean, /script|onclick|javascript:|ping=|iframe|img|video|tracker\.example/i);
});

test("translation HTML sanitizer preserves safe Markdown links and table structure", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  const sanitize = createTranslationHtmlSanitizer(dom.window as unknown as WindowLike);
  const clean = sanitize('<table><thead><tr><th>Key</th></tr></thead><tbody><tr><td><a href="https://example.com">Value</a></td></tr></tbody></table>');

  assert.match(clean, /<table>/);
  assert.match(clean, /<th>Key<\/th>/);
  assert.match(clean, /href="https:\/\/example\.com"/);
});

test("translation pane restores the original editor DOM and supports keyboard resizing", () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main id="root"><div id="write"><p>Source</p></div><span id="after"></span></main></body></html>',
    { pretendToBeVisual: true }
  );
  const previousGlobals = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    Window: globalThis.Window
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Window: dom.window.Window
  });

  const paneText = {
    resizeHandle: "Resize",
    openToolbar: "Open toolbar",
    translateAll: "Translate",
    refreshStale: "Refresh",
    cancelTranslation: "Cancel",
    exportTarget: "Export",
    targetLanguage: "Target language",
    mountFailed: "Mount failed",
    initializeFailed: "Initialize failed",
    unsupportedFile: "Unsupported",
    noSavedMarkdown: "No file",
    markdownOnly: "Markdown only",
    noCachedTranslation: "No translation",
    cacheNotGenerated: "No cache",
    statusTranslating: "Translating",
    statusError: "Error",
    statusNotTranslated: "Not translated",
    statusStale: "Stale",
    statusCached: "Cached",
    translationRunning: "Running",
    staleDetail: "{cacheName} {count}",
    cachedDetail: "{cacheName}"
  };
  const localizer = {
    t: { pane: paneText },
    format: (template: string) => template,
    targetLanguageLabel: (language: string) => language,
    targetLanguageShortLabel: (language: string) => language
  } as unknown as PluginLocalizer;
  const widths: number[] = [];
  const controller = new TranslationPaneController(localizer);

  try {
    controller.ensureMounted({
      onTranslateAll: () => undefined,
      onRefreshStale: () => undefined,
      onCancelTranslation: () => undefined,
      onExportTarget: () => undefined,
      onTargetLanguageChange: () => undefined,
      onJumpToSource: () => undefined,
      onResize: (width) => widths.push(width)
    });
    controller.render({
      association: null,
      targetMarkdown: null,
      translatedBlocks: new Map(),
      blocks: [],
      isVisible: false,
      staleCount: 0,
      targetLang: "zh-CN",
      paneWidthPercent: 50,
      toolbarDisplayMode: "compact",
      isTranslating: false
    });
    const host = dom.window.document.querySelector<HTMLElement>(".typora-bilingual-host");
    const resizer = dom.window.document.querySelector<HTMLElement>(".typora-bilingual-resizer");
    assert.ok(host?.classList.contains("is-pane-hidden"));
    assert.equal(resizer?.getAttribute("role"), "separator");

    resizer?.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    assert.deepEqual(widths, [52]);
    assert.equal(resizer?.getAttribute("aria-valuenow"), "52");

    controller.destroy();
    const root = dom.window.document.querySelector("#root");
    assert.deepEqual(Array.from(root?.children ?? []).map((element) => element.id), ["write", "after"]);
    assert.equal(dom.window.document.querySelector(".typora-bilingual-host"), null);
  } finally {
    controller.destroy();
    Object.assign(globalThis, previousGlobals);
    dom.window.close();
  }
});
