import { BlockExtractionService } from "../markdown/BlockExtractionService";
import { TRANSLATION_BLOCK_ID_ALGORITHM } from "../markdown/BlockIdentity";
import {
  FileAssociation,
  PluginSettingsData,
  TranslationBlock,
  TranslationMap,
  TranslationMapBlock,
  TranslationRequestPayload,
  TranslationResponsePayload,
  TranslationResult
} from "../types";
import { normalizeLineEndings, sha256 } from "../utils";
import { ExplicitTranslationAuthorization } from "./ExplicitTranslationAuthorizer";
import { TranslationMarkdownCodec } from "./TranslationMarkdownCodec";
import { TranslationRequestPlanner } from "./TranslationRequestPlanner";
import { throwIfTranslationCancelled } from "./TranslationTaskCoordinator";
import {
  hashTranslation,
  migrateStoredTranslationHash,
  storedTranslationMatches,
  TRANSLATION_HASH_ALGORITHM,
  TRANSLATION_MAP_SCHEMA_VERSION,
  usesTranslationDigests
} from "./TranslationIntegrity";

export type TranslationCacheStatus = "empty" | "valid" | "incomplete" | "invalid";

export interface TranslationStorageAdapter {
  exists(targetPath: string): Promise<boolean>;
  readText(targetPath: string): Promise<string>;
  writeText(targetPath: string, content: string): Promise<void>;
  mkdir(targetPath: string): Promise<void>;
  move(sourcePath: string, targetPath: string): Promise<void>;
  remove(targetPath: string): Promise<void>;
}

export interface TranslationPathAdapter {
  dirname(targetPath: string): string;
}

export interface TranslationProviderAdapter {
  translateBlocks(
    settings: PluginSettingsData,
    blocks: TranslationRequestPayload[],
    authorization: ExplicitTranslationAuthorization,
    signal?: AbortSignal
  ): Promise<TranslationResponsePayload>;
}

export class TranslationOrchestrator {
  private readonly extractor = new BlockExtractionService();
  private readonly markdownCodec = new TranslationMarkdownCodec();
  private readonly requestPlanner = new TranslationRequestPlanner();

  public constructor(
    private readonly provider: TranslationProviderAdapter,
    private readonly storage: TranslationStorageAdapter,
    private readonly pathAdapter: TranslationPathAdapter
  ) {}

  public async loadExistingState(association: FileAssociation): Promise<{
    map: TranslationMap | null;
    targetMarkdown: string | null;
    status: TranslationCacheStatus;
  }> {
    const [mapExists, targetExists] = await Promise.all([
      this.storage.exists(association.cacheMapPath),
      this.storage.exists(association.cacheTargetPath)
    ]);
    if (!mapExists && !targetExists) {
      return { map: null, targetMarkdown: null, status: "empty" };
    }

    let normalizedTarget: string | null = null;
    if (targetExists) {
      try {
        normalizedTarget = normalizeLineEndings(await this.storage.readText(association.cacheTargetPath));
      } catch {
        return { map: null, targetMarkdown: null, status: "invalid" };
      }
    }
    if (!mapExists || !targetExists || normalizedTarget === null) {
      return { map: null, targetMarkdown: normalizedTarget, status: "incomplete" };
    }

    try {
      const mapRaw = await this.storage.readText(association.cacheMapPath);
      const parsedMap = JSON.parse(mapRaw) as TranslationMap;
      const map = usesTranslationDigests(parsedMap)
        ? parsedMap
        : await this.migrateLegacyMap(association, parsedMap, normalizedTarget);
      if (!usesTranslationDigests(parsedMap)) {
        normalizedTarget = normalizeLineEndings(await this.storage.readText(association.cacheTargetPath));
      }
      this.validateCachePair(map, normalizedTarget);
      return { map, targetMarkdown: normalizedTarget, status: "valid" };
    } catch {
      return { map: null, targetMarkdown: normalizedTarget, status: "invalid" };
    }
  }

