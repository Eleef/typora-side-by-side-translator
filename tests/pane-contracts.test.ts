import assert from "node:assert/strict";
import test from "node:test";
import type { WindowLike } from "dompurify";
import { JSDOM } from "jsdom";
import type { PluginLocalizer } from "../src/i18n/PluginLocalizer";
import en from "../src/i18n/locales/lang.en.json";
import { BlockExtractionService } from "../src/markdown/BlockExtractionService";
import { BlockAlignment, blockTextKey } from "../src/sync/BlockAlignment";
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

test("translation pane shows translated YAML as a metadata block and renders the body normally", async () => {
  const metadata = 'description: "<img src=example.png>"\ntags:\n  - notes';
  const frontmatter = `---\n${metadata}\n---`;
  const blocks = await new BlockExtractionService().extract(`${frontmatter}\n\n# Original`);
  const dom = new JSDOM('<main><div id="write"><pre class="md-meta-block"></pre><h1>Original</h1></div></main>', {
    pretendToBeVisual: true
  });
  const previousGlobals = { window: globalThis.window, document: globalThis.document, Window: globalThis.Window };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Window: dom.window.Window });
  const controller = new TranslationPaneController({
    t: en, format: (value: string) => value,
    targetLanguageLabel: (value: string) => value, targetLanguageShortLabel: (value: string) => value
  } as unknown as PluginLocalizer);

  try {
    const noAction = () => undefined;
    controller.ensureMounted({
      onTranslateAll: noAction, onRefreshStale: noAction, onCancelTranslation: noAction, onExportTarget: noAction,
      onTargetLanguageChange: noAction, onJumpToSource: noAction, onResize: noAction
    });
    controller.render({
      association: {
        sourcePath: "/source/article.md", cacheTargetPath: "/cache/article.zh.md",
        cacheMapPath: "/cache/article.zh.map.json", exportTargetPath: "/source/article.zh.md",
        targetLang: "zh-CN", isSupportedSource: true
      },
      targetMarkdown: "Cached document",
      translatedBlocks: new Map([[blocks[0].id, frontmatter.replace("example.png", "translated.png")], [blocks[1].id, "# Translated"]]),
      blocks, isVisible: true, staleCount: 0, targetLang: "zh-CN",
      paneWidthPercent: 50, toolbarDisplayMode: "compact", isTranslating: false
    });
    const pane = dom.window.document.querySelector(".typora-bilingual-pane__body");
    assert.equal(pane?.querySelector('[data-type="frontmatter"] > pre.md-meta-block')?.textContent, metadata.replace("example.png", "translated.png"));
    assert.equal(pane?.querySelector("h1")?.textContent, "Translated");
    assert.equal(pane?.querySelector("hr, img"), null);
  } finally {
    controller.destroy();
    Object.assign(globalThis, previousGlobals);
    dom.window.close();
  }
});

