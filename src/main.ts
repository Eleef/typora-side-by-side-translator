import {
  app as coreApp,
  fs,
  path as corePath,
  Plugin,
  PluginSettings,
  SettingTab,
  SettingItem
} from "@typora-community-plugin/core";
import { CacheMaintenanceService } from "./cache/CacheMaintenanceService";
import { PluginDiagnostics } from "./diagnostics/PluginDiagnostics";
import { FileAssociationService } from "./files/FileAssociationService";
import { describeEndpointForDiagnostics, normalizeAndValidateBaseUrl } from "./security/EndpointPolicy";
import { SessionCredentialStore } from "./security/SessionCredentialStore";
import { ExplicitTranslationAuthorizer } from "./translation/ExplicitTranslationAuthorizer";
import { OpenAICompatibleProvider } from "./translation/OpenAICompatibleProvider";
import { normalizeTargetLanguage, TARGET_LANGUAGES } from "./translation/TargetLanguage";
import { TranslationOrchestrator } from "./translation/TranslationOrchestrator";
import {
  isTranslationCancelled,
  TranslationTaskCoordinator
} from "./translation/TranslationTaskCoordinator";
import { CredentialStorageMode, PaneRenderState, PluginSettingsData, TargetLanguage } from "./types";
import { TranslationPaneController } from "./ui/TranslationPaneController";

PluginDiagnostics.markModuleEvaluated();

const LEGACY_PLUGIN_IDS = ["eleef.typora-side-by-side-translation", "jiang.typora-bilingual"] as const;
const PLUGIN_DATA_DIRECTORY = "eleef.typora-side-by-side-translator";

const DEFAULT_SETTINGS: PluginSettingsData = {
  baseUrl: "",
  apiKey: "",
  model: "",
  timeoutMs: 45000,
  targetLang: "zh-CN",
  credentialStorageMode: "session",
  storedApiKey: "",
  paneWidthPercent: 50,
  toolbarDisplayMode: "compact"
};

type DisposableLike = (() => void) | { unload: () => void } | undefined | null;

type AppLike = {
  workspace: {
    activeMarkdownFile?: { path?: string };
    activeFile?: string;
    on: (eventName: string, callback: (...args: unknown[]) => void) => DisposableLike;
  };
  features?: {
    markdownEditor?: {
      on: (eventName: string, callback: (...args: unknown[]) => void) => DisposableLike;
    };
  };
};

export default class TyporaSideBySideTranslatorPlugin extends Plugin {
  private readonly diagnostics = new PluginDiagnostics();
  private readonly paneController = new TranslationPaneController();
  private readonly translationAuthorizer = new ExplicitTranslationAuthorizer();
  private readonly translationTasks = new TranslationTaskCoordinator();
  private readonly translator = new TranslationOrchestrator(
    new OpenAICompatibleProvider(this.translationAuthorizer),
    fs,
    corePath
  );
  private settingsStore!: PluginSettings<PluginSettingsData>;
  private associationService!: FileAssociationService;
  private cacheMaintenance!: CacheMaintenanceService;
  private readonly sessionCredentials = new SessionCredentialStore();
  private removedPersistedApiKey = false;
  private migratedLegacyApiKey = "";
  private paneVisible = false;
  private contentChangeTimer: number | null = null;
  private refreshPromise: Promise<void> | null = null;
  private renderState: PaneRenderState = {
    association: null,
    targetMarkdown: null,
    translatedBlocks: new Map(),
    blocks: [],
    isVisible: false,
    staleCount: 0,
    targetLang: "zh-CN",
    paneWidthPercent: 50,
    toolbarDisplayMode: "compact",
    isTranslating: false
  };

