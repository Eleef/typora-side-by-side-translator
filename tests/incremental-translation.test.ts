import assert from "node:assert/strict";
import test from "node:test";
import { BlockExtractionService } from "../src/markdown/BlockExtractionService";
import { UserFacingError } from "../src/i18n/UserFacingError";
import { TRANSLATION_BLOCK_ID_ALGORITHM } from "../src/markdown/BlockIdentity";
import { ExplicitTranslationAuthorizer } from "../src/translation/ExplicitTranslationAuthorizer";
import { hashTranslation, TRANSLATION_HASH_ALGORITHM, TRANSLATION_MAP_SCHEMA_VERSION } from "../src/translation/TranslationIntegrity";
import { TranslationMarkdownCodec } from "../src/translation/TranslationMarkdownCodec";
import {
  TranslationOrchestrator,
  TranslationProviderAdapter,
  TranslationStorageAdapter
} from "../src/translation/TranslationOrchestrator";
import { TranslationRequestPlanner } from "../src/translation/TranslationRequestPlanner";
import {
  TranslationCancelledError,
  TranslationTaskCoordinator
} from "../src/translation/TranslationTaskCoordinator";
import { FileAssociation, PluginSettingsData, TranslationBlock, TranslationMap, TranslationRequestPayload } from "../src/types";

const BEFORE_MARKDOWN = ["# Title", "", "First old.", "", "Second old.", "", "Third unchanged."].join("\n");
const AFTER_MARKDOWN = ["# Title", "", "First changed.", "", "Second changed.", "", "Third unchanged."].join("\n");
const TRANSLATION_SETTINGS: PluginSettingsData = {
  baseUrl: "https://api.example.com/v1",
  apiKey: "session-secret",
  model: "test-model",
  timeoutMs: 1000,
  targetLang: "zh-CN",
  uiLanguage: "auto",
  credentialStorageMode: "session",
  storedApiKey: "",
  sessionCredentialConfigured: true,
  translationDisclosureAccepted: true,
  paneWidthPercent: 50,
  toolbarDisplayMode: "compact",
  toolbarInteractionVersion: 1
};
const ASSOCIATION: FileAssociation = {
  sourcePath: "/source/article.md",
  cacheTargetPath: "/cache/article.zh.md",
  cacheMapPath: "/cache/article.zh.map.json",
  exportTargetPath: "/source/article.zh.md",
  targetLang: "zh-CN",
  isSupportedSource: true
};

function createMemoryStorage(initialFiles: Array<[string, string]>): {
  adapter: TranslationStorageAdapter;
  files: Map<string, string>;
  writes: string[];
  moves: string[];
} {
  const files = new Map(initialFiles);
  const writes: string[] = [];
  const moves: string[] = [];
  return {
    files,
    writes,
    moves,
    adapter: {
      async exists(targetPath) {
        return files.has(targetPath);
      },
      async readText(targetPath) {
        const content = files.get(targetPath);
        if (content === undefined) {
          throw new Error(`missing ${targetPath}`);
        }
        return content;
      },
      async writeText(targetPath, content) {
        files.set(targetPath, content);
        writes.push(targetPath);
      },
      async mkdir() {},
      async move(sourcePath, targetPath) {
        const content = files.get(sourcePath);
        if (content === undefined) {
          throw new Error(`missing ${sourcePath}`);
        }
        files.set(targetPath, content);
        files.delete(sourcePath);
        moves.push(`${sourcePath}->${targetPath}`);
      },
      async remove(targetPath) {
        files.delete(targetPath);
      }
    }
  };
}

function createProvider(onCall?: () => void): TranslationProviderAdapter {
  return {
    async translateBlocks(_settings, blocks) {
      onCall?.();
      return {
        blocks: blocks.map((block) => ({
          id: block.id,
          translatedMarkdown: `translated: ${block.sourceMarkdown}`
        }))
      };
    }
  };
}

async function createMap(blocks: TranslationBlock[], generated: Map<string, string>): Promise<TranslationMap> {
  return {
    schemaVersion: TRANSLATION_MAP_SCHEMA_VERSION,
    translatedHashAlgorithm: TRANSLATION_HASH_ALGORITHM,
    blockIdAlgorithm: TRANSLATION_BLOCK_ID_ALGORITHM,
    sourcePath: "source.md",
    targetPath: "target.md",
    targetLang: "zh-CN",
    provider: "openai-compatible",
    model: "test",
    updatedAt: "2026-08-01T00:00:00.000Z",
    blocks: await Promise.all(
      blocks.map(async (block) => ({
        id: block.id,
        type: block.type,
        order: block.order,
        headingPath: block.headingPath,
        sourceHash: block.sourceHash,
        translatedHash: await hashTranslation(generated.get(block.id) ?? block.sourceMarkdown),
        stale: false,
        manuallyEdited: false
      }))
    )
  };
}

