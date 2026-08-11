import { TargetLanguage } from "../types";

export interface TargetLanguageDefinition {
  code: TargetLanguage;
  promptName: string;
  fileSuffix: string;
}

export const TARGET_LANGUAGES: readonly TargetLanguageDefinition[] = [
  { code: "zh-CN", promptName: "Simplified Chinese", fileSuffix: "zh" },
  { code: "zh-TW", promptName: "Traditional Chinese", fileSuffix: "zh-TW" },
  { code: "en", promptName: "English", fileSuffix: "en" },
  { code: "ja", promptName: "Japanese", fileSuffix: "ja" },
  { code: "ko", promptName: "Korean", fileSuffix: "ko" }
] as const;

const TARGET_LANGUAGE_BY_CODE = new Map(TARGET_LANGUAGES.map((language) => [language.code, language]));

export function isTargetLanguage(value: unknown): value is TargetLanguage {
  return typeof value === "string" && TARGET_LANGUAGE_BY_CODE.has(value as TargetLanguage);
}

export function normalizeTargetLanguage(value: unknown): TargetLanguage {
  return isTargetLanguage(value) ? value : "zh-CN";
}

export function getTargetLanguageDefinition(targetLang: TargetLanguage): TargetLanguageDefinition {
  return TARGET_LANGUAGE_BY_CODE.get(targetLang) ?? TARGET_LANGUAGES[0];
}