  public override async onload(): Promise<void> {
    await this.diagnostics.attach(this.dataPath);
    await this.diagnostics.info("plugin onload start", {
      manifestId: this.manifest.id,
      manifestVersion: this.manifest.version,
      dataPath: this.dataPath
    });

    try {
      await this.migrateLegacyPluginData();
      await this.initializeSettings();
      const translationsCacheRoot = this.getTranslationsCacheRoot();
      this.associationService = new FileAssociationService(translationsCacheRoot);
      this.cacheMaintenance = new CacheMaintenanceService(translationsCacheRoot, fs, corePath);
      if (this.removedPersistedApiKey) {
        await this.diagnostics.warn("removed legacy plaintext API key from persisted settings");
      }
      await this.diagnostics.info("settings initialized", this.getRuntimeSettingsSummary());
      this.registerSettingTab(new TyporaSideBySideTranslatorSettingTab(this));
      this.registerPluginCommands();
      this.registerWorkspaceEvents();
      this.registerEditorEvents();
      this.paneController.ensureMounted({
        onTranslateAll: () => void this.translateCurrentFile("full"),
        onRefreshStale: () => void this.translateCurrentFile("stale"),
        onCancelTranslation: () => this.cancelCurrentTranslation(),
        onExportTarget: () => void this.exportTargetFile(),
        onTargetLanguageChange: (targetLang) => void this.updateSetting("targetLang", targetLang),
        onJumpToSource: (blockId) => this.paneController.jumpToSource(blockId),
        onResize: (paneWidthPercent) => void this.updateSetting("paneWidthPercent", paneWidthPercent)
      });
      this.register(() => this.translationTasks.cancelAll("插件已卸载，翻译任务已取消。"));
      await this.refreshState();
      await this.diagnostics.info("initial refresh complete");
    } catch (error) {
      await this.diagnostics.error("failed to initialize plugin", this.errorMeta(error));
      console.error("[typora-side-by-side] failed to initialize", error);
    }
  }

  public getRuntimeSettings(): PluginSettingsData {
    return {
      baseUrl: this.settingsStore.get("baseUrl"),
      apiKey: this.sessionCredentials.get(this.settingsStore.get("baseUrl")),
      model: this.settingsStore.get("model"),
      timeoutMs: this.settingsStore.get("timeoutMs"),
      targetLang: normalizeTargetLanguage(this.settingsStore.get("targetLang")),
      credentialStorageMode: this.normalizeCredentialStorageMode(this.settingsStore.get("credentialStorageMode")),
      storedApiKey: this.settingsStore.get("storedApiKey") || "",
      paneWidthPercent: this.normalizePaneWidth(this.settingsStore.get("paneWidthPercent")),
      toolbarDisplayMode: this.normalizeToolbarDisplayMode(this.settingsStore.get("toolbarDisplayMode"))
    };
  }

  public async updateSetting<K extends keyof PluginSettingsData>(key: K, value: PluginSettingsData[K]): Promise<void> {
    if (key === "storedApiKey") {
      throw new Error("已保存的 API key 只能由插件内部更新。");
    }
    if (key === "apiKey") {
      await this.updateApiKey(String(value));
      await this.diagnostics.info("setting updated", { key, value: Boolean(this.getRuntimeSettings().apiKey) });
      return;
    }

    if (key === "credentialStorageMode") {
      await this.updateCredentialStorageMode(this.normalizeCredentialStorageMode(value));
      await this.diagnostics.info("setting updated", { key, value: this.getRuntimeSettings().credentialStorageMode });
      return;
    }

    const nextValue =
      key === "paneWidthPercent"
        ? (this.normalizePaneWidth(value as number) as PluginSettingsData[K])
        : key === "toolbarDisplayMode"
          ? (this.normalizeToolbarDisplayMode(value) as PluginSettingsData[K])
          : key === "targetLang"
            ? (normalizeTargetLanguage(value) as PluginSettingsData[K])
            : key === "baseUrl"
              ? (normalizeAndValidateBaseUrl(String(value)) as PluginSettingsData[K])
              : value;
    const previousOrigin = key === "baseUrl" ? this.getCredentialOrigin(this.settingsStore.get("baseUrl")) : "";
    this.settingsStore.set(key, nextValue);
    if (key === "baseUrl") {
      const nextOrigin = this.getCredentialOrigin(String(nextValue));
      if (previousOrigin !== nextOrigin) {
        this.sessionCredentials.clear();
        this.clearStoredCredential();
      }
    }
    this.settingsStore.save();
    if (key === "paneWidthPercent" || key === "toolbarDisplayMode") {
      const runtime = this.getRuntimeSettings();
      this.renderState = {
        ...this.renderState,
        paneWidthPercent: runtime.paneWidthPercent,
        toolbarDisplayMode: runtime.toolbarDisplayMode
      };
      this.paneController.render(this.renderState);
    }
    if (key === "targetLang") {
      this.translationTasks.cancelAll("目标语言已切换，翻译任务已取消。");
      await this.refreshState();
    }
    await this.diagnostics.info("setting updated", {
      key,
      value: nextValue
    });
  }

  public get pluginApp(): AppLike {
    return coreApp as unknown as AppLike;
  }

  public get diagnosticsLogPath(): string | null {
    return this.diagnostics.getLogPath();
  }

  public get pluginVersion(): string {
    return this.manifest.version;
  }