test("block identity remains stable while source hashes detect edits", async () => {
  const extractor = new BlockExtractionService();
  const before = await extractor.extract(BEFORE_MARKDOWN);
  const after = await extractor.extract(AFTER_MARKDOWN);

  assert.deepEqual(
    after.map((block) => block.id),
    before.map((block) => block.id)
  );
  assert.deepEqual(
    after.map((block) => block.sourceHash === before[block.order].sourceHash),
    [true, false, false, true]
  );
});

test("stale planning skips unchanged and manually edited translations", async () => {
  const extractor = new BlockExtractionService();
  const before = await extractor.extract(BEFORE_MARKDOWN);
  const after = await extractor.extract(AFTER_MARKDOWN);
  const generated = new Map(before.map((block) => [block.id, `system translation ${block.order}`]));
  const map = await createMap(before, generated);
  const previousTranslations = new Map(generated);
  previousTranslations.set(before[1].id, "");
  const planner = new TranslationRequestPlanner();

  const staleRequests = await planner.collect(after, map, previousTranslations, "stale");
  assert.deepEqual(staleRequests.map((request) => request.id), [after[2].id]);

  const fullRequests = await planner.collect(after, map, previousTranslations, "full");
  assert.deepEqual(
    fullRequests.map((request) => request.id),
    after.filter((block) => block.translatable).map((block) => block.id)
  );
});

test("stale planning refuses legacy block identities without blocking full translation", async () => {
  const blocks = await new BlockExtractionService().extract(BEFORE_MARKDOWN);
  const generated = new Map(blocks.map((block) => [block.id, `system translation ${block.order}`]));
  const legacyMap = await createMap(blocks, generated);
  legacyMap.schemaVersion = 2;
  delete legacyMap.blockIdAlgorithm;
  const planner = new TranslationRequestPlanner();

  await assert.rejects(
    planner.collect(blocks, legacyMap, generated, "stale"),
    (error) => error instanceof UserFacingError && error.code === "cacheLegacy"
  );
  await assert.doesNotReject(planner.collect(blocks, legacyMap, generated, "full"));
});

test("structural edits with manual translations require an explicit full rebuild", async () => {
  const extractor = new BlockExtractionService();
  const before = await extractor.extract(BEFORE_MARKDOWN);
  const inserted = await extractor.extract(
    ["# Title", "", "Inserted paragraph.", "", "First old.", "", "Second old.", "", "Third unchanged."].join("\n")
  );
  const generated = new Map(before.map((block) => [block.id, `system translation ${block.order}`]));
  const map = await createMap(before, generated);
  const manuallyEdited = new Map(generated);
  manuallyEdited.set(before[1].id, "");
  const planner = new TranslationRequestPlanner();

  await assert.rejects(
    planner.collect(inserted, map, manuallyEdited, "stale"),
    (error) => error instanceof UserFacingError && error.code === "manualStructureConflict"
  );
  await assert.doesNotReject(planner.collect(inserted, map, generated, "stale"));
});

test("request batching enforces block and character limits", () => {
  const planner = new TranslationRequestPlanner();
  const thirteen = Array.from({ length: 13 }, (_, index): TranslationRequestPayload => ({
    id: String(index),
    sourceMarkdown: "x"
  }));
  assert.deepEqual(planner.batch(thirteen).map((batch) => batch.length), [12, 1]);

  const longRequests: TranslationRequestPayload[] = [
    { id: "first", sourceMarkdown: "a".repeat(3500) },
    { id: "second", sourceMarkdown: "b".repeat(3000) }
  ];
  assert.deepEqual(planner.batch(longRequests).map((batch) => batch.length), [1, 1]);
  assert.deepEqual(planner.batch([{ id: "oversized", sourceMarkdown: "x".repeat(6001) }]).map((batch) => batch.length), [1]);
});

test("translation refuses to write a cache for a different target language", async () => {
  let providerCalls = 0;
  const storage = createMemoryStorage([]);
  const orchestrator = new TranslationOrchestrator(createProvider(() => providerCalls += 1), storage.adapter, {
    dirname(targetPath) {
      return targetPath.slice(0, targetPath.lastIndexOf("/")) || "/";
    }
  });
  const authorizer = new ExplicitTranslationAuthorizer();

  await assert.rejects(
    orchestrator.translate(
      ASSOCIATION,
      BEFORE_MARKDOWN,
      { ...TRANSLATION_SETTINGS, targetLang: "ja" },
      "full",
      authorizer.authorize("translate-current-file")
    ),
    (error) => error instanceof UserFacingError && error.code === "cacheLanguageMismatch"
  );
  assert.equal(providerCalls, 0);
  assert.equal(storage.writes.length, 0);
});

