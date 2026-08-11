import { TargetLanguage } from "../types";

export interface TargetLanguageDefinition {
  code: TargetLanguage;
  label: string;
  promptName: string;
  fileSuffix: string;
  shortLabel: string;
}

export const TARGET_LANGUAGES: readonly TargetLanguageDefinition[] = [
  { code: "zh-CN", label: "简体中文", promptName: "Simplified Chinese", fileSuffix: "zh", shortLabel: "中简" },
  { code: "zh-TW", label: "繁体中文", promptName: "Traditional Chinese", fileSuffix: "zh-TW", shortLabel: "中繁" },
  { code: "en", label: "English", promptName: "English", fileSuffix: "en", shortLabel: "EN" },
  { code: "ja", label: "日本語", promptName: "Japanese", fileSuffix: "ja", shortLabel: "日" },
  { code: "ko", label: "한국어", promptName: "Korean", fileSuffix: "ko", shortLabel: "한" }
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