  public get credentialStatusDescription(): string {
    const settings = this.getRuntimeSettings();
    if (!settings.apiKey) {
      return settings.credentialStorageMode === "plugin-settings"
        ? "明文保存已开启；请输入 API key 后将写入社区插件设置。"
        : "尚未配置 API key；仅在当前 Typora 会话中保留。";
    }
    return settings.credentialStorageMode === "plugin-settings" && !!settings.storedApiKey
      ? "API key 已保存在社区插件设置中；同一 Windows 用户下的其他程序可读取。"
      : "API key 仅在当前 Typora 会话中可用。";
  }

  public async clearApiKey(): Promise<void> {
    this.sessionCredentials.clear();
    this.clearStoredCredential();
    this.settingsStore.set("apiKey", "");
    this.settingsStore.save();
    await this.diagnostics.info("API key cleared");
  }

  public async getCacheDescription(): Promise<string> {
    const usage = await this.cacheMaintenance.getUsage();
    return `${this.cacheMaintenance.rootPath} | ${usage.fileCount} 个文件 | ${this.formatBytes(usage.byteCount)}`;
  }

  public async clearCurrentCache(): Promise<void> {
    const association = this.getCurrentAssociation();
    if (!association.isSupportedSource) {
      throw new Error(association.reason ?? "当前文件不支持缓存清理。");
    }

    await this.cacheMaintenance.clearAssociation(association);
    await this.diagnostics.info("current translation cache cleared", { sourcePath: association.sourcePath });
    await this.refreshState();
    this.renderState.infoMessage = "当前文档的缓存译文和映射已清理。";
    this.renderState.warningMessage = undefined;
    this.renderState.errorMessage = undefined;
    this.paneController.render(this.renderState);
  }

  public async clearAllCaches(): Promise<void> {
    await this.cacheMaintenance.clearAll();
    await this.diagnostics.info("all translation caches cleared");
    await this.refreshState();
    this.renderState.infoMessage = "Typora Side-by-Side Translator 的全部翻译缓存已清理。";
    this.renderState.warningMessage = undefined;
    this.renderState.errorMessage = undefined;
    this.paneController.render(this.renderState);
  }

  public async clearDiagnostics(): Promise<void> {
    await this.diagnostics.clear();
  }

  private async initializeSettings(): Promise<void> {
    this.settingsStore = new PluginSettings<PluginSettingsData>(coreApp as never, this.manifest, { version: 1 });
    this.settingsStore.setDefault(DEFAULT_SETTINGS);
    this.settingsStore.load();
    this.settingsStore.set("targetLang", normalizeTargetLanguage(this.settingsStore.get("targetLang")));
    this.settingsStore.set(
      "credentialStorageMode",
      this.normalizeCredentialStorageMode(this.settingsStore.get("credentialStorageMode"))
    );
    const persistedApiKey = this.settingsStore.get("apiKey") || this.migratedLegacyApiKey;
    if (persistedApiKey) {
      try {
        this.sessionCredentials.set(this.settingsStore.get("baseUrl"), persistedApiKey);
      } catch {
        this.sessionCredentials.clear();
      }
      this.settingsStore.set("apiKey", "");
      this.settingsStore.save();
      this.removedPersistedApiKey = true;
    }
    if (
      this.settingsStore.get("credentialStorageMode") === "plugin-settings" &&
      this.settingsStore.get("storedApiKey")
    ) {
      try {
        const baseUrl = this.settingsStore.get("baseUrl");
        this.sessionCredentials.set(baseUrl, this.settingsStore.get("storedApiKey"));
      } catch {
        this.sessionCredentials.clear();
        this.clearStoredCredential();
        await this.diagnostics.warn("stored API key was invalid and has been cleared");
      }
    }
    this.settingsStore.save();
    this.registerSettings(this.settingsStore);
  }

  private async updateApiKey(value: string): Promise<void> {
    const baseUrl = this.settingsStore.get("baseUrl");
    const normalizedValue = value.trim();
    this.sessionCredentials.set(baseUrl, normalizedValue);
    this.settingsStore.set("apiKey", "");
    this.settingsStore.set(
      "storedApiKey",
      normalizedValue && this.settingsStore.get("credentialStorageMode") === "plugin-settings" ? normalizedValue : ""
    );
    this.settingsStore.save();
  }

  private async updateCredentialStorageMode(mode: CredentialStorageMode): Promise<void> {
    if (mode === "plugin-settings") {
      const baseUrl = this.settingsStore.get("baseUrl");
      const apiKey = this.sessionCredentials.get(baseUrl);
      if (apiKey) {
        this.settingsStore.set("storedApiKey", apiKey);
      }
    } else {
      this.clearStoredCredential();
    }
    this.settingsStore.set("credentialStorageMode", mode);
    this.settingsStore.save();
  }