  public async computeStaleState(
    association: FileAssociation,
    sourceMarkdown: string
  ): Promise<{
    blocks: TranslationBlock[];
    targetMarkdown: string | null;
    map: TranslationMap | null;
    staleCount: number;
  }> {
    const blocks = await this.extractor.extract(sourceMarkdown);
    const existing = await this.loadExistingState(association);
    if (!existing.map) {
      return {
        blocks,
        targetMarkdown: existing.targetMarkdown,
        map: null,
        staleCount: blocks.filter((block) => block.translatable).length
      };
    }

    const mapById = new Map(existing.map.blocks.map((block) => [block.id, block]));
    let staleCount = 0;
    for (const block of blocks) {
      const previous = mapById.get(block.id);
      if (!previous || previous.sourceHash !== block.sourceHash) {
        staleCount += 1;
      }
    }
    const currentIds = new Set(blocks.map((block) => block.id));
    staleCount += existing.map.blocks.filter((block) => !currentIds.has(block.id)).length;

    return {
      blocks,
      targetMarkdown: existing.targetMarkdown,
      map: existing.map,
      staleCount
    };
  }

  public async translate(
    association: FileAssociation,
    sourceMarkdown: string,
    settings: PluginSettingsData,
    mode: "full" | "stale",
    authorization: ExplicitTranslationAuthorization,
    signal?: AbortSignal
  ): Promise<TranslationResult> {
    throwIfTranslationCancelled(signal);
    const blocks = await this.extractor.extract(sourceMarkdown);
    const existing = await this.loadExistingState(association);
    if (mode === "stale" && (existing.status === "incomplete" || existing.status === "invalid")) {
      throw new Error("翻译缓存或映射文件不完整、损坏或不可读。为保护现有译文，已停止刷新脏区；请先导出或备份缓存，再执行“全文翻译”。");
    }
    const previousTranslations = this.markdownCodec.parseCache(existing.targetMarkdown);
    const existingMapById = new Map((existing.map?.blocks ?? []).map((block) => [block.id, block]));
    const requests = await this.requestPlanner.collect(blocks, existing.map, previousTranslations, mode);

    const translatedBlocks = new Map<string, string>();
    for (const block of blocks) {
      if (!block.translatable) {
        translatedBlocks.set(block.id, block.sourceMarkdown);
        continue;
      }
      if (previousTranslations.has(block.id)) {
        translatedBlocks.set(block.id, previousTranslations.get(block.id) ?? "");
      } else {
        translatedBlocks.set(block.id, block.sourceMarkdown);
      }
    }

    const generatedBlockIds = new Set<string>();
    for (const batch of this.requestPlanner.batch(requests)) {
      throwIfTranslationCancelled(signal);
      const response = await this.provider.translateBlocks(settings, batch, authorization, signal);
      for (const item of response.blocks) {
        translatedBlocks.set(item.id, normalizeLineEndings(item.translatedMarkdown).trim());
        generatedBlockIds.add(item.id);
      }
    }

    throwIfTranslationCancelled(signal);
    const generation = await this.createCacheGeneration(association, blocks, translatedBlocks);
    const markdown = this.markdownCodec.buildCache(blocks, translatedBlocks, generation);
    const map = await this.buildMap(
      association,
      settings,
      blocks,
      translatedBlocks,
      previousTranslations,
      existing.map,
      existingMapById,
      generatedBlockIds,
      generation
    );
    throwIfTranslationCancelled(signal);
    await this.writeCachePair(association, `${markdown}\n`, `${JSON.stringify(map, null, 2)}\n`, signal);

    return {
      markdown,
      map,
      blocks,
      translatedBlocks
    };
  }

  public async buildExportMarkdown(association: FileAssociation, sourceMarkdown: string): Promise<string> {
    const blocks = await this.extractor.extract(sourceMarkdown);
    const existing = await this.loadExistingState(association);
    if (existing.status !== "valid") {
      throw new Error("翻译缓存或映射文件不完整、损坏或不可读，已停止导出。");
    }
    const translatedBlocks = this.markdownCodec.parseCache(existing.targetMarkdown);
    return this.markdownCodec.buildExport(blocks, translatedBlocks);
  }

  public parseCachedTranslations(markdown: string | null): Map<string, string> {
    return this.markdownCodec.parseCache(markdown);
  }

