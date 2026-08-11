import { UiLanguage, UiLocale } from "../types";

export const UI_LANGUAGES: readonly UiLanguage[] = ["auto", "en", "zh-CN", "zh-TW", "ja", "ko"] as const;

const UI_LANGUAGE_SET = new Set<string>(UI_LANGUAGES);

export function isUiLanguage(value: unknown): value is UiLanguage {
  return typeof value === "string" && UI_LANGUAGE_SET.has(value);
}

export function normalizeUiLanguage(value: unknown): UiLanguage {
  return isUiLanguage(value) ? value : "auto";
}

export function resolveUiLocale(value: unknown): UiLocale {
  const locale = typeof value === "string" ? value.trim().replace(/_/g, "-").toLowerCase() : "";
  if (locale === "zh-tw" || locale === "zh-hk" || locale === "zh-mo" || locale.includes("hant")) {
    return "zh-TW";
  }
  if (locale === "zh" || locale.startsWith("zh-")) {
    return "zh-CN";
  }
  if (locale === "ja" || locale.startsWith("ja-")) {
    return "ja";
  }
  if (locale === "ko" || locale.startsWith("ko-")) {
    return "ko";
  }
  return "en";
}

export function formatMessage(template: string, values: Record<string, string | number> = {}): string {
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
  );
}