  private clearStoredCredential(): void {
    this.settingsStore.set("storedApiKey", "");
  }

  private getCredentialOrigin(baseUrl: string): string {
    try {
      const normalized = normalizeAndValidateBaseUrl(baseUrl);
      return normalized ? new URL(normalized).origin : "";
    } catch {
      return "";
    }
  }

  private registerPluginCommands(): void {
    this.registerCommand({
      id: "typora-side-by-side-translator.toggle-pane",
      title: "Toggle Pane",
      scope: "global",
      showInCommandPanel: true,
      callback: () => {
        this.paneVisible = !this.paneVisible;
        this.renderState.isVisible = this.paneVisible;
        this.renderState.paneWidthPercent = this.getRuntimeSettings().paneWidthPercent;
        this.paneController.render(this.renderState);
        void this.diagnostics.info("toggle pane command executed", { paneVisible: this.paneVisible });
      }
    });

    this.registerCommand({
      id: "typora-side-by-side-translator.translate-current-file",
      title: "Translate Current File",
      scope: "global",
      showInCommandPanel: true,
      callback: () => void this.translateCurrentFile("full")
    });

    this.registerCommand({
      id: "typora-side-by-side-translator.refresh-stale-blocks",
      title: "Refresh Stale Blocks",
      scope: "global",
      showInCommandPanel: true,
      callback: () => void this.translateCurrentFile("stale")
    });

    this.registerCommand({
      id: "typora-side-by-side-translator.export-target-file",
      title: "Export Target File",
      scope: "global",
      showInCommandPanel: true,
      callback: () => void this.exportTargetFile()
    });

    this.registerCommand({
      id: "typora-side-by-side-translator.cancel-translation",
      title: "Cancel Translation",
      scope: "global",
      showInCommandPanel: true,
      callback: () => this.cancelCurrentTranslation()
    });
  }

  private registerWorkspaceEvents(): void {
    this.registerDisposable(
      this.pluginApp.workspace.on("file:open", () => {
        void this.refreshState();
      })
    );
    this.registerDisposable(
      this.pluginApp.workspace.on("file:will-open", () => {
        this.translationTasks.cancelAll("已切换文件，旧翻译任务已取消。");
        void this.refreshState();
      })
    );
  }

  private registerEditorEvents(): void {
    const editor = this.pluginApp.features?.markdownEditor;
    if (!editor) {
      void this.diagnostics.warn("markdown editor feature unavailable");
      return;
    }

    this.registerDisposable(
      editor.on("editor:load-complete", () => {
        void this.refreshState();
      })
    );
    this.registerDisposable(
      editor.on("editor:content-change", () => {
        if (this.contentChangeTimer) {
          window.clearTimeout(this.contentChangeTimer);
        }
        this.contentChangeTimer = window.setTimeout(() => void this.refreshState(), 400);
      })
    );
  }

  private registerDisposable(disposable: DisposableLike): void {
    if (!disposable) {
      return;
    }
    if (typeof disposable === "function") {
      this.register(disposable);
      return;
    }
    this.register(() => disposable.unload());
  }

  private async refreshState(): Promise<void> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.doRefreshState().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async doRefreshState(): Promise<void> {
    const association = this.getCurrentAssociation();
    const runtime = this.getRuntimeSettings();
    const paneWidthPercent = runtime.paneWidthPercent;

    if (!association.isSupportedSource) {
      this.renderState = {
        association,
        targetMarkdown: null,
        translatedBlocks: new Map(),
        blocks: [],
        isVisible: this.paneVisible,
        staleCount: 0,
        targetLang: runtime.targetLang,
        paneWidthPercent,
        toolbarDisplayMode: runtime.toolbarDisplayMode,
        isTranslating: false,
        warningMessage: undefined,
        errorMessage: undefined,
        infoMessage: undefined
      };
      this.paneController.render(this.renderState);
      return;
    }

    const sourceMarkdown = await this.readCurrentMarkdown(association.sourcePath);
    const state = await this.translator.computeStaleState(association, sourceMarkdown);
    this.renderState = {
      association,
      targetMarkdown: state.targetMarkdown,
      translatedBlocks: this.extractTranslatedBlocks(state.targetMarkdown),
      blocks: state.blocks,
      isVisible: this.paneVisible,
      staleCount: state.staleCount,
      targetLang: runtime.targetLang,
      paneWidthPercent,
      toolbarDisplayMode: runtime.toolbarDisplayMode,
      isTranslating: this.translationTasks.isRunning(association.cacheTargetPath),
      warningMessage: state.staleCount > 0 && !!state.targetMarkdown ? "原文已更新，当前显示的是缓存译文，需手动刷新。" : undefined,
      errorMessage: undefined,
      infoMessage: undefined
    };
    this.paneController.render(this.renderState);
  }

