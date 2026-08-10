import { normalizeLineEndings, sha256 } from "../utils";
import { TranslationMap } from "../types";

export const TRANSLATION_MAP_SCHEMA_VERSION = 4 as const;
export const TRANSLATION_HASH_ALGORITHM = "sha256" as const;

function normalizeTranslation(markdown: string): string {
  return normalizeLineEndings(markdown).trim();
}

export function usesTranslationDigests(map: TranslationMap | null): boolean {
  return map?.translatedHashAlgorithm === TRANSLATION_HASH_ALGORITHM;
}

export async function hashTranslation(markdown: string): Promise<string> {
  return sha256(normalizeTranslation(markdown));
}

export async function storedTranslationMatches(
  map: TranslationMap | null,
  storedValue: string,
  currentMarkdown: string
): Promise<boolean> {
  if (usesTranslationDigests(map)) {
    return storedValue === (await hashTranslation(currentMarkdown));
  }
  return normalizeTranslation(storedValue) === normalizeTranslation(currentMarkdown);
}

export async function migrateStoredTranslationHash(map: TranslationMap | null, storedValue: string): Promise<string> {
  return usesTranslationDigests(map) ? storedValue : hashTranslation(storedValue);
}
