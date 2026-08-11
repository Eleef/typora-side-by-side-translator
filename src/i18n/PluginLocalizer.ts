import { I18n } from "@typora-community-plugin/core";
import { TargetLanguage, UiLanguage } from "../types";
import type en from "./locales/lang.en.json";
import { formatMessage, normalizeUiLanguage, resolveUiLocale } from "./UiLanguage";

export type UiMessages = typeof en;

export class PluginLocalizer {
  private i18n!: I18n<UiMessages>;
  private preference: UiLanguage = "auto";

  public constructor(
    private readonly localePath: string,
    private readonly autoLocale: unknown,
    preference: UiLanguage = "auto"
  ) {
    this.setLanguage(preference);
  }

  public get locale(): string {
    return this.i18n.locale;
  }

  public get language(): UiLanguage {
    return this.preference;
  }

  public get t(): UiMessages {
    return this.i18n.t;
  }

  public setLanguage(value: unknown): void {
    this.preference = normalizeUiLanguage(value);
    const options =
      this.preference === "auto"
        ? { defaultLang: "en", userLang: resolveUiLocale(this.autoLocale), localePath: this.localePath }
        : { defaultLang: "en", userLang: this.preference, localePath: this.localePath };
    this.i18n = new I18n<UiMessages>(options);
  }

  public format(template: string, values: Record<string, string | number> = {}): string {
    return formatMessage(template, values);
  }

  public targetLanguageLabel(targetLang: TargetLanguage): string {
    return this.t.languages.target[targetLang];
  }

  public targetLanguageShortLabel(targetLang: TargetLanguage): string {
    return this.t.languages.targetShort[targetLang];
  }

  public uiLanguageLabel(uiLanguage: UiLanguage): string {
    return this.t.languages.ui[uiLanguage];
  }
}
