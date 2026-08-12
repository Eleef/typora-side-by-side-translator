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
    moreActions: "More",
    translateAll: "Translate",
    translateTo: "Translate to {language}",
    refreshStale: "Refresh",
    updateChanges: "Update {count}",
    retry: "Retry",
    cancelTranslation: "Cancel",
    exportTarget: "Export",
    retranslateAll: "Retranslate all",
    layout: "Layout",
    sourceWider: "Source wider",
    equalWidth: "Equal width",
    translationWider: "Translation wider",
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

test("translation pane exposes one state-driven primary action without duplicate retranslation", () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><div id="write"><h1>Source</h1><p>Paragraph</p></div></main></body></html>',
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
    moreActions: "More",
    translateAll: "Translate",
    translateTo: "Translate to {language}",
    refreshStale: "Refresh",
    updateChanges: "Update {count}",
    retry: "Retry",
    cancelTranslation: "Cancel",
    exportTarget: "Export",
    retranslateAll: "Retranslate all",
    layout: "Layout",
    sourceWider: "Source wider",
    equalWidth: "Equal width",
    translationWider: "Translation wider",
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
    format: (template: string, values: Record<string, string | number> = {}) =>
      template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? "")),
    targetLanguageLabel: (language: string) => language,
    targetLanguageShortLabel: () => "ZH"
  } as unknown as PluginLocalizer;
  const invoked = { full: 0, stale: 0, cancel: 0, export: 0 };
  const widths: number[] = [];
  const controller = new TranslationPaneController(localizer);
  const association = {
    sourcePath: "/source/article.md",
    cacheTargetPath: "/cache/article.zh.md",
    cacheMapPath: "/cache/article.zh.map.json",
    exportTargetPath: "/source/article.zh.md",
    targetLang: "zh-CN" as const,
    isSupportedSource: true
  };
  const baseState = {
    association,
    targetMarkdown: null,
    translatedBlocks: new Map<string, string>(),
    blocks: [],
    isVisible: true,
    staleCount: 0,
    targetLang: "zh-CN" as const,
    paneWidthPercent: 50,
    toolbarDisplayMode: "compact" as const,
    isTranslating: false
  };

  try {
    controller.ensureMounted({
      onTranslateAll: () => invoked.full++,
      onRefreshStale: () => invoked.stale++,
      onCancelTranslation: () => invoked.cancel++,
      onExportTarget: () => invoked.export++,
      onTargetLanguageChange: () => undefined,
      onJumpToSource: () => undefined,
      onResize: (width) => widths.push(width)
    });

    const primary = () => dom.window.document.querySelector<HTMLButtonElement>('[data-action="primary"]');
    controller.render(baseState);
    assert.equal(primary()?.textContent, "Translate to ZH");
    primary()?.click();
    assert.equal(invoked.full, 1);

    controller.render({ ...baseState, targetMarkdown: "Translated", staleCount: 3 });
    assert.equal(primary()?.textContent, "Update 3");
    assert.equal(
      dom.window.document.querySelector<HTMLButtonElement>('[data-action="translate-all"]')?.classList.contains("is-hidden"),
      false
    );
    primary()?.click();
    assert.equal(invoked.stale, 1);

    controller.render({ ...baseState, targetMarkdown: "Translated" });
    assert.equal(primary()?.textContent, "Retranslate all");
    assert.equal(primary()?.classList.contains("is-hidden"), false);
    assert.ok(dom.window.document.querySelector<HTMLButtonElement>('[data-action="translate-all"]')?.classList.contains("is-hidden"));
    const toolbar = dom.window.document.querySelector<HTMLElement>(".typora-bilingual-pane__toolbar");
    const compactToggle = dom.window.document.querySelector<HTMLButtonElement>('[data-action="toggle-toolbar"]');
    assert.equal(toolbar?.classList.contains("is-hidden"), false);
    assert.ok(compactToggle?.classList.contains("is-hidden"));
    controller.render({ ...baseState, targetMarkdown: "Translated", isTranslating: true });
    assert.equal(primary()?.textContent, "Cancel");
    assert.equal(toolbar?.classList.contains("is-hidden"), false);
    primary()?.click();
    assert.equal(invoked.cancel, 1);

    controller.render({ ...baseState, targetMarkdown: "Translated", retryMode: "stale", errorMessage: "Failed" });
    assert.equal(primary()?.textContent, "Retry");
    primary()?.click();
    assert.equal(invoked.stale, 2);

    controller.render({ ...baseState, targetMarkdown: "Translated" });
    const more = dom.window.document.querySelector<HTMLButtonElement>('[data-action="toggle-more"]');
    const menu = dom.window.document.querySelector<HTMLElement>(".typora-bilingual-pane__menu");
    more?.click();
    assert.equal(more?.getAttribute("aria-expanded"), "true");
    assert.equal(menu?.classList.contains("is-hidden"), false);
    dom.window.document.querySelector<HTMLButtonElement>('[data-action="export-target"]')?.click();
    assert.equal(invoked.export, 1);

    more?.click();
    dom.window.document.querySelector<HTMLButtonElement>('[data-preset="60"]')?.click();
    assert.deepEqual(widths, [60]);
  } finally {
    controller.destroy();
    Object.assign(globalThis, previousGlobals);
    dom.window.close();
  }
});