  private async translateCurrentFile(mode: "full" | "stale"): Promise<void> {
    const association = this.getCurrentAssociation();
    if (!association.isSupportedSource) {
      this.renderState = {
        ...this.renderState,
        association,
        isVisible: true,
        errorMessage: association.reason ?? "当前文件不受支持。"
      };
      this.paneVisible = true;
      this.paneController.render(this.renderState);
      return;
    }

    if (this.translationTasks.isRunning(association.cacheTargetPath)) {
      this.renderState = {
        ...this.renderState,
        association,
        isVisible: true,
        warningMessage: "当前文档已有翻译任务正在运行，可点击“取消翻译”后重试。"
      };
      this.paneVisible = true;
      this.paneController.render(this.renderState);
      return;
    }

    this.paneVisible = true;
    this.renderState = {
      ...this.renderState,
      association,
      isVisible: true,
      paneWidthPercent: this.getRuntimeSettings().paneWidthPercent,
      toolbarDisplayMode: this.getRuntimeSettings().toolbarDisplayMode,
      targetLang: association.targetLang,
      isTranslating: true,
      errorMessage: undefined,
      infoMessage: undefined,
      warningMessage: mode === "stale" ? "正在刷新缓存译文脏区..." : "正在生成缓存译文..."
    };
    this.paneController.render(this.renderState);

    try {
      const result = await this.translationTasks.run(association.cacheTargetPath, async (signal) => {
        const sourceMarkdown = await this.readCurrentMarkdown(association.sourcePath);
        const authorization = this.translationAuthorizer.authorize(
          mode === "full" ? "translate-current-file" : "refresh-stale-blocks"
        );
        return this.translator.translate(
          association,
          sourceMarkdown,
          this.getRuntimeSettings(),
          mode,
          authorization,
          signal
        );
      });
      await this.diagnostics.info("translate command success", {
        mode,
        sourcePath: association.sourcePath,
        cacheTargetPath: association.cacheTargetPath,
        blockCount: result.blocks.length
      });
      if (!this.isSameAssociation(this.getCurrentAssociation(), association)) {
        return;
      }
      const staleCount = result.map.blocks.filter((block) => block.stale).length;
      this.renderState = {
        association,
        targetMarkdown: result.markdown,
        translatedBlocks: result.translatedBlocks,
        blocks: result.blocks,
        isVisible: true,
        staleCount,
        targetLang: association.targetLang,
        paneWidthPercent: this.getRuntimeSettings().paneWidthPercent,
        toolbarDisplayMode: this.getRuntimeSettings().toolbarDisplayMode,
        isTranslating: false,
        infoMessage: staleCount === 0 ? `缓存译文已更新到 ${association.cacheTargetPath}` : undefined,
        warningMessage:
          staleCount > 0 ? `已保留 ${staleCount} 个人工译文块；对应原文已变化，译文仍标记为过期。` : undefined,
        errorMessage: undefined
      };
    } catch (error) {
      if (isTranslationCancelled(error)) {
        await this.diagnostics.info("translate command cancelled", {
          mode,
          sourcePath: association.sourcePath
        });
      } else {
        await this.diagnostics.error("translate command failed", this.errorMeta(error));
      }
      if (!this.isSameAssociation(this.getCurrentAssociation(), association)) {
        return;
      }
      this.renderState = {
        ...this.renderState,
        association,
        isVisible: true,
        isTranslating: false,
        warningMessage: undefined,
        infoMessage: isTranslationCancelled(error) ? "翻译任务已取消，现有缓存未被覆盖。" : undefined,
        errorMessage: isTranslationCancelled(error) ? undefined : error instanceof Error ? error.message : String(error)
      };
    }

    this.paneController.render(this.renderState);
  }

  private cancelCurrentTranslation(): void {
    const association = this.getCurrentAssociation();
    if (!association.isSupportedSource || !this.translationTasks.cancel(association.cacheTargetPath)) {
      return;
    }
    this.renderState = {
      ...this.renderState,
      association,
      isVisible: true,
      warningMessage: "正在取消翻译任务...",
      errorMessage: undefined
    };
    this.paneController.render(this.renderState);
  }

