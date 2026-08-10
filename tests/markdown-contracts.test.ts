import assert from "node:assert/strict";
import test from "node:test";
import { BlockExtractionService } from "../src/markdown/BlockExtractionService";
import { TranslationMarkdownCodec } from "../src/translation/TranslationMarkdownCodec";
import { MarkdownStructureProtector } from "../src/translation/MarkdownStructureProtector";

const STRUCTURED_MARKDOWN = [
  "# Title",
  "",
  "Intro with [Docs](https://example.com/guide?q=1).",
  "",
  "- First item",
  "- Second item",
  "",
  "> Quoted text.",
  "",
  "| Name | Description |",
  "| --- | --- |",
  "| Plugin | Side by side |",
  "",
  "```ts",
  "const answer = 42;",
  "```",
  "",
  "$$",
  "E = mc^2",
  "$$",
  "",
  '<div class="note">Keep this HTML.</div>',
  "",
  "---",
  "",
  "Reference [Guide][guide].",
  "",
  '[guide]: https://example.com/reference "Reference title"'
].join("\n");

test("block extraction recognizes supported Markdown structures", async () => {
  const extractor = new BlockExtractionService();
  const blocks = await extractor.extract(STRUCTURED_MARKDOWN);
  const repeated = await extractor.extract(STRUCTURED_MARKDOWN);

  assert.deepEqual(
    blocks.map((block) => block.type),
    ["heading", "paragraph", "list", "blockquote", "table", "code", "math", "html", "passthrough", "paragraph", "passthrough"]
  );
  assert.deepEqual(
    blocks.map((block) => block.translatable),
    [true, true, true, true, true, false, false, false, false, true, false]
  );
  assert.ok(blocks.every((block) => JSON.stringify(block.headingPath) === JSON.stringify(["Title"])));
  assert.deepEqual(
    blocks.map((block) => block.id),
    repeated.map((block) => block.id)
  );
  assert.match(blocks.find((block) => block.type === "paragraph")?.sourceMarkdown ?? "", /https:\/\/example\.com\/guide\?q=1/);
  assert.match(blocks.find((block) => block.type === "table")?.sourceMarkdown ?? "", /\| Plugin\s+\| Side by side\s+\|/);
  assert.match(blocks.find((block) => block.type === "math")?.sourceMarkdown ?? "", /E = mc\^2/);
});

test("cache codec round-trips new and legacy control blocks", async () => {
  const blocks = await new BlockExtractionService().extract(STRUCTURED_MARKDOWN);
  const codec = new TranslationMarkdownCodec();
  const translations = new Map(blocks.map((block) => [block.id, block.sourceMarkdown]));
  const cache = codec.buildCache(blocks, translations);

  assert.equal((cache.match(/typora-side-by-side:block-start/g) ?? []).length, blocks.length);
  assert.deepEqual([...codec.parseCache(cache)], [...translations]);

  const legacyCache = cache.split("typora-side-by-side").join("typora-bilingual");
  assert.deepEqual([...codec.parseCache(legacyCache)], [...translations]);
});

test("export codec removes controls and preserves protected structures", async () => {
  const blocks = await new BlockExtractionService().extract(STRUCTURED_MARKDOWN);
  const codec = new TranslationMarkdownCodec();
  const translations = new Map<string, string>();
  for (const block of blocks) {
    if (block.type === "heading") {
      translations.set(block.id, "# 标题");
    }
    if (block.type === "paragraph") {
      translations.set(block.id, "介绍 [文档](https://example.com/guide?q=1)。");
    }
  }

  const exported = codec.buildExport(blocks, translations);
  assert.doesNotMatch(exported, /typora-(?:side-by-side|bilingual):block/);
  assert.match(exported, /# 标题/);
  assert.match(exported, /https:\/\/example\.com\/guide\?q=1/);
  assert.match(exported, /```ts\nconst answer = 42;\n```/);
  assert.match(exported, /\$\$\nE = mc\^2\n\$\$/);
  assert.match(exported, /<div class="note">Keep this HTML\.<\/div>/);
  assert.match(exported, /---/);
  assert.match(exported, /\[guide\]: https:\/\/example\.com\/reference "Reference title"/);

  const malformed = [
    "<!-- typora-side-by-side:block-start aaaaaaaaaaaaaaaa -->",
    "content",
    "<!-- typora-side-by-side:block-end bbbbbbbbbbbbbbbb -->"
  ].join("\n");
  assert.equal(codec.parseCache(malformed).size, 0);
});

test("Markdown protection restores URLs, inline code, math and HTML while enforcing structure", () => {
  const protector = new MarkdownStructureProtector();
  const source = "Read [docs](https://example.com/a?q=1), `npm test`, $x + 1$, and <kbd>Enter</kbd>.";
  const protectedMarkdown = protector.protect(source);
  const translated = protectedMarkdown.markdown.replace("Read", "阅读").replace("and", "以及");
  const restored = protectedMarkdown.restoreAndValidate(translated);

  assert.match(restored, /https:\/\/example\.com\/a\?q=1/);
  assert.match(restored, /`npm test`/);
  assert.match(restored, /\$x \+ 1\$/);
  assert.match(restored, /<kbd>Enter<\/kbd>/);
  assert.throws(
    () => protectedMarkdown.restoreAndValidate(translated.replace(/TYPORASIDEBYSIDEPROTECTED\d+TOKEN/, "changed")),
    /保护标记|受保护/
  );
  assert.throws(() => protector.protect("- one\n- two").restoreAndValidate("one and two"), /Markdown 块结构/);

  const reference = protector.protect("Read [Guide][guide].");
  const restoredReference = reference.restoreAndValidate(reference.markdown.replace("Read", "阅读"));
  assert.match(restoredReference, /\[Guide\]\[guide\]/);

  const twoLinks = protector.protect("[One](https://one.example) and [Two](https://two.example).");
  const swapped = twoLinks.markdown
    .replace("TYPORASIDEBYSIDEPROTECTED0TOKEN", "TEMPORARYTOKEN")
    .replace("TYPORASIDEBYSIDEPROTECTED1TOKEN", "TYPORASIDEBYSIDEPROTECTED0TOKEN")
    .replace("TEMPORARYTOKEN", "TYPORASIDEBYSIDEPROTECTED1TOKEN");
  assert.throws(() => twoLinks.restoreAndValidate(swapped), /移动了受保护/);
});
