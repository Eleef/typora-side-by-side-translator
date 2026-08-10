import { TranslationBlock } from "../types";
import { normalizeLineEndings } from "../utils";

const CONTROL_BLOCK_PATTERN =
  /<!-- (typora-(?:side-by-side|bilingual)):block-start ([a-f0-9]+) -->\n([\s\S]*?)\n<!-- \1:block-end \2 -->/g;
const CACHE_GENERATION_PATTERN = /<!-- typora-side-by-side:cache-generation ([a-f0-9-]+) -->/;
const CONTROL_START_PATTERN = /<!-- typora-(?:side-by-side|bilingual):block-start\b/g;
const CONTROL_END_PATTERN = /<!-- typora-(?:side-by-side|bilingual):block-end\b/g;

export interface ParsedTranslationCache {
  translations: Map<string, string>;
  blockIds: string[];
  duplicateIds: string[];
  generation: string | null;
  malformed: boolean;
}

export class TranslationMarkdownCodec {
  public parseCache(markdown: string | null): Map<string, string> {
    return this.inspectCache(markdown).translations;
  }

  public inspectCache(markdown: string | null): ParsedTranslationCache {
    const translations = new Map<string, string>();
    const blockIds: string[] = [];
    const duplicateIds: string[] = [];
    if (!markdown) {
      return { translations, blockIds, duplicateIds, generation: null, malformed: false };
    }

    let match: RegExpExecArray | null;
    CONTROL_BLOCK_PATTERN.lastIndex = 0;
    while ((match = CONTROL_BLOCK_PATTERN.exec(markdown)) !== null) {
      if (translations.has(match[2])) {
        duplicateIds.push(match[2]);
      }
      blockIds.push(match[2]);
      translations.set(match[2], normalizeLineEndings(match[3]).trim());
    }
    const startCount = markdown.match(CONTROL_START_PATTERN)?.length ?? 0;
    const endCount = markdown.match(CONTROL_END_PATTERN)?.length ?? 0;
    return {
      translations,
      blockIds,
      duplicateIds,
      generation: markdown.match(CACHE_GENERATION_PATTERN)?.[1] ?? null,
      malformed: startCount !== blockIds.length || endCount !== blockIds.length
    };
  }

  public buildCache(blocks: TranslationBlock[], translatedBlocks: Map<string, string>, generation?: string): string {
    const body = blocks
      .map((block) => {
        const markdown = translatedBlocks.get(block.id) ?? block.sourceMarkdown;
        return [
          `<!-- typora-side-by-side:block-start ${block.id} -->`,
          markdown.trim(),
          `<!-- typora-side-by-side:block-end ${block.id} -->`
        ].join("\n");
      })
      .join("\n\n")
      .trim();
    return generation ? `<!-- typora-side-by-side:cache-generation ${generation} -->\n\n${body}` : body;
  }

  public buildExport(blocks: TranslationBlock[], translatedBlocks: Map<string, string>): string {
    return blocks
      .map((block) => (translatedBlocks.get(block.id) ?? block.sourceMarkdown).trim())
      .join("\n\n")
      .trim();
  }
}