  private async exportTargetFile(): Promise<void> {
    const association = this.getCurrentAssociation();
    if (!association.isSupportedSource) {
      return;
    }

    const exists = await fs.exists(association.cacheTargetPath);
    if (!exists) {
      this.renderState = {
        ...this.renderState,
        association,
        isVisible: true,
        errorMessage: "请先全文翻译，当前还没有缓存译文可导出。"
      };
      this.paneVisible = true;
      this.paneController.render(this.renderState);
      return;
    }

    const exportExists = await fs.exists(association.exportTargetPath);
    if (exportExists) {
      const confirmed = window.confirm(`目标目录已存在同名译文：\n${association.exportTargetPath}\n\n是否覆盖？`);
      if (!confirmed) {
        this.renderState = {
          ...this.renderState,
          association,
          isVisible: true,
          errorMessage: undefined,
          infoMessage: "已取消导出，保留原目录中的现有译文文件。"
        };
        this.paneController.render(this.renderState);
        return;
      }
    }

    try {
      const sourceMarkdown = await this.readCurrentMarkdown(association.sourcePath);
      const markdown = await this.translator.buildExportMarkdown(association, sourceMarkdown);
      await fs.writeText(association.exportTargetPath, `${markdown}\n`);
      await this.diagnostics.info("export target file success", {
        cacheTargetPath: association.cacheTargetPath,
        exportTargetPath: association.exportTargetPath
      });
      this.renderState = {
        ...this.renderState,
        association,
        isVisible: true,
        errorMessage: undefined,
        warningMessage: undefined,
        infoMessage: `译文已导出到 ${association.exportTargetPath}`
      };
    } catch (error) {
      await this.diagnostics.error("export target file failed", this.errorMeta(error));
      this.renderState = {
        ...this.renderState,
        association,
        isVisible: true,
        warningMessage: undefined,
        infoMessage: undefined,
        errorMessage: error instanceof Error ? error.message : String(error)
      };
    }
    this.paneController.render(this.renderState);
  }

