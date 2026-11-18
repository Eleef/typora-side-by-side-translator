import { BlockExtractionService } from "../markdown/BlockExtractionService";
import { TRANSLATION_BLOCK_ID_ALGORITHM } from "../markdown/BlockIdentity";
import { UserFacingError } from "../i18n/UserFacingError";
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

interface CacheState {
  map: TranslationMap | null;
  targetMarkdown: string | null;
  status: TranslationCacheStatus;
  recoveryRequired?: boolean;
}

export interface TranslationStorageAdapter {
  exists(targetPath: string): Promise<boolean>;
  readText(targetPath: string): Promise<string>;
  writeText(targetPath: string, content: string): Promise<void>;
  mkdir(targetPath: string): Promise<void>;
  copy(sourcePath: string, targetPath: string): Promise<void>;
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
  private readonly cacheOperations = new Map<string, Promise<unknown>>();

  public constructor(
    private readonly provider: TranslationProviderAdapter,
    private readonly storage: TranslationStorageAdapter,
    private readonly pathAdapter: TranslationPathAdapter
  ) {}

  public loadExistingState(association: FileAssociation): Promise<CacheState> {
    return this.withCacheOperation(association, async () => {
      const existing = await this.readOrRecoverCache(association);
      if (!existing.map || existing.targetMarkdown === null || usesTranslationDigests(existing.map)) {
        return existing;
      }
      try {
        await this.migrateLegacyMap(association, existing.map, existing.targetMarkdown);
        return await this.readCachePair(association);
      } catch {
        return { ...existing, map: null, status: "invalid" };
      }
    });
  }

  private async readCachePair(
    association: FileAssociation,
    targetPath = association.cacheTargetPath,
    mapPath = association.cacheMapPath
  ): Promise<CacheState> {
    const [mapExists, targetExists] = await Promise.all([
      this.storage.exists(mapPath),
      this.storage.exists(targetPath)
    ]);
    if (!mapExists && !targetExists) {
      return { map: null, targetMarkdown: null, status: "empty" };
    }

    let normalizedTarget: string | null = null;
    if (targetExists) {
      try {
        normalizedTarget = normalizeLineEndings(await this.storage.readText(targetPath));
      } catch {
        return { map: null, targetMarkdown: null, status: "invalid" };
      }
    }
    if (!mapExists || !targetExists || normalizedTarget === null) {
      return { map: null, targetMarkdown: normalizedTarget, status: "incomplete" };
    }

    try {
      const map = JSON.parse(await this.storage.readText(mapPath)) as TranslationMap;
      this.validateCachePair(map, normalizedTarget, association);
      return { map, targetMarkdown: normalizedTarget, status: "valid" };
    } catch {
      return { map: null, targetMarkdown: normalizedTarget, status: "invalid" };
    }
  }

  private async readOrRecoverCache(association: FileAssociation): Promise<CacheState> {
    const existing = await this.readCachePair(association);
    if (existing.status === "valid") {
      return existing;
    }
    const targetBackup = `${association.cacheTargetPath}.bak`;
    const mapBackup = `${association.cacheMapPath}.bak`;
    const [hasTargetBackup, hasMapBackup] = await Promise.all([
      this.storage.exists(targetBackup),
      this.storage.exists(mapBackup)
    ]);
    if (!hasTargetBackup && !hasMapBackup) {
      return existing;
    }

    const targetPath = hasTargetBackup ? targetBackup : association.cacheTargetPath;
    const mapPath = hasMapBackup ? mapBackup : association.cacheMapPath;
    const backup = await this.readCachePair(association, targetPath, mapPath);
    if (backup.status !== "valid") {
      return { ...existing, status: "invalid", recoveryRequired: true };
    }

    try {
      for (const [savedPath, restorePath] of [
        [targetPath, association.cacheTargetPath],
        [mapPath, association.cacheMapPath]
      ]) {
        if (savedPath === restorePath) {
          continue;
        }
        const stagedPath = `${restorePath}.tmp`;
        await this.storage.copy(savedPath, stagedPath);
        await this.storage.move(stagedPath, restorePath);
      }
      const restored = await this.readCachePair(association);
      if (restored.status === "valid") {
        return restored;
      }
    } catch {
      return { ...existing, status: "invalid", recoveryRequired: true };
    }
    return { ...existing, status: "invalid", recoveryRequired: true };
  }

