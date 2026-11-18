const fs = require("node:fs/promises");
const path = require("node:path");
const compiled = path.resolve(__dirname, "../../../../.test-dist/src");
const { createStableCacheKey } = require(path.join(compiled, "files/CacheKey"));
const { BlockExtractionService } = require(path.join(compiled, "markdown/BlockExtractionService"));
const { getTargetLanguageDefinition } = require(path.join(compiled, "translation/TargetLanguage"));
const { ExplicitTranslationAuthorizer } = require(path.join(compiled, "translation/ExplicitTranslationAuthorizer"));
const { TranslationOrchestrator } = require(path.join(compiled, "translation/TranslationOrchestrator"));

async function main() {
  const [sourceArgument, rootArgument, mode] = process.argv.slice(2);
  if (!sourceArgument || !rootArgument || (mode && mode !== "--body-only")) {
    throw new Error("Usage: node seed-stale-cache.cjs <new Markdown path> <translation cache root> [--body-only]");
  }

  const sourcePath = path.join(await fs.realpath(path.dirname(sourceArgument)), path.basename(sourceArgument));
  const pairs = [
    ...(mode === "--body-only" ? [] : [["---\ndescription: Alignment fixture\n---", "---\ndescription: 对齐测试样例\n---"]]),
    ["# Alignment test", "# 对齐测试"],
    [
      "First retained paragraph. The source paragraph is longer than the translation, so the right column needs space before the next row.",
      "第一段保留译文。"
    ],
    [
      "- Original item\n\n  One nested paragraph.",
      "- 原文列表项\n\n  列表内的独立段落。这一段译文更长，用来确认右栏较长时左栏能够留出空间，让后面的表格从同一高度起排。"
    ],
    ["| Original | Value |\n| --- | --- |\n| Left | Right |", "| 原文 | 数值 |\n| --- | --- |\n| 左侧 | 右侧 |"],
    ["## Last check", "## 最后检查"],
    ["Final retained paragraph.", "最后一段保留译文。"]
  ];
  const sourceBlocks = pairs.map(([source]) => source);
  const sourceMarkdown = sourceBlocks.join("\n\n");
  const blocks = await new BlockExtractionService().extract(sourceMarkdown);
  if (blocks.length !== pairs.length) {
    throw new Error("Unexpected fixture block count");
  }
  const editedBlocks = sourceBlocks.slice();
  editedBlocks.splice(2, 0, "New paragraph. No translation has been requested for this paragraph.");
  await fs.writeFile(sourcePath, `${editedBlocks.join("\n\n")}\n`, { flag: "wx" });

  const targetLang = "zh-CN";
  const { fileSuffix } = getTargetLanguageDefinition(targetLang);
  const basename = path.basename(sourcePath, ".md");
  const cacheDirectory = path.join(await fs.realpath(rootArgument), createStableCacheKey(sourcePath, basename));
  await fs.mkdir(cacheDirectory);

  const translations = new Map(blocks.map(({ id }, index) => [id, pairs[index][1]]));
  const orchestrator = new TranslationOrchestrator({
    async translateBlocks(_settings, blocks) {
      return {
        blocks: blocks.map(({ id }) => {
          const translatedMarkdown = translations.get(id);
          if (translatedMarkdown === undefined) {
            throw new Error(`Unexpected fixture block: ${id}`);
          }
          return { id, translatedMarkdown };
        })
      };
    }
  }, {
    exists: (filename) => fs.access(filename).then(() => true, () => false),
    readText: (filename) => fs.readFile(filename, "utf8"),
    writeText: fs.writeFile,
    mkdir: (directory) => fs.mkdir(directory, { recursive: true }),
    copy: fs.copyFile,
    move: fs.rename,
    remove: fs.unlink
  }, path);
  const authorization = new ExplicitTranslationAuthorizer().authorize("translate-current-file");
  await orchestrator.translate({
    sourcePath,
    targetLang,
    cacheTargetPath: path.join(cacheDirectory, `${basename}.${fileSuffix}.md`),
    cacheMapPath: path.join(cacheDirectory, `${basename}.${fileSuffix}.map.json`)
  }, sourceMarkdown, { targetLang, model: "offline-fixture" }, "full", authorization);
  console.log(cacheDirectory);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