  private getCurrentAssociation() {
    const activePath = this.pluginApp.workspace.activeFile ?? this.pluginApp.workspace.activeMarkdownFile?.path;
    const normalized = activePath ? activePath.replace(/\//g, corePath.sep) : null;
    return this.associationService.resolve(normalized, this.getRuntimeSettings().targetLang);
  }

  private isSameAssociation(
    left: { sourcePath: string; cacheTargetPath: string },
    right: { sourcePath: string; cacheTargetPath: string }
  ): boolean {
    return left.sourcePath === right.sourcePath && left.cacheTargetPath === right.cacheTargetPath;
  }

  private async readCurrentMarkdown(sourcePath: string): Promise<string> {
    const exists = await fs.exists(sourcePath);
    if (!exists) {
      await this.diagnostics.warn("active source file not found", { sourcePath });
      throw new Error("未找到当前源文件。");
    }
    return fs.readText(sourcePath);
  }

  private extractTranslatedBlocks(markdown: string | null): Map<string, string> {
    return this.translator.parseCachedTranslations(markdown);
  }

  private getTranslationsCacheRoot(): string {
    return corePath.join(corePath.dirname(this.dataPath), PLUGIN_DATA_DIRECTORY, "translations");
  }

  private normalizePaneWidth(value: number): number {
    if (!Number.isFinite(value)) {
      return 50;
    }
    return Math.min(65, Math.max(35, Math.round(value)));
  }

  private normalizeToolbarDisplayMode(value: unknown): "compact" | "collapsed" {
    return value === "collapsed" ? "collapsed" : "compact";
  }

  private normalizeCredentialStorageMode(value: unknown): CredentialStorageMode {
    return value === "plugin-settings" ? "plugin-settings" : "session";
  }

  private getRuntimeSettingsSummary(): Record<string, unknown> {
    const settings = this.getRuntimeSettings();
    return {
      endpoint: describeEndpointForDiagnostics(settings.baseUrl),
      translationConfigured: Boolean(settings.baseUrl && settings.apiKey && settings.model),
      model: settings.model,
      timeoutMs: settings.timeoutMs,
      targetLang: settings.targetLang,
      retentionMode: settings.credentialStorageMode,
      paneWidthPercent: settings.paneWidthPercent,
      toolbarDisplayMode: settings.toolbarDisplayMode
    };
  }

  private errorMeta(error: unknown): Record<string, unknown> {
    if (error instanceof Error) {
      return {
        message: error.message,
        stack: error.stack
      };
    }
    return {
      value: String(error)
    };
  }

  private formatBytes(byteCount: number): string {
    if (byteCount < 1024) {
      return `${byteCount} B`;
    }
    if (byteCount < 1024 * 1024) {
      return `${(byteCount / 1024).toFixed(1)} KiB`;
    }
    return `${(byteCount / (1024 * 1024)).toFixed(1)} MiB`;
  }

  private async migrateLegacyPluginData(): Promise<void> {
    const dataDirectory = corePath.dirname(this.dataPath);
    let shouldSeedCurrentSettings = !(await fs.exists(this.dataPath));
    for (const legacyPluginId of LEGACY_PLUGIN_IDS) {
      const legacySettingsPath = corePath.join(dataDirectory, `${legacyPluginId}.json`);
      if (!(await fs.exists(legacySettingsPath))) {
        continue;
      }
      try {
        await fs.mkdir(dataDirectory);
        const legacyDocument = JSON.parse(await fs.readText(legacySettingsPath)) as {
          version?: number;
          settings?: Partial<PluginSettingsData>;
        };
        const legacyApiKey = typeof legacyDocument.settings?.apiKey === "string" ? legacyDocument.settings.apiKey : "";
        if (!this.migratedLegacyApiKey && legacyApiKey) {
          this.migratedLegacyApiKey = legacyApiKey;
        }
        const migratedDocument = {
          version: legacyDocument.version ?? 1,
          settings: {
            ...(legacyDocument.settings ?? {}),
            apiKey: ""
          }
        };
        const serialized = `${JSON.stringify(migratedDocument, null, 2)}\n`;
        if (shouldSeedCurrentSettings) {
          await fs.writeText(this.dataPath, serialized);
          shouldSeedCurrentSettings = false;
        }
        await fs.writeText(legacySettingsPath, serialized);
        await this.diagnostics.info("legacy plugin settings migrated", {
          legacyPluginId,
          legacySettingsPath,
          dataPath: this.dataPath
        });
      } catch (error) {
        await this.diagnostics.warn("legacy plugin settings migration failed", {
          legacyPluginId,
          ...this.errorMeta(error)
        });
      }
    }

    const nextCacheRoot = this.getTranslationsCacheRoot();
    const legacyCacheRoots = [
      corePath.join(dataDirectory, "eleef.typora-side-by-side-translation", "translations"),
      corePath.join(dataDirectory, "translations")
    ];
    for (const legacyCacheRoot of legacyCacheRoots) {
      if ((await fs.exists(nextCacheRoot)) || !(await fs.exists(legacyCacheRoot))) {
        continue;
      }
      await fs.mkdir(corePath.dirname(nextCacheRoot));
      await fs.move(legacyCacheRoot, nextCacheRoot);
      await this.diagnostics.info("legacy translation cache migrated", { legacyCacheRoot, nextCacheRoot });
    }
  }
}

class TyporaSideBySideTranslatorSettingTab extends SettingTab {
  public constructor(private readonly pluginInstance: TyporaSideBySideTranslatorPlugin) {
    super();
  }

  public get name(): string {
    return "Typora Side-by-Side Translator";
  }

  private addSettingInput(
    title: string,
    description: string,
    value: string,
    onChange: (value: string) => Promise<void>,
    inputType = "text"
  ): void {
    this.addSetting((setting: SettingItem) => {
      setting.addName(title);
      setting.addDescription(description);
      setting.addInput(inputType, (input: HTMLInputElement) => {
        input.value = value;
        input.addEventListener("change", () => {
          input.setCustomValidity("");
          void onChange(input.value).catch((error) => {
            input.setCustomValidity(error instanceof Error ? error.message : String(error));
            input.reportValidity();
          });
        });
      });
    });
  }

