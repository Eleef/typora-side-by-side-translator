import { TranslationBlockType } from "../types";
import { sha256 } from "../utils";

export const TRANSLATION_BLOCK_ID_ALGORITHM = "position-v1" as const;

export async function createTranslationBlockId(type: TranslationBlockType, order: number): Promise<string> {
  return (await sha256(`${TRANSLATION_BLOCK_ID_ALGORITHM}:${type}:${order}`)).slice(0, 16);
}
