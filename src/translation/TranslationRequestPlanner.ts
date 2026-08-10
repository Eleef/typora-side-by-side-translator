import { TRANSLATION_BLOCK_ID_ALGORITHM } from "../markdown/BlockIdentity";
import { TranslationBlock, TranslationMap, TranslationRequestPayload } from "../types";
import { storedTranslationMatches } from "./TranslationIntegrity";

export type TranslationMode = "full" | "stale";

export class TranslationRequestPlanner {
  public async collect(
    blocks: TranslationBlock[],
    existingMap: TranslationMap | null,
    previousTranslations: Map<string, string>,
    mode: TranslationMode
  ): Promise<TranslationRequestPayload[]> {
    if (mode === "stale" && existingMap && existingMap.blockIdAlgorithm !== TRANSLATION_BLOCK_ID_ALGORITHM) {
      throw new Error("缓存映射来自旧版块标识算法。为保护人工译文，请执行“全文翻译”显式重建缓存。");
    }

    const existingMapById = new Map((existingMap?.blocks ?? []).map((block) => [block.id, block]));
    const manuallyEditedIds = new Set<string>();
    for (const previousMapBlock of existingMap?.blocks ?? []) {
      const hasPreviousTranslation = previousTranslations.has(previousMapBlock.id);
      const previousTranslation = previousTranslations.get(previousMapBlock.id) ?? "";
      if (
        hasPreviousTranslation &&
        !(await storedTranslationMatches(existingMap, previousMapBlock.translatedHash, previousTranslation))
      ) {
        manuallyEditedIds.add(previousMapBlock.id);
      }
    }

    if (mode === "stale" && existingMap && manuallyEditedIds.size > 0 && this.hasStructuralChanges(blocks, existingMap)) {
      throw new Error("检测到文档块结构变化和人工改写译文。为避免错配，已停止刷新脏区；请先导出或备份译文，再执行“全文翻译”。");
    }

    const requests: TranslationRequestPayload[] = [];
    for (const block of blocks) {
      if (!block.translatable) {
        continue;
      }

      const previousMapBlock = existingMapById.get(block.id);
      const manuallyEdited = !!previousMapBlock && manuallyEditedIds.has(previousMapBlock.id);

      if (mode === "stale") {
        const unchanged = previousMapBlock && previousMapBlock.sourceHash === block.sourceHash;
        if (unchanged || manuallyEdited) {
          continue;
        }
      }

      requests.push({
        id: block.id,
        sourceMarkdown: block.sourceMarkdown
      });
    }
    return requests;
  }

  public batch(requests: TranslationRequestPayload[]): TranslationRequestPayload[][] {
    const batches: TranslationRequestPayload[][] = [];
    let current: TranslationRequestPayload[] = [];
    let currentChars = 0;

    for (const request of requests) {
      const chars = request.sourceMarkdown.length;
      if (current.length > 0 && (current.length >= 12 || currentChars + chars > 6000)) {
        batches.push(current);
        current = [];
        currentChars = 0;
      }
      current.push(request);
      currentChars += chars;
    }

    if (current.length > 0) {
      batches.push(current);
    }
    return batches;
  }

  private hasStructuralChanges(blocks: TranslationBlock[], existingMap: TranslationMap): boolean {
    const previous = [...existingMap.blocks].sort((left, right) => left.order - right.order);
    if (blocks.length !== previous.length) {
      return true;
    }

    for (let index = 0; index < blocks.length; index += 1) {
      if (previous[index].order !== blocks[index].order || previous[index].type !== blocks[index].type) {
        return true;
      }
    }

    const previousOrdersByHash = new Map<string, number[]>();
    for (const block of previous) {
      const orders = previousOrdersByHash.get(block.sourceHash) ?? [];
      orders.push(block.order);
      previousOrdersByHash.set(block.sourceHash, orders);
    }
    return blocks.some((block) => {
      const previousAtPosition = previous[block.order];
      if (previousAtPosition?.sourceHash === block.sourceHash) {
        return false;
      }
      return (previousOrdersByHash.get(block.sourceHash) ?? []).some((order) => order !== block.order);
    });
  }
}