  public onshow(): void {
    this.containerEl.innerHTML = "";
    this.addSettingTitle("Typora Side-by-Side Translator");

    this.addSetting((setting: SettingItem) => {
      setting.addName("版本");
      setting.addDescription(`当前安装版本：${this.pluginInstance.pluginVersion}`);
    });

    const settings = this.pluginInstance.getRuntimeSettings();
    this.addSetting((setting: SettingItem) => {
      setting.addName("目标语言");
      setting.addDescription("切换后读取对应语言的独立缓存，不会自动发送翻译请求。");
      setting.addSelect((select) => {
        for (const language of TARGET_LANGUAGES) {
          const option = document.createElement("option");
          option.value = language.code;
          option.textContent = language.label;
          select.appendChild(option);
        }
        select.value = settings.targetLang;
        select.addEventListener("change", () => {
          void this.pluginInstance
            .updateSetting("targetLang", select.value as TargetLanguage)
            .then(() => this.onshow())
            .catch((error) => {
              window.alert(error instanceof Error ? error.message : String(error));
              this.onshow();
            });
        });
      });
    });

    this.addSettingInput("baseUrl", "OpenAI 兼容接口基础地址，例如 https://host/v1。更换服务来源会清除当前会话和已保存的 API key。", settings.baseUrl, async (value) => {
      await this.pluginInstance.updateSetting("baseUrl", value.trim());
      this.onshow();
    });

    this.addSetting((setting: SettingItem) => {
      setting.addName("API key 保存方式");
      setting.addDescription("默认会话模式不落盘；明文模式可跨重启和覆盖安装，但同一 Windows 用户下的其他程序可以读取。");
      setting.addSelect((select) => {
        const options: Array<[CredentialStorageMode, string]> = [
          ["session", "仅当前 Typora 会话"],
          ["plugin-settings", "保存在插件设置中（明文）"]
        ];
        for (const [value, label] of options) {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = label;
          select.appendChild(option);
        }
        select.value = settings.credentialStorageMode;
        select.addEventListener("change", () => {
          void this.pluginInstance
            .updateSetting("credentialStorageMode", select.value as CredentialStorageMode)
            .then(() => this.onshow())
            .catch((error) => {
              window.alert(error instanceof Error ? error.message : String(error));
              this.onshow();
            });
        });
      });
    });

    this.addSettingInput("apiKey", this.pluginInstance.credentialStatusDescription, "", async (value) => {
      await this.pluginInstance.updateSetting("apiKey", value.trim());
      this.onshow();
    }, "password");

    this.addSetting((setting: SettingItem) => {
      setting.addName("API key 管理");
      setting.addDescription("同时删除当前会话 key 和插件设置中已保存的 key。");
      setting.addButton((button) => {
        button.textContent = "删除 API key";
        button.addEventListener("click", () => void this.runSettingAction(button, () => this.pluginInstance.clearApiKey()));
      });
    });

    this.addSettingInput("model", "OpenAI 兼容模型名。", settings.model, async (value) => {
      await this.pluginInstance.updateSetting("model", value.trim());
    });

    this.addSettingInput("timeoutMs", "单次翻译请求超时，单位毫秒。", String(settings.timeoutMs), async (value) => {
      const parsed = Number(value);
      await this.pluginInstance.updateSetting("timeoutMs", Number.isFinite(parsed) && parsed > 0 ? parsed : 45000);
    });

    this.addSettingInput("paneWidthPercent", "右侧译文 pane 宽度百分比，范围 35-65。", String(settings.paneWidthPercent), async (value) => {
      const parsed = Number(value);
      await this.pluginInstance.updateSetting("paneWidthPercent", Number.isFinite(parsed) ? parsed : 50);
    });

    this.addSettingInput("toolbarDisplayMode", "右侧工具栏显示模式：compact 或 collapsed。", settings.toolbarDisplayMode, async (value) => {
      await this.pluginInstance.updateSetting("toolbarDisplayMode", value.trim() === "collapsed" ? "collapsed" : "compact");
    });

    this.addSetting((setting: SettingItem) => {
      setting.addName("翻译缓存");
      setting.addDescription((description) => {
        description.textContent = "正在统计缓存...";
        void this.pluginInstance
          .getCacheDescription()
          .then((value) => {
            description.textContent = value;
          })
          .catch((error) => {
            description.textContent = `缓存统计失败：${error instanceof Error ? error.message : String(error)}`;
          });
      });
      setting.addButton((button) => {
        button.textContent = "清理当前文档";
        button.addEventListener("click", () => void this.runSettingAction(button, () => this.pluginInstance.clearCurrentCache()));
      });
      setting.addButton((button) => {
        button.textContent = "清理全部缓存";
        button.addEventListener("click", () => {
          if (window.confirm("确定清理 Typora Side-by-Side Translator 的全部缓存译文和映射吗？已导出的译文文件不受影响。")) {
            void this.runSettingAction(button, () => this.pluginInstance.clearAllCaches());
          }
        });
      });
    });

    const diagnosticsPath = this.pluginInstance.diagnosticsLogPath;
    if (diagnosticsPath) {
      this.addSetting((setting: SettingItem) => {
        setting.addName("Diagnostics Log");
        setting.addDescription(diagnosticsPath);
        setting.addButton((button) => {
          button.textContent = "清理日志";
          button.addEventListener("click", () => void this.runSettingAction(button, () => this.pluginInstance.clearDiagnostics()));
        });
      });
    }
  }

  private async runSettingAction(button: HTMLButtonElement, action: () => Promise<void>): Promise<void> {
    button.disabled = true;
    try {
      await action();
      this.onshow();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    } finally {
      button.disabled = false;
    }
  }
}