  private async withCacheOperation<Result>(
    association: FileAssociation,
    operation: () => Promise<Result>
  ): Promise<Result> {
    const key = association.cacheTargetPath;
    const pending = this.cacheOperations.get(key);
    const running = (pending ? pending.catch(() => undefined) : Promise.resolve()).then(operation);
    this.cacheOperations.set(key, running);
    try {
      return await running;
    } finally {
      if (this.cacheOperations.get(key) === running) {
        this.cacheOperations.delete(key);
      }
    }
  }

  private countStaleBlocks(blocks: TranslationBlock[], map: TranslationMap): number {
    const mapById = new Map(map.blocks.map((block) => [block.id, block]));
    const currentIds = new Set(blocks.map((block) => block.id));
    const changedCount = blocks.filter((block) => mapById.get(block.id)?.sourceHash !== block.sourceHash).length;
    return changedCount + map.blocks.filter((block) => !currentIds.has(block.id)).length;
  }

  private async loadMatchingState(association: FileAssociation, blocks: TranslationBlock[]): Promise<CacheState> {
    const existing = await this.loadExistingState(association);
    if (!existing.map || existing.targetMarkdown === null) {
      return existing;
    }
    const frontmatter = blocks[0]?.type === "frontmatter" ? blocks[0] : undefined;
    const oldHasFrontmatter = existing.map.blocks[0]?.type === "frontmatter";
    if (Boolean(frontmatter) === oldHasFrontmatter) {
      return existing;
    }

    const body = frontmatter ? blocks.slice(1) : blocks;
    const oldBody = existing.map.blocks.slice(Math.max(0, existing.map.blocks.length - body.length));
    if (existing.map.blockIdAlgorithm !== TRANSLATION_BLOCK_ID_ALGORITHM ||
      oldBody.length !== body.length ||
      body.some((block, index) => block.type !== oldBody[index].type || block.sourceHash !== oldBody[index].sourceHash)) {
      return { map: null, targetMarkdown: null, status: "invalid" };
    }

    const oldTranslations = this.markdownCodec.parseCache(existing.targetMarkdown);
    const translations = new Map<string, string>();
    const mapBlocks: TranslationMapBlock[] = [];
    if (frontmatter) {
      translations.set(frontmatter.id, frontmatter.sourceMarkdown);
      mapBlocks.push({
        id: frontmatter.id,
        type: frontmatter.type,
        order: frontmatter.order,
        headingPath: frontmatter.headingPath,
        sourceHash: frontmatter.translatable ? "" : frontmatter.sourceHash,
        translatedHash: await hashTranslation(frontmatter.sourceMarkdown),
        stale: false,
        manuallyEdited: false
      });
    }
    for (const [index, block] of body.entries()) {
      const previous = oldBody[index];
      translations.set(block.id, oldTranslations.get(previous.id) ?? block.sourceMarkdown);
      mapBlocks.push({ ...previous, id: block.id, order: block.order, headingPath: block.headingPath });
    }
    return {
      ...existing,
      map: { ...existing.map, blocks: mapBlocks },
      targetMarkdown: this.markdownCodec.buildCache(blocks, translations, existing.map.cacheGeneration)
    };
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
    const existing = await this.loadMatchingState(association, blocks);
    if (!existing.map) {
      return {
        blocks,
        targetMarkdown: existing.targetMarkdown,
        map: null,
        staleCount: blocks.filter((block) => block.translatable).length
      };
    }

    return {
      blocks,
      targetMarkdown: existing.targetMarkdown,
      map: existing.map,
      staleCount: this.countStaleBlocks(blocks, existing.map)
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
    if (settings.targetLang !== association.targetLang) {
      throw new UserFacingError("cacheLanguageMismatch");
    }
    const blocks = await this.extractor.extract(sourceMarkdown);
    const existing = await this.loadMatchingState(association, blocks);
    if (existing.recoveryRequired) {
      throw new UserFacingError("cacheRecoveryRequired");
    }
    if (mode === "stale" && (existing.status === "incomplete" || existing.status === "invalid")) {
      throw new UserFacingError("cacheInvalidRefresh");
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
    await this.withCacheOperation(association, () =>
      this.writeCachePair(association, `${markdown}\n`, `${JSON.stringify(map, null, 2)}\n`, signal)
    );

    return {
      markdown,
      map,
      blocks,
      translatedBlocks
    };
  }

  public async buildExportMarkdown(association: FileAssociation, sourceMarkdown: string): Promise<string> {
    const blocks = await this.extractor.extract(sourceMarkdown);
    const existing = await this.loadMatchingState(association, blocks);
    if (!existing.map) {
      throw new UserFacingError(existing.status === "empty" ? "exportRequiresTranslation" : "cacheInvalidExport");
    }
    if (this.countStaleBlocks(blocks, existing.map) > 0) {
      throw new UserFacingError("cacheStaleExport");
    }
    const translatedBlocks = this.markdownCodec.parseCache(existing.targetMarkdown);
    return this.markdownCodec.buildExport(blocks, translatedBlocks);
  }

  public getPreviewTranslations(
    markdown: string | null,
    blocks: TranslationBlock[],
    map: TranslationMap | null
  ): Map<string, string> {
    const preview = new Map<string, string>();
    if (!map || !markdown) {
      return preview;
    }

    const cached = this.markdownCodec.parseCache(markdown);
    const previousById = new Map(map.blocks.map((block) => [block.id, block]));
    const previousByHash = new Map<string, TranslationMapBlock | null>();
    const currentHashCounts = new Map<string, number>();
    for (const block of map.blocks) {
      previousByHash.set(block.sourceHash, previousByHash.has(block.sourceHash) ? null : block);
    }
    for (const block of blocks) {
      currentHashCounts.set(block.sourceHash, (currentHashCounts.get(block.sourceHash) ?? 0) + 1);
    }
    for (const block of blocks) {
      const samePosition = previousById.get(block.id);
      const previous = samePosition?.sourceHash === block.sourceHash
        ? samePosition
        : currentHashCounts.get(block.sourceHash) === 1 ? previousByHash.get(block.sourceHash) : null;
      const translation = previous ? cached.get(previous.id) : undefined;
      if (translation !== undefined) {
        preview.set(block.id, translation);
      }
    }
    return preview;
  }

  private async migrateLegacyMap(
    association: FileAssociation,
    legacyMap: TranslationMap,
    targetMarkdown: string
  ): Promise<void> {
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
      targetLang: association.targetLang,
      provider: "openai-compatible",
      model: settings.model,
      updatedAt: new Date().toISOString(),
      blocks: mapBlocks
    };
  }

  private validateCachePair(map: TranslationMap, targetMarkdown: string, association: FileAssociation): void {
    if (map.targetLang !== association.targetLang) {
      throw new UserFacingError("cacheLanguageMismatch");
    }
    if (!Array.isArray(map.blocks)) {
      throw new UserFacingError("cacheInvalid");
    }
    const parsedCache = this.markdownCodec.inspectCache(targetMarkdown);
    if (parsedCache.malformed || parsedCache.duplicateIds.length > 0) {
      throw new UserFacingError("cacheInvalid");
    }

    const mapIds = map.blocks.map((block) => block.id);
    if (new Set(mapIds).size !== mapIds.length) {
      throw new UserFacingError("cacheInvalid");
    }
    const cacheIds = new Set(parsedCache.blockIds);
    if (mapIds.length !== parsedCache.blockIds.length || mapIds.some((id) => !cacheIds.has(id))) {
      throw new UserFacingError("cacheInvalid");
    }
    if (map.cacheGeneration || parsedCache.generation) {
      if (!map.cacheGeneration || map.cacheGeneration !== parsedCache.generation) {
        throw new UserFacingError("cacheInvalid");
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
        translatable: type !== "code" && type !== "math" && type !== "html" && type !== "passthrough" && type !== "frontmatter",
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
    let backupCycleStarted = false;
    let commitCompleted = false;
    let rollbackCompleted = false;

    throwIfTranslationCancelled(signal);
    const current = await this.readOrRecoverCache(association);
    if (current.recoveryRequired) {
      throw new UserFacingError("cacheRecoveryRequired");
    }

    await this.storage.mkdir(this.pathAdapter.dirname(association.cacheTargetPath));
    await Promise.all([
      this.safeRemove(targetTemp),
      this.safeRemove(mapTemp)
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
      this.validateCachePair(parsedMap, normalizeLineEndings(writtenTarget), association);
      throwIfTranslationCancelled(signal);

      for (const backupPath of [targetBackup, mapBackup]) {
        if (await this.storage.exists(backupPath)) {
          await this.storage.remove(backupPath);
        }
      }
      backupCycleStarted = true;
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
        throw new UserFacingError("cacheCommitRollback", { original: originalDetail, rollback: detail });
      }
      throw error;
    } finally {
      await Promise.all([this.safeRemove(targetTemp), this.safeRemove(mapTemp)]);
      if (commitCompleted || (backupCycleStarted && rollbackCompleted)) {
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