test("stale translation preserves an intentionally empty manual translation", async () => {
  const extractor = new BlockExtractionService();
  const before = await extractor.extract(BEFORE_MARKDOWN);
  const after = await extractor.extract(
    ["# Title", "", "First changed.", "", "Second old.", "", "Third unchanged."].join("\n")
  );
  const generated = new Map(before.map((block) => [block.id, `system translation ${block.order}`]));
  const cachedTranslations = new Map(generated);
  cachedTranslations.set(before[1].id, "");
  const map = await createMap(before, generated);
  const codec = new TranslationMarkdownCodec();
  const storage = createMemoryStorage([
    [ASSOCIATION.cacheTargetPath, codec.buildCache(before, cachedTranslations)],
    [ASSOCIATION.cacheMapPath, JSON.stringify(map)]
  ]);
  let providerCalls = 0;
  const orchestrator = new TranslationOrchestrator(
    createProvider(() => {
      providerCalls += 1;
    }),
    storage.adapter,
    { dirname: () => "/cache" }
  );
  const authorizer = new ExplicitTranslationAuthorizer();

  const result = await orchestrator.translate(
    ASSOCIATION,
    after.map((block) => block.sourceMarkdown).join("\n\n"),
    TRANSLATION_SETTINGS,
    "stale",
    authorizer.authorize("refresh-stale-blocks")
  );

  assert.equal(providerCalls, 0);
  assert.equal(result.translatedBlocks.get(after[1].id), "");
  assert.equal(result.map.blocks[1].manuallyEdited, true);
  assert.equal(result.map.blocks[1].translatedHash, map.blocks[1].translatedHash);
  assert.equal(result.map.blocks[1].stale, true);
  assert.equal(result.map.blocks[1].sourceHash, map.blocks[1].sourceHash);
  assert.equal((await orchestrator.computeStaleState(ASSOCIATION, after.map((block) => block.sourceMarkdown).join("\n\n"))).staleCount, 1);
});

test("stale translation refuses incomplete or invalid caches before network and writes", async () => {
  const scenarios: Array<[string, Array<[string, string]>]> = [
    ["incomplete", [[ASSOCIATION.cacheTargetPath, "cached translation"]]],
    [
      "invalid",
      [
        [ASSOCIATION.cacheTargetPath, "cached translation"],
        [ASSOCIATION.cacheMapPath, "not-json"]
      ]
    ]
  ];
  const authorizer = new ExplicitTranslationAuthorizer();

  for (const [name, files] of scenarios) {
    let providerCalls = 0;
    const storage = createMemoryStorage(files);
    const orchestrator = new TranslationOrchestrator(
      createProvider(() => {
        providerCalls += 1;
      }),
      storage.adapter,
      { dirname: () => "/cache" }
    );

    await assert.rejects(
      orchestrator.translate(
        ASSOCIATION,
        "# Source",
        TRANSLATION_SETTINGS,
        "stale",
        authorizer.authorize("refresh-stale-blocks")
      ),
      (error) => error instanceof UserFacingError && error.code === "cacheInvalidRefresh",
      name
    );
    assert.equal(providerCalls, 0, name);
    assert.equal(storage.writes.length, 0, name);
  }

  const storage = createMemoryStorage(scenarios[1][1]);
  let fullCalls = 0;
  const orchestrator = new TranslationOrchestrator(
    createProvider(() => {
      fullCalls += 1;
    }),
    storage.adapter,
    { dirname: () => "/cache" }
  );
  await assert.doesNotReject(
    orchestrator.translate(
      ASSOCIATION,
      "# Source",
      TRANSLATION_SETTINGS,
      "full",
      authorizer.authorize("translate-current-file")
    )
  );
  assert.equal(fullCalls, 1);
  assert.equal(storage.files.has(ASSOCIATION.cacheMapPath), true);
  assert.equal(storage.files.has(ASSOCIATION.cacheTargetPath), true);
  assert.equal([...storage.files.keys()].some((targetPath) => /\.(?:tmp|bak)$/.test(targetPath)), false);
});

test("cache loading rejects mismatched block sets and generation ids", async () => {
  const blocks = await new BlockExtractionService().extract("# Source\n\nBody.");
  const generated = new Map(blocks.map((block) => [block.id, `translation ${block.order}`]));
  const map = await createMap(blocks, generated);
  map.cacheGeneration = "generation-a";
  const codec = new TranslationMarkdownCodec();
  const mismatchedBlocks = new Map(generated);
  mismatchedBlocks.delete(blocks[1].id);

  for (const targetMarkdown of [
    codec.buildCache(blocks.slice(0, 1), mismatchedBlocks, "generation-a"),
    codec.buildCache(blocks, generated, "generation-b")
  ]) {
    const storage = createMemoryStorage([
      [ASSOCIATION.cacheTargetPath, targetMarkdown],
      [ASSOCIATION.cacheMapPath, JSON.stringify(map)]
    ]);
    const orchestrator = new TranslationOrchestrator(createProvider(), storage.adapter, { dirname: () => "/cache" });
    assert.equal((await orchestrator.loadExistingState(ASSOCIATION)).status, "invalid");
  }
});