test("collapsed translation bubble opens a vertical menu on hover and exposes horizontal cascades", async () => {
  const dom = new JSDOM('<!doctype html><html><body><main><div id="write"><p>Source</p></div></main></body></html>', {
    pretendToBeVisual: true
  });
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
    resizeHandle: "Resize", openToolbar: "Open", moreActions: "More", translateAll: "Translate",
    translateTo: "Translate to {language}", refreshStale: "Refresh", updateChanges: "Update {count}", retry: "Retry",
    cancelTranslation: "Cancel", exportTarget: "Export", retranslateAll: "Retranslate", layout: "Layout",
    sourceWider: "Source wider", equalWidth: "Equal", translationWider: "Translation wider", targetLanguage: "Language",
    mountFailed: "Mount failed", initializeFailed: "Init failed", unsupportedFile: "Unsupported", noSavedMarkdown: "No file",
    markdownOnly: "Markdown only", noCachedTranslation: "None", cacheNotGenerated: "None", statusTranslating: "Running",
    statusError: "Error", statusNotTranslated: "New", statusStale: "Stale", statusCached: "Cached",
    translationRunning: "Running", staleDetail: "Stale", cachedDetail: "Cached"
  };
  const localizer = {
    t: { pane: paneText }, format: (value: string) => value,
    targetLanguageLabel: (language: string) => language, targetLanguageShortLabel: () => "ZH"
  } as unknown as PluginLocalizer;
  const controller = new TranslationPaneController(localizer);
  try {
    controller.ensureMounted({
      onTranslateAll: () => undefined, onRefreshStale: () => undefined, onCancelTranslation: () => undefined,
      onExportTarget: () => undefined, onTargetLanguageChange: () => undefined, onJumpToSource: () => undefined,
      onResize: () => undefined
    });
    controller.render({
      association: null, targetMarkdown: null, translatedBlocks: new Map(), blocks: [], isVisible: true, staleCount: 0,
      targetLang: "zh-CN", paneWidthPercent: 50, toolbarDisplayMode: "collapsed", isTranslating: false
    });
    const overlay = dom.window.document.querySelector<HTMLElement>(".typora-bilingual-pane__overlay");
    const toggle = dom.window.document.querySelector<HTMLButtonElement>('[data-action="toggle-toolbar"]');
    const toolbar = dom.window.document.querySelector<HTMLElement>(".typora-bilingual-pane__toolbar");
    toggle?.dispatchEvent(new dom.window.MouseEvent("mouseenter", { bubbles: true }));
    assert.equal(toolbar?.classList.contains("is-hidden"), false);
    assert.equal(dom.window.document.querySelector<HTMLElement>(".typora-bilingual-pane__menu")?.classList.contains("is-hidden"), false);
    assert.equal(dom.window.document.querySelectorAll(".typora-bilingual-pane__language-cascade [data-target-language]").length, 5);
    assert.equal(dom.window.document.querySelectorAll(".typora-bilingual-pane__layout-cascade [data-preset]").length, 3);
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.ok(toolbar?.classList.contains("is-hidden"));
    toggle?.dispatchEvent(new dom.window.MouseEvent("mouseenter", { bubbles: true }));
    dom.window.document.body.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true }));
    assert.ok(toolbar?.classList.contains("is-hidden"));
    toggle?.dispatchEvent(new dom.window.MouseEvent("mouseenter", { bubbles: true }));
    toolbar?.dispatchEvent(new dom.window.MouseEvent("mouseleave", { bubbles: true }));
    assert.equal(toolbar?.classList.contains("is-hidden"), false);
    await new Promise((resolve) => dom.window.setTimeout(resolve, 230));
    assert.ok(toolbar?.classList.contains("is-hidden"));
    assert.equal(toggle?.classList.contains("is-hidden"), false);
  } finally {
    controller.destroy();
    Object.assign(globalThis, previousGlobals);
    dom.window.close();
  }
});