  private async migrateLegacyMap(
    association: FileAssociation,
    legacyMap: TranslationMap,
    targetMarkdown: string
  ): Promise<TranslationMap> {
    const currentTranslations = this.markdownCodec.parseCache(targetMarkdown);
    const blocks: TranslationMapBlock[] = [];
    for (const block of legacyMap.blocks ?? []) {
      const hasCurrentTranslation = currentTranslations.has(block.id);
      const currentTranslation = currentTranslations.get(block.id) ?? "";
      const manuallyEdited = hasCurrentTranslation
        ? !(await storedTranslationMatches(legacyMap, block.translatedHash, currentTranslation))
        : block.manuallyEdited;
      blocks.push({
        ...block,
        translatedHash: await migrateStoredTranslationHash(legacyMap, block.translatedHash),
        manuallyEdited
      });
    }

    const migrated: TranslationMap = {
      ...legacyMap,
      schemaVersion: TRANSLATION_MAP_SCHEMA_VERSION,
      translatedHashAlgorithm: TRANSLATION_HASH_ALGORITHM,
      blocks
    };
    const generation = await sha256(`migration\n${association.sourcePath}\n${targetMarkdown}`);
    migrated.cacheGeneration = generation;
    const migratedTarget = this.markdownCodec.buildCache(
      this.extractBlocksForMigration(currentTranslations, legacyMap),
      currentTranslations,
      generation
    );
    await this.writeCachePair(
      association,
      `${migratedTarget}\n`,
      `${JSON.stringify(migrated, null, 2)}\n`
    );
    return migrated;
  }

  private async buildMap(
    association: FileAssociation,
    settings: PluginSettingsData,
    blocks: TranslationBlock[],
    translatedBlocks: Map<string, string>,
    previousTranslations: Map<string, string>,
    existingMap: TranslationMap | null,
    existingMapById: Map<string, TranslationMapBlock>,
    generatedBlockIds: Set<string>,
    generation: string
  ): Promise<TranslationMap> {
    const mapBlocks: TranslationMapBlock[] = [];
    for (const block of blocks) {
      const translated = translatedBlocks.get(block.id) ?? block.sourceMarkdown;
      const previous = existingMapById.get(block.id);
      const hasPreviousTranslation = previousTranslations.has(block.id);
      const previousTranslation = previousTranslations.get(block.id) ?? "";
      const manuallyEdited =
        block.translatable &&
        !!previous &&
        hasPreviousTranslation &&
        !(await storedTranslationMatches(existingMap, previous.translatedHash, previousTranslation));
      const preserveGeneratedBaseline = manuallyEdited && !generatedBlockIds.has(block.id) && !!previous;
      const manualSourceChanged = preserveGeneratedBaseline && previous.sourceHash !== block.sourceHash;
      const translatedHash = preserveGeneratedBaseline
        ? await migrateStoredTranslationHash(existingMap, previous.translatedHash)
        : await hashTranslation(translated);

      mapBlocks.push({
        id: block.id,
        type: block.type,
        order: block.order,
        headingPath: block.headingPath,
        sourceHash: manualSourceChanged ? previous.sourceHash : block.sourceHash,
        translatedHash,
        stale: manualSourceChanged,
        manuallyEdited: preserveGeneratedBaseline
      });
    }

    return {
      schemaVersion: TRANSLATION_MAP_SCHEMA_VERSION,
      translatedHashAlgorithm: TRANSLATION_HASH_ALGORITHM,
      blockIdAlgorithm: TRANSLATION_BLOCK_ID_ALGORITHM,
      cacheGeneration: generation,
      sourcePath: association.sourcePath,
      targetPath: association.cacheTargetPath,
      targetLang: "zh-CN",
      provider: "openai-compatible",
      model: settings.model,
      updatedAt: new Date().toISOString(),
      blocks: mapBlocks
    };
  }

  private validateCachePair(map: TranslationMap, targetMarkdown: string): void {
    if (!Array.isArray(map.blocks)) {
      throw new Error("缓存映射缺少 blocks 数组。");
    }
    const parsedCache = this.markdownCodec.inspectCache(targetMarkdown);
    if (parsedCache.malformed || parsedCache.duplicateIds.length > 0) {
      throw new Error("缓存译文包含损坏或重复的控制块。");
    }

    const mapIds = map.blocks.map((block) => block.id);
    if (new Set(mapIds).size !== mapIds.length) {
      throw new Error("缓存映射包含重复 block。");
    }
    const cacheIds = new Set(parsedCache.blockIds);
    if (mapIds.length !== parsedCache.blockIds.length || mapIds.some((id) => !cacheIds.has(id))) {
      throw new Error("缓存译文与映射文件的 block 集合不一致。");
    }
    if (map.cacheGeneration || parsedCache.generation) {
      if (!map.cacheGeneration || map.cacheGeneration !== parsedCache.generation) {
        throw new Error("缓存译文与映射文件不是同一批生成结果。");
      }
    }
  }