test("changes to protected source blocks become stale and refresh without a provider call", async () => {
  const beforeSource = "# Source\n\n```ts\nconst value = 1;\n```";
  const afterSource = "# Source\n\n```ts\nconst value = 2;\n```";
  const extractor = new BlockExtractionService();
  const before = await extractor.extract(beforeSource);
  const generated = new Map(before.map((block) => [block.id, block.sourceMarkdown]));
  generated.set(before[0].id, "# 来源");
  const map = await createMap(before, generated);
  const codec = new TranslationMarkdownCodec();
  const storage = createMemoryStorage([
    [ASSOCIATION.cacheTargetPath, codec.buildCache(before, generated)],
    [ASSOCIATION.cacheMapPath, JSON.stringify(map)]
  ]);
  let providerCalls = 0;
  const orchestrator = new TranslationOrchestrator(
    createProvider(() => {
      providerCalls += 1;
    }),
    storage.adapter,
    { dirname: () => "/cache" }
  );
  assert.equal((await orchestrator.computeStaleState(ASSOCIATION, afterSource)).staleCount, 1);
  assert.equal((await orchestrator.computeStaleState(ASSOCIATION, "# Source")).staleCount, 1);

  const authorizer = new ExplicitTranslationAuthorizer();
  const result = await orchestrator.translate(
    ASSOCIATION,
    afterSource,
    TRANSLATION_SETTINGS,
    "stale",
    authorizer.authorize("refresh-stale-blocks")
  );
  assert.equal(providerCalls, 0);
  assert.match(result.markdown, /const value = 2;/);
  assert.equal(result.map.blocks.find((block) => block.type === "code")?.stale, false);
});

test("cache pair commit rolls back both files when the second replacement fails", async () => {
  const source = "# Source\n\nBody.";
  const blocks = await new BlockExtractionService().extract(source);
  const oldTranslations = new Map(blocks.map((block) => [block.id, `old ${block.order}`]));
  const oldMap = await createMap(blocks, oldTranslations);
  const codec = new TranslationMarkdownCodec();
  const oldTarget = codec.buildCache(blocks, oldTranslations);
  const storage = createMemoryStorage([
    [ASSOCIATION.cacheTargetPath, oldTarget],
    [ASSOCIATION.cacheMapPath, JSON.stringify(oldMap)]
  ]);
  const originalMove = storage.adapter.move.bind(storage.adapter);
  storage.adapter.move = async (sourcePath, targetPath) => {
    if (sourcePath.endsWith(".map.json.tmp") && targetPath === ASSOCIATION.cacheMapPath) {
      throw new Error("simulated map commit failure");
    }
    return originalMove(sourcePath, targetPath);
  };
  const orchestrator = new TranslationOrchestrator(createProvider(), storage.adapter, { dirname: () => "/cache" });
  const authorizer = new ExplicitTranslationAuthorizer();

  await assert.rejects(
    orchestrator.translate(
      ASSOCIATION,
      source,
      TRANSLATION_SETTINGS,
      "full",
      authorizer.authorize("translate-current-file")
    ),
    /simulated map commit failure/
  );
  assert.equal(storage.files.get(ASSOCIATION.cacheTargetPath), oldTarget);
  assert.equal(storage.files.get(ASSOCIATION.cacheMapPath), JSON.stringify(oldMap));
  assert.equal([...storage.files.keys()].some((targetPath) => /\.(?:tmp|bak)$/.test(targetPath)), false);
});

test("translation task coordinator blocks duplicates and propagates cancellation", async () => {
  const coordinator = new TranslationTaskCoordinator();
  let releaseFirst!: () => void;
  const first = coordinator.run(
    ASSOCIATION.sourcePath,
    (signal) =>
      new Promise<void>((resolve, reject) => {
        releaseFirst = resolve;
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      })
  );

  await assert.rejects(
    coordinator.run(ASSOCIATION.sourcePath, async () => undefined),
    (error) => error instanceof UserFacingError && error.code === "taskAlreadyRunning"
  );
  assert.equal(coordinator.cancel(ASSOCIATION.sourcePath), true);
  await assert.rejects(first, TranslationCancelledError);
  assert.equal(coordinator.isRunning(ASSOCIATION.sourcePath), false);
  releaseFirst();
});