test("alignment pairs top-level blocks across an unmatched insertion and restores native margins", () => {
  const dom = new JSDOM([
    '<div id="write"><pre class="md-meta-block">description: note</pre>',
    '<ul><li><p>Nested</p></li></ul><p>Unsaved insertion</p>',
    '<p style="margin-top: 6px">Body<span class="md-meta">**</span></p>',
    '<figure class="md-table-fig"><table><tr><td>Table</td></tr></table></figure>',
    '<h2>Next</h2></div>',
    '<div id="translated"><section><pre>YAML</pre></section><section><ul><li>List</li></ul></section>',
    '<section><p>Paragraph</p></section><section><table><tr><td>Translated table</td></tr></table></section>',
    '<section><h2>Heading</h2></section></div>'
  ].join(""));
  const source = dom.window.document.querySelector<HTMLElement>("#write")!;
  const target = dom.window.document.querySelector<HTMLElement>("#translated")!;
  const sourceBlocks = Array.from(source.children) as HTMLElement[];
  const targetBlocks = Array.from(target.children) as HTMLElement[];
  const visibleRect = (top: number) => ({ top } as DOMRect);
  const mockLayout = (root: HTMLElement, children: HTMLElement[], tops: number[]) => {
    root.getClientRects = () => [visibleRect(0)] as unknown as DOMRectList;
    children.forEach((element, index) => {
      const baseMargins = children.map((child) => Number.parseFloat(child.style.marginTop) || 0);
      const rect = () => visibleRect(tops[index] + children.slice(0, index + 1).reduce(
        (offset, child, childIndex) => offset + (Number.parseFloat(child.style.marginTop) || 0) - baseMargins[childIndex], 0
      ));
      element.getClientRects = () => [rect()] as unknown as DOMRectList;
      element.getBoundingClientRect = rect;
      if (element.firstElementChild) {
        element.firstElementChild.getClientRects = element.getClientRects;
        element.firstElementChild.getBoundingClientRect = rect;
      }
    });
  };
  mockLayout(source, sourceBlocks, [30, 60, 90, 130, 180, 250]);
  mockLayout(target, targetBlocks, [54, 120, 150, 170, 270]);
  assert.equal(blockTextKey(sourceBlocks[3]), "Body");
  const targets = [
    { id: "metadata", type: "frontmatter", key: "description:note", element: targetBlocks[0] },
    { id: "list", type: "list", key: "Nested", element: targetBlocks[1] },
    { id: "body", type: "paragraph", key: "Body", element: targetBlocks[2] },
    { id: "table", type: "table", key: "Table", element: targetBlocks[3] },
    { id: "heading", type: "heading", key: "Next", element: targetBlocks[4] }
  ] as const;
  const alignment = new BlockAlignment();

  try {
    for (const attempt of [1, 2]) {
      const pairs = alignment.align(source, targets);
      assert.deepEqual(Array.from(pairs.values()), [sourceBlocks[0], sourceBlocks[1], sourceBlocks[3], sourceBlocks[4], sourceBlocks[5]]);
      targets.forEach(({ id, element }) => {
        assert.equal(pairs.get(id)?.getBoundingClientRect().top, element.getBoundingClientRect().top, `pass ${attempt}, ${id}`);
      });
    }
    assert.ok(sourceBlocks.some((element) => element.style.getPropertyPriority("margin-top") === "important"));
    assert.ok(targetBlocks.some((element) => element.style.getPropertyPriority("margin-top") === "important"));
    alignment.clear();
    assert.equal(sourceBlocks[3].style.marginTop, "6px");
    assert.ok(targetBlocks.every((element) => element.style.marginTop === ""));
    assert.deepEqual(Array.from(source.children), sourceBlocks);
    assert.equal(source.className, "");
  } finally {
    alignment.clear();
    dom.window.close();
  }
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

test("translation pane exposes one state-driven primary action without duplicate retranslation", async () => {
  const editedBlocks = await new BlockExtractionService().extract("First.\n\nInserted.\n\nLast.");
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
    t: { pane: { ...paneText, statusStaleCount: "To update: {count}" }, errors: { cacheStaleExport: "Refresh before exporting" } },
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
    const statusBadge = dom.window.document.querySelector<HTMLElement>(".typora-bilingual-pane__status-badge");
    const compactToggle = dom.window.document.querySelector<HTMLButtonElement>('[data-action="toggle-toolbar"]');
    controller.render({ ...baseState, staleCount: 3 });
    assert.equal(primary()?.textContent, "Translate to ZH");
    assert.equal(statusBadge?.textContent, "Not translated");
    const bubbleCount = compactToggle?.querySelector<HTMLElement>(".typora-bilingual-pane__bubble-count");
    assert.equal(bubbleCount?.textContent, "");
    primary()?.click();
    assert.equal(invoked.full, 1);

    controller.render({ ...baseState, targetMarkdown: "Translated", staleCount: 5, blocks: editedBlocks,
      translatedBlocks: new Map([[editedBlocks[0].id, "First translation"], [editedBlocks[2].id, "Last translation"]]) });
    assert.equal(primary()?.textContent, "Refresh");
    assert.equal(bubbleCount?.textContent, "1");

    controller.render({ ...baseState, targetMarkdown: "Translated", staleCount: 3, blocks: editedBlocks });
    assert.equal(primary()?.textContent, "Update 3");
    assert.equal(statusBadge?.textContent, "To update: 3");
    assert.equal(bubbleCount?.textContent, "3");
    assert.match(compactToggle?.getAttribute("aria-label") ?? "", /To update: 3/);
    const exportButton = dom.window.document.querySelector<HTMLButtonElement>('[data-action="export-target"]');
    assert.equal(exportButton?.disabled, true);
    exportButton?.click();
    assert.equal(invoked.export, 0);
    assert.equal(
      dom.window.document.querySelector<HTMLButtonElement>('[data-action="translate-all"]')?.classList.contains("is-hidden"),
      false
    );
    primary()?.click();
    assert.equal(invoked.stale, 1);

    controller.render({ ...baseState, targetMarkdown: "Translated" });
    assert.ok(primary()?.classList.contains("is-hidden"));
    const retranslate = dom.window.document.querySelector<HTMLButtonElement>('[data-action="translate-all"]');
    assert.equal(retranslate?.textContent, "Retranslate all");
    assert.equal(retranslate?.classList.contains("is-hidden"), false);
    const toolbar = dom.window.document.querySelector<HTMLElement>(".typora-bilingual-pane__flyout");
    assert.equal(toolbar?.classList.contains("is-hidden"), false);
    assert.ok(compactToggle?.classList.contains("is-hidden"));
    assert.equal(bubbleCount?.textContent, "");
    controller.render({ ...baseState, targetMarkdown: "Translated", isTranslating: true, staleCount: 3 });
    assert.equal(primary()?.textContent, "Cancel");
    assert.equal(statusBadge?.dataset.kind, "translating");
    assert.equal(bubbleCount?.textContent, "");
    assert.match(compactToggle?.getAttribute("aria-label") ?? "", /Translating/);
    assert.equal(toolbar?.classList.contains("is-hidden"), false);
    primary()?.click();
    assert.equal(invoked.cancel, 1);

    controller.render({ ...baseState, targetMarkdown: "Translated", retryMode: "stale", errorMessage: "Failed" });
    assert.equal(primary()?.textContent, "Retry");
    assert.equal(bubbleCount?.textContent, "");
    assert.match(compactToggle?.getAttribute("aria-label") ?? "", /Retry · .*Error/);
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
    assert.equal(invoked.full, 1);
    more?.click();
    retranslate?.click();
    assert.equal(invoked.full, 2);
  } finally {
    controller.destroy();
    Object.assign(globalThis, previousGlobals);
    dom.window.close();
  }
});

test("hovering the collapsed bubble reveals its primary action without starting translation", async () => {
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
    statusStaleCount: "Stale: {count}", translationRunning: "Running", staleDetail: "Stale", cachedDetail: "Cached"
  };
  const localizer = {
    t: { pane: paneText, errors: { cacheStaleExport: "Cache stale" } },
    format: (value: string, replacements: Record<string, unknown>) =>
      value.replace(/\{(\w+)\}/g, (_, key: string) => String(replacements[key])),
    targetLanguageLabel: (language: string) => language, targetLanguageShortLabel: () => "ZH"
  } as unknown as PluginLocalizer;
  const controller = new TranslationPaneController(localizer);
  const invoked = { full: 0, stale: 0, cancel: 0 };
  try {
    controller.ensureMounted({
      onTranslateAll: () => invoked.full++, onRefreshStale: () => invoked.stale++, onCancelTranslation: () => invoked.cancel++,
      onExportTarget: () => undefined, onTargetLanguageChange: () => undefined, onJumpToSource: () => undefined,
      onResize: () => undefined
    });
    const blocks = await new BlockExtractionService().extract("New paragraph");
    const baseState = {
      association: {
        sourcePath: "/source/article.md", cacheTargetPath: "/cache/article.zh.md",
        cacheMapPath: "/cache/article.zh.map.json", exportTargetPath: "/source/article.zh.md",
        targetLang: "zh-CN" as const, isSupportedSource: true
      },
      targetMarkdown: "Cached", translatedBlocks: new Map<string, string>(), blocks, isVisible: true, staleCount: 1,
      targetLang: "zh-CN" as const, paneWidthPercent: 50, toolbarDisplayMode: "collapsed" as const, isTranslating: false
    };
    controller.render(baseState);
    const toggle = dom.window.document.querySelector<HTMLButtonElement>('[data-action="toggle-toolbar"]');
    const bubbleCount = toggle?.querySelector<HTMLElement>(".typora-bilingual-pane__bubble-count");
    const bubbleAction = toggle?.querySelector<HTMLElement>(".typora-bilingual-pane__bubble-action");
    const toolbar = dom.window.document.querySelector<HTMLElement>(".typora-bilingual-pane__flyout");
    const language = toolbar?.querySelector<HTMLSelectElement>('[data-action="target-language"]');
    const more = toolbar?.querySelector<HTMLButtonElement>('[data-action="toggle-more"]');
    const menu = dom.window.document.querySelector<HTMLElement>(".typora-bilingual-pane__menu");
    const hover = () => toggle?.dispatchEvent(Object.assign(new dom.window.Event("pointerenter"), { pointerType: "mouse" }));
    assert.equal(toggle?.getAttribute("aria-expanded"), "false");
    assert.ok(toolbar?.classList.contains("is-hidden"));
    assert.equal(bubbleCount?.textContent, "1");
    assert.equal(bubbleCount?.hidden, false);
    assert.equal(bubbleAction?.hidden, true);
    hover();
    assert.equal(toggle?.getAttribute("aria-expanded"), "true");
    assert.equal(toolbar?.classList.contains("is-hidden"), false);
    assert.equal(bubbleCount?.hidden, true);
    assert.equal(bubbleAction?.hidden, false);
    assert.equal(bubbleAction?.textContent, "Update 1");
    assert.deepEqual(invoked, { full: 0, stale: 0, cancel: 0 });
    toggle?.click();
    assert.deepEqual(invoked, { full: 0, stale: 1, cancel: 0 });
    assert.ok(menu?.classList.contains("is-hidden"));
    assert.equal(language?.options.length, 5);
    more?.click();
    assert.equal(menu?.querySelectorAll("[data-preset]").length, 3);
    more?.focus();
    more?.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.ok(toolbar?.classList.contains("is-hidden"));
    assert.ok(menu?.classList.contains("is-hidden"));
    assert.equal(dom.window.document.activeElement, toggle);
    hover();
    dom.window.document.body.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true }));
    assert.ok(toolbar?.classList.contains("is-hidden"));
    assert.equal(bubbleCount?.hidden, false);
    controller.render({ ...baseState, isTranslating: true });
    hover();
    assert.equal(bubbleAction?.textContent, "Cancel");
    toggle?.click();
    controller.render({ ...baseState, staleCount: 0 });
    assert.equal(bubbleCount?.hidden, true);
    toggle?.click();
    assert.ok(toolbar?.classList.contains("is-hidden"));
    assert.deepEqual(invoked, { full: 0, stale: 1, cancel: 1 });
  } finally {
    controller.destroy();
    Object.assign(globalThis, previousGlobals);
    dom.window.close();
  }
});