  private extractBlocksForMigration(
    translations: Map<string, string>,
    legacyMap: TranslationMap
  ): TranslationBlock[] {
    const mapById = new Map(legacyMap.blocks.map((block) => [block.id, block]));
    return [...translations.keys()].map((id, order) => {
      const mapped = mapById.get(id);
      const type = mapped?.type ?? "passthrough";
      return {
        id,
        type,
        sourceMarkdown: translations.get(id) ?? "",
        headingPath: mapped?.headingPath ?? [],
        order: mapped?.order ?? order,
        translatable: type !== "code" && type !== "math" && type !== "html" && type !== "passthrough",
        sourceHash: mapped?.sourceHash ?? ""
      };
    });
  }

  private async createCacheGeneration(
    association: FileAssociation,
    blocks: TranslationBlock[],
    translatedBlocks: Map<string, string>
  ): Promise<string> {
    const content = blocks.map((block) => `${block.id}\n${translatedBlocks.get(block.id) ?? ""}`).join("\n");
    return sha256(`${association.sourcePath}\n${new Date().toISOString()}\n${content}\n${Math.random()}`);
  }

  private async writeCachePair(
    association: FileAssociation,
    targetContent: string,
    mapContent: string,
    signal?: AbortSignal
  ): Promise<void> {
    const targetTemp = `${association.cacheTargetPath}.tmp`;
    const mapTemp = `${association.cacheMapPath}.tmp`;
    const targetBackup = `${association.cacheTargetPath}.bak`;
    const mapBackup = `${association.cacheMapPath}.bak`;
    let targetBackedUp = false;
    let mapBackedUp = false;
    let targetCommitted = false;
    let mapCommitted = false;
    let commitCompleted = false;
    let rollbackCompleted = false;

    await this.storage.mkdir(this.pathAdapter.dirname(association.cacheTargetPath));
    await Promise.all([
      this.safeRemove(targetTemp),
      this.safeRemove(mapTemp),
      this.safeRemove(targetBackup),
      this.safeRemove(mapBackup)
    ]);

    try {
      throwIfTranslationCancelled(signal);
      await this.storage.writeText(targetTemp, targetContent);
      await this.storage.writeText(mapTemp, mapContent);
      const [writtenTarget, writtenMap] = await Promise.all([
        this.storage.readText(targetTemp),
        this.storage.readText(mapTemp)
      ]);
      const parsedMap = JSON.parse(writtenMap) as TranslationMap;
      this.validateCachePair(parsedMap, normalizeLineEndings(writtenTarget));
      throwIfTranslationCancelled(signal);

      if (await this.storage.exists(association.cacheTargetPath)) {
        await this.storage.move(association.cacheTargetPath, targetBackup);
        targetBackedUp = true;
      }
      if (await this.storage.exists(association.cacheMapPath)) {
        await this.storage.move(association.cacheMapPath, mapBackup);
        mapBackedUp = true;
      }
      throwIfTranslationCancelled(signal);
      await this.storage.move(targetTemp, association.cacheTargetPath);
      targetCommitted = true;
      throwIfTranslationCancelled(signal);
      await this.storage.move(mapTemp, association.cacheMapPath);
      mapCommitted = true;
      throwIfTranslationCancelled(signal);
      commitCompleted = true;
    } catch (error) {
      try {
        if (targetCommitted) {
          await this.safeRemove(association.cacheTargetPath);
        }
        if (mapCommitted) {
          await this.safeRemove(association.cacheMapPath);
        }
        if (targetBackedUp) {
          await this.storage.move(targetBackup, association.cacheTargetPath);
        }
        if (mapBackedUp) {
          await this.storage.move(mapBackup, association.cacheMapPath);
        }
        rollbackCompleted = true;
      } catch (rollbackError) {
        const detail = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        const originalDetail = error instanceof Error ? error.message : String(error);
        throw new Error(`缓存提交失败，且自动回滚未完成；备份文件已保留。原错误：${originalDetail}；回滚错误：${detail}`);
      }
      throw error;
    } finally {
      await Promise.all([this.safeRemove(targetTemp), this.safeRemove(mapTemp)]);
      if (commitCompleted || rollbackCompleted) {
        await Promise.all([this.safeRemove(targetBackup), this.safeRemove(mapBackup)]);
      }
    }
  }

  private async safeRemove(targetPath: string): Promise<void> {
    try {
      if (await this.storage.exists(targetPath)) {
        await this.storage.remove(targetPath);
      }
    } catch {
      // Cleanup must not replace the original translation or commit error.
    }
  }
}
