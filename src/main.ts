import {
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
import { PluginLocalizer } from "./i18n/PluginLocalizer";
import { UserFacingError } from "./i18n/UserFacingError";
import { normalizeUiLanguage, UI_LANGUAGES } from "./i18n/UiLanguage";
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
import { CredentialStorageMode, FileAssociationReason, PaneRenderState, PluginSettingsData, TargetLanguage, UiLanguage } from "./types";
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
  uiLanguage: "auto",
  credentialStorageMode: "session",
  storedApiKey: "",
  translationDisclosureAccepted: false,
  paneWidthPercent: 50,
  toolbarDisplayMode: "compact"
};

export default class TyporaSideBySideTranslatorPlugin extends Plugin<PluginSettingsData> {
  private readonly diagnostics = new PluginDiagnostics(this.app);
  private localizer!: PluginLocalizer;
  private paneController!: TranslationPaneController;
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
  private disposed = false;
  private contentChangeTimer: number | null = null;
  private refreshPromise: Promise<void> | null = null;
  private requestedRefreshRevision = 0;
  private completedRefreshRevision = 0;
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

  public override onload(): void {
    this.disposed = false;
    this.register(() => this.disposeRuntime());
    void this.initializePlugin();
  }

  public override onunload(): void {
    this.disposeRuntime();
  }

  private async initializePlugin(): Promise<void> {
    try {
      await this.diagnostics.attach(this.dataPath);
      if (this.disposed) {
        this.diagnostics.detach();
        return;
      }
      if (!this.manifest.dir) {
        throw new Error("Plugin installation directory is unavailable.");
      }
      this.localizer = new PluginLocalizer(corePath.join(this.manifest.dir, "locales"), this.getTyporaLocale());
      this.paneController = new TranslationPaneController(this.localizer);
      await this.diagnostics.info("plugin onload start", {
        manifestId: this.manifest.id,
        manifestVersion: this.manifest.version,
        dataPath: this.dataPath
      });
      await this.migrateLegacyPluginData();
      if (this.disposed) {
        return;
      }
      await this.initializeSettings();
      if (this.disposed) {
        return;
      }
      this.localizer.setLanguage(this.settingsStore.get("uiLanguage"));
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
        onTranslateAll: () => this.runBackground("translate all action failed", this.translateCurrentFile("full")),
        onRefreshStale: () => this.runBackground("refresh stale action failed", this.translateCurrentFile("stale")),
        onCancelTranslation: () => this.cancelCurrentTranslation(),
        onExportTarget: () => this.runBackground("export action failed", this.exportTargetFile()),
        onTargetLanguageChange: (targetLang) =>
          this.runBackground("target language update failed", this.updateSetting("targetLang", targetLang)),
        onJumpToSource: (blockId) => this.paneController.jumpToSource(blockId),
        onResize: (paneWidthPercent) =>
          this.runBackground("pane width update failed", this.updateSetting("paneWidthPercent", paneWidthPercent))
      });
      await this.refreshState();
      if (this.disposed) {
        return;
      }
      await this.diagnostics.info("initial refresh complete");
    } catch (error) {
      try {
        await this.diagnostics.error("failed to initialize plugin", this.errorMeta(error));
      } catch {
        // Console logging remains available if file diagnostics could not initialize.
      }
      console.error("[typora-side-by-side] failed to initialize", error);
      if (!this.disposed) {
        this.disposeRuntime();
        window.setTimeout(() => this.app.plugins.disablePlugin(this.manifest.id), 0);
      }
    }
  }

  private disposeRuntime(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.contentChangeTimer !== null) {
      window.clearTimeout(this.contentChangeTimer);
      this.contentChangeTimer = null;
    }
    this.translationTasks.cancelAll(this.localizer?.t.messages.pluginUnloaded ?? "Plugin unloaded");
    this.paneController?.destroy();
    this.diagnostics.detach();
  }

  public getRuntimeSettings(): PluginSettingsData {
    return {
      baseUrl: this.settingsStore.get("baseUrl"),
      apiKey: this.sessionCredentials.get(this.settingsStore.get("baseUrl")),
      model: this.settingsStore.get("model"),
      timeoutMs: this.settingsStore.get("timeoutMs"),
      targetLang: normalizeTargetLanguage(this.settingsStore.get("targetLang")),
      uiLanguage: normalizeUiLanguage(this.settingsStore.get("uiLanguage")),
      credentialStorageMode: this.normalizeCredentialStorageMode(this.settingsStore.get("credentialStorageMode")),
      storedApiKey: this.settingsStore.get("storedApiKey") || "",
      translationDisclosureAccepted: Boolean(this.settingsStore.get("translationDisclosureAccepted")),
      paneWidthPercent: this.normalizePaneWidth(this.settingsStore.get("paneWidthPercent")),
      toolbarDisplayMode: this.normalizeToolbarDisplayMode(this.settingsStore.get("toolbarDisplayMode"))
    };
  }

  public async updateSetting<K extends keyof PluginSettingsData>(key: K, value: PluginSettingsData[K]): Promise<void> {
    if (key === "storedApiKey") {
      throw new Error(this.localizer.t.messages.persistedApiKeyInternalOnly);
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
            : key === "uiLanguage"
              ? (normalizeUiLanguage(value) as PluginSettingsData[K])
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
      this.translationTasks.cancelAll(this.localizer.t.messages.targetLanguageChanged);
      await this.refreshState();
    }
    if (key === "uiLanguage") {
      this.localizer.setLanguage(nextValue);
      this.updateLocalizedCommandTitles();
      this.paneController.refreshLocalizedText();
      await this.refreshState();
    }
    await this.diagnostics.info("setting updated", {
      key,
      value: nextValue
    });
  }

  public get diagnosticsLogPath(): string | null {
    return this.diagnostics.getLogPath();
  }

  public get pluginVersion(): string {
    return this.manifest.version;
  }

  public get ui(): PluginLocalizer {
    return this.localizer;
  }

  public formatUserError(error: unknown): string {
    if (error instanceof UserFacingError) {
      return this.localizer.format(this.localizer.t.errors[error.code], error.values);
    }
    return this.localizer.t.errors.unknown;
  }

  public get credentialStatusDescription(): string {
    const settings = this.getRuntimeSettings();
    if (!settings.apiKey) {
      return settings.credentialStorageMode === "plugin-settings"
        ? this.localizer.t.settings.credentialPlaintextEmpty
        : this.localizer.t.settings.credentialSessionEmpty;
    }
    return settings.credentialStorageMode === "plugin-settings" && !!settings.storedApiKey
      ? this.localizer.t.settings.credentialPlaintextSaved
      : this.localizer.t.settings.credentialSessionActive;
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
    return this.localizer.format(this.localizer.t.settings.cacheDescription, {
      path: this.cacheMaintenance.rootPath,
      count: usage.fileCount,
      size: this.formatBytes(usage.byteCount)
    });
  }

  public async clearCurrentCache(): Promise<void> {
    const association = this.getCurrentAssociation();
    if (!association.isSupportedSource) {
      throw new Error(this.getAssociationReason(association.reason, this.localizer.t.messages.cacheUnsupported));
    }

    await this.cacheMaintenance.clearAssociation(association);
    await this.diagnostics.info("current translation cache cleared", { sourcePath: association.sourcePath });
    await this.refreshState();
    this.renderState.infoMessage = this.localizer.t.messages.currentCacheCleared;
    this.renderState.warningMessage = undefined;
    this.renderState.errorMessage = undefined;
    this.paneController.render(this.renderState);
  }

  public async clearAllCaches(): Promise<void> {
    await this.cacheMaintenance.clearAll();
    await this.diagnostics.info("all translation caches cleared");
    await this.refreshState();
    this.renderState.infoMessage = this.localizer.t.messages.allCachesCleared;
    this.renderState.warningMessage = undefined;
    this.renderState.errorMessage = undefined;
    this.paneController.render(this.renderState);
  }

  public async clearDiagnostics(): Promise<void> {
    await this.diagnostics.clear();
  }

  public async eraseAllLocalData(): Promise<void> {
    const dataDirectory = corePath.dirname(this.dataPath);
    const logPath = this.diagnostics.getLogPath();
    const logDirectory = logPath ? corePath.dirname(logPath) : corePath.join(dataDirectory, "logs");
    const pathsToRemove = [
      this.dataPath,
      corePath.join(dataDirectory, PLUGIN_DATA_DIRECTORY),
      ...LEGACY_PLUGIN_IDS.map((pluginId) => corePath.join(dataDirectory, `${pluginId}.json`)),
      corePath.join(dataDirectory, "eleef.typora-side-by-side-translation"),
      corePath.join(dataDirectory, "translations"),
      ...[
        "typora-side-by-side-translation.log",
        "typora-side-by-side-translation.1.log",
        "typora-bilingual.log",
        "typora-bilingual.1.log"
      ].map((filename) => corePath.join(logDirectory, filename))
    ];

    this.translationTasks.cancelAll(this.localizer.t.messages.pluginUnloaded);
    this.sessionCredentials.clear();
    await this.cacheMaintenance.eraseAll();
    await this.diagnostics.clear();
    this.app.plugins.disablePlugin(this.manifest.id);
    for (const targetPath of pathsToRemove) {
      if (await fs.exists(targetPath)) {
        await fs.remove(targetPath);
      }
    }
  }

  private async initializeSettings(): Promise<void> {
    this.settingsStore = new PluginSettings<PluginSettingsData>(this.app, this.manifest, { version: 1 });
    this.settingsStore.setDefault(DEFAULT_SETTINGS);
    this.settingsStore.load();
    this.settingsStore.set("targetLang", normalizeTargetLanguage(this.settingsStore.get("targetLang")));
    this.settingsStore.set("uiLanguage", normalizeUiLanguage(this.settingsStore.get("uiLanguage")));
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

  private confirmTranslationDisclosure(): boolean {
    if (this.settingsStore.get("translationDisclosureAccepted")) {
      return true;
    }
    const endpoint = describeEndpointForDiagnostics(this.getRuntimeSettings().baseUrl);
    const accepted = window.confirm(
      this.localizer.format(this.localizer.t.messages.translationDisclosure, { endpoint })
    );
    if (accepted) {
      this.settingsStore.set("translationDisclosureAccepted", true);
      this.settingsStore.save();
      void this.diagnostics.info("translation disclosure accepted", { endpoint });
    }
    return accepted;
  }

  private registerPluginCommands(): void {
    const commands = this.localizer.t.commands;
    this.registerCommand({
      id: "typora-side-by-side-translator.toggle-pane",
      title: commands.togglePane,
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
      title: commands.translateCurrentFile,
      scope: "global",
      showInCommandPanel: true,
      callback: () => this.runBackground("translate command failed", this.translateCurrentFile("full"))
    });

    this.registerCommand({
      id: "typora-side-by-side-translator.refresh-stale-blocks",
      title: commands.refreshStaleBlocks,
      scope: "global",
      showInCommandPanel: true,
      callback: () => this.runBackground("refresh command failed", this.translateCurrentFile("stale"))
    });

    this.registerCommand({
      id: "typora-side-by-side-translator.export-target-file",
      title: commands.exportTargetFile,
      scope: "global",
      showInCommandPanel: true,
      callback: () => this.runBackground("export command failed", this.exportTargetFile())
    });

    this.registerCommand({
      id: "typora-side-by-side-translator.cancel-translation",
      title: commands.cancelTranslation,
      scope: "global",
      showInCommandPanel: true,
      callback: () => this.cancelCurrentTranslation()
    });
  }

  private updateLocalizedCommandTitles(): void {
    const titles: Record<string, string> = {
      "typora-side-by-side-translator.toggle-pane": this.localizer.t.commands.togglePane,
      "typora-side-by-side-translator.translate-current-file": this.localizer.t.commands.translateCurrentFile,
      "typora-side-by-side-translator.refresh-stale-blocks": this.localizer.t.commands.refreshStaleBlocks,
      "typora-side-by-side-translator.export-target-file": this.localizer.t.commands.exportTargetFile,
      "typora-side-by-side-translator.cancel-translation": this.localizer.t.commands.cancelTranslation
    };
    for (const [id, title] of Object.entries(titles)) {
      const command = this.app.commands.commandMap[`${this.manifest.id}:${id}`];
      if (command) {
        command.title = title;
      }
    }
  }

  private registerWorkspaceEvents(): void {
    this.register(
      this.app.workspace.on("file:open", () => {
        this.runBackground("file open refresh failed", this.refreshState());
      })
    );
    this.register(
      this.app.workspace.on("file:will-open", () => {
        this.translationTasks.cancelAll(this.localizer.t.messages.fileChanged);
        this.runBackground("file switch refresh failed", this.refreshState());
      })
    );
  }

  private registerEditorEvents(): void {
    const editor = this.app.features.markdownEditor;
    this.register(
      editor.on("load", () => {
        this.runBackground("editor load refresh failed", this.refreshState());
      })
    );
    this.register(
      editor.on("edit", () => {
        if (this.contentChangeTimer) {
          window.clearTimeout(this.contentChangeTimer);
        }
        this.contentChangeTimer = window.setTimeout(
          () => this.runBackground("editor change refresh failed", this.refreshState()),
          400
        );
      })
    );
  }

  private async refreshState(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.requestedRefreshRevision += 1;
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = (async () => {
      while (!this.disposed && this.completedRefreshRevision < this.requestedRefreshRevision) {
        const revision = this.requestedRefreshRevision;
        await this.doRefreshState(revision);
        this.completedRefreshRevision = revision;
      }
    })().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private runBackground(message: string, task: Promise<void>): void {
    void task.catch(async (error) => {
      await this.diagnostics.error(message, this.errorMeta(error));
      if (this.disposed) {
        return;
      }
      this.paneVisible = true;
      this.renderState = {
        ...this.renderState,
        isVisible: true,
        isTranslating: false,
        warningMessage: undefined,
        infoMessage: undefined,
        errorMessage: this.formatUserError(error)
      };
      this.paneController.render(this.renderState);
    });
  }

  private async doRefreshState(revision: number): Promise<void> {
    if (this.disposed) {
      return;
    }
    const association = this.getCurrentAssociation();
    const runtime = this.getRuntimeSettings();
    const paneWidthPercent = runtime.paneWidthPercent;

    if (!association.isSupportedSource) {
      if (!this.isRefreshCurrent(revision, association)) {
        return;
      }
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

    await this.migrateLegacyAssociationCache(association);
    const sourceMarkdown = await this.readCurrentMarkdown(association.sourcePath);
    const state = await this.translator.computeStaleState(association, sourceMarkdown);
    if (!this.isRefreshCurrent(revision, association)) {
      return;
    }
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
      warningMessage:
        state.staleCount > 0 && !!state.targetMarkdown ? this.localizer.t.messages.sourceUpdated : undefined,
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
        errorMessage: this.getAssociationReason(association.reason)
      };
      this.paneVisible = true;
      this.paneController.render(this.renderState);
      return;
    }

    const runtimeSettings = this.getRuntimeSettings();
    if (
      runtimeSettings.baseUrl &&
      runtimeSettings.apiKey &&
      runtimeSettings.model &&
      !this.confirmTranslationDisclosure()
    ) {
      return;
    }
    await this.migrateLegacyAssociationCache(association);
    if (this.translationTasks.isRunning(association.cacheTargetPath)) {
      this.renderState = {
        ...this.renderState,
        association,
        isVisible: true,
        warningMessage: this.localizer.t.messages.taskAlreadyRunning
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
      warningMessage:
        mode === "stale" ? this.localizer.t.messages.refreshingStale : this.localizer.t.messages.generatingTranslation
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
        infoMessage:
          staleCount === 0
            ? this.localizer.format(this.localizer.t.messages.cacheUpdated, { path: association.cacheTargetPath })
            : undefined,
        warningMessage:
          staleCount > 0
            ? this.localizer.format(this.localizer.t.messages.manualBlocksPreserved, { count: staleCount })
            : undefined,
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
        infoMessage: isTranslationCancelled(error) ? this.localizer.t.messages.translationCancelled : undefined,
        errorMessage: isTranslationCancelled(error) ? undefined : this.formatUserError(error)
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
      warningMessage: this.localizer.t.messages.cancellingTranslation,
      errorMessage: undefined
    };
    this.paneController.render(this.renderState);
  }

  private async exportTargetFile(): Promise<void> {
    const association = this.getCurrentAssociation();
    if (!association.isSupportedSource) {
      return;
    }

    await this.migrateLegacyAssociationCache(association);
    const exists = await fs.exists(association.cacheTargetPath);
    if (!exists) {
      this.renderState = {
        ...this.renderState,
        association,
        isVisible: true,
        errorMessage: this.localizer.t.messages.exportRequiresTranslation
      };
      this.paneVisible = true;
      this.paneController.render(this.renderState);
      return;
    }

    const exportExists = await fs.exists(association.exportTargetPath);
    if (exportExists) {
      const confirmed = window.confirm(
        this.localizer.format(this.localizer.t.messages.confirmOverwriteExport, { path: association.exportTargetPath })
      );
      if (!confirmed) {
        this.renderState = {
          ...this.renderState,
          association,
          isVisible: true,
          errorMessage: undefined,
          infoMessage: this.localizer.t.messages.exportCancelled
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
        infoMessage: this.localizer.format(this.localizer.t.messages.exported, { path: association.exportTargetPath })
      };
    } catch (error) {
      await this.diagnostics.error("export target file failed", this.errorMeta(error));
      this.renderState = {
        ...this.renderState,
        association,
        isVisible: true,
        warningMessage: undefined,
        infoMessage: undefined,
        errorMessage: this.formatUserError(error)
      };
    }
    this.paneController.render(this.renderState);
  }

  private getCurrentAssociation() {
    const activePath = this.app.workspace.activeFile;
    const normalized = activePath ? activePath.replace(/\//g, corePath.sep) : null;
    return this.associationService.resolve(normalized, this.getRuntimeSettings().targetLang);
  }

  private async migrateLegacyAssociationCache(association: ReturnType<FileAssociationService["resolve"]>): Promise<void> {
    const pairs: Array<[string | undefined, string]> = [
      [association.legacyCacheTargetPath, association.cacheTargetPath],
      [association.legacyCacheMapPath, association.cacheMapPath]
    ];
    for (const [legacyPath, currentPath] of pairs) {
      if (!legacyPath || legacyPath === currentPath || !(await fs.exists(legacyPath)) || (await fs.exists(currentPath))) {
        continue;
      }
      await fs.mkdir(corePath.dirname(currentPath));
      await fs.move(legacyPath, currentPath);
      await this.diagnostics.info("legacy document cache migrated", { legacyPath, currentPath });
    }
  }

  private isSameAssociation(
    left: { sourcePath: string; cacheTargetPath: string },
    right: { sourcePath: string; cacheTargetPath: string }
  ): boolean {
    return left.sourcePath === right.sourcePath && left.cacheTargetPath === right.cacheTargetPath;
  }

  private isRefreshCurrent(
    revision: number,
    association: { sourcePath: string; cacheTargetPath: string }
  ): boolean {
    return (
      !this.disposed &&
      revision === this.requestedRefreshRevision &&
      this.isSameAssociation(this.getCurrentAssociation(), association)
    );
  }

  private async readCurrentMarkdown(sourcePath: string): Promise<string> {
    const exists = await fs.exists(sourcePath);
    if (!exists) {
      await this.diagnostics.warn("active source file not found", { sourcePath });
      throw new Error(this.localizer.t.messages.sourceFileMissing);
    }
    return fs.readText(sourcePath);
  }

  private extractTranslatedBlocks(markdown: string | null): Map<string, string> {
    return this.translator.parseCachedTranslations(markdown);
  }

  private getTranslationsCacheRoot(): string {
    return corePath.join(corePath.dirname(this.dataPath), PLUGIN_DATA_DIRECTORY, "translations");
  }

  private getTyporaLocale(): unknown {
    const typoraOptions = (globalThis as typeof globalThis & {
      _options?: { appLocale?: unknown; locale?: unknown };
    })._options;
    return (
      typoraOptions?.appLocale ??
      typoraOptions?.locale ??
      this.app.settings.get("displayLang") ??
      this.app.i18n.locale
    );
  }

  private getAssociationReason(reason?: FileAssociationReason, fallback?: string): string {
    if (reason === "no-saved-markdown") {
      return this.localizer.t.pane.noSavedMarkdown;
    }
    if (reason === "markdown-only") {
      return this.localizer.t.pane.markdownOnly;
    }
    return fallback ?? this.localizer.t.pane.unsupportedFile;
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
      uiLanguage: settings.uiLanguage,
      resolvedUiLocale: this.localizer.locale,
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
    return this.pluginInstance.ui.t.settings.title;
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
            input.setCustomValidity(this.pluginInstance.formatUserError(error));
            input.reportValidity();
          });
        });
      });
    });
  }

  public onshow(): void {
    this.containerEl.innerHTML = "";
    const ui = this.pluginInstance.ui;
    const t = ui.t.settings;
    this.addSettingTitle(t.title);

    this.addSetting((setting: SettingItem) => {
      setting.addName(t.version);
      setting.addDescription(ui.format(t.currentVersion, { version: this.pluginInstance.pluginVersion }));
    });

    const settings = this.pluginInstance.getRuntimeSettings();
    this.addSetting((setting: SettingItem) => {
      setting.addName(t.uiLanguage);
      setting.addDescription(t.uiLanguageDescription);
      setting.addSelect((select) => {
        for (const language of UI_LANGUAGES) {
          const option = document.createElement("option");
          option.value = language;
          option.textContent = ui.uiLanguageLabel(language);
          select.appendChild(option);
        }
        select.value = settings.uiLanguage;
        select.addEventListener("change", () => {
          void this.pluginInstance
            .updateSetting("uiLanguage", select.value as UiLanguage)
            .then(() => this.onshow())
            .catch((error) => {
              window.alert(this.pluginInstance.formatUserError(error));
              this.onshow();
            });
        });
      });
    });

    this.addSetting((setting: SettingItem) => {
      setting.addName(t.targetLanguage);
      setting.addDescription(t.targetLanguageDescription);
      setting.addSelect((select) => {
        for (const language of TARGET_LANGUAGES) {
          const option = document.createElement("option");
          option.value = language.code;
          option.textContent = ui.targetLanguageLabel(language.code);
          select.appendChild(option);
        }
        select.value = settings.targetLang;
        select.addEventListener("change", () => {
          void this.pluginInstance
            .updateSetting("targetLang", select.value as TargetLanguage)
            .then(() => this.onshow())
            .catch((error) => {
              window.alert(this.pluginInstance.formatUserError(error));
              this.onshow();
            });
        });
      });
    });

    this.addSettingInput(t.baseUrl, t.baseUrlDescription, settings.baseUrl, async (value) => {
      await this.pluginInstance.updateSetting("baseUrl", value.trim());
      this.onshow();
    });

    this.addSetting((setting: SettingItem) => {
      setting.addName(t.credentialStorageMode);
      setting.addDescription(t.credentialStorageDescription);
      setting.addSelect((select) => {
        const options: Array<[CredentialStorageMode, string]> = [
          ["session", t.credentialSession],
          ["plugin-settings", t.credentialPluginSettings]
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
              window.alert(this.pluginInstance.formatUserError(error));
              this.onshow();
            });
        });
      });
    });

    this.addSettingInput(t.apiKey, this.pluginInstance.credentialStatusDescription, "", async (value) => {
      await this.pluginInstance.updateSetting("apiKey", value.trim());
      this.onshow();
    }, "password");

    this.addSetting((setting: SettingItem) => {
      setting.addName(t.apiKeyManagement);
      setting.addDescription(t.apiKeyManagementDescription);
      setting.addButton((button) => {
        button.textContent = t.deleteApiKey;
        button.addEventListener("click", () => void this.runSettingAction(button, () => this.pluginInstance.clearApiKey()));
      });
    });

    this.addSettingInput(t.model, t.modelDescription, settings.model, async (value) => {
      await this.pluginInstance.updateSetting("model", value.trim());
    });

    this.addSettingInput(t.timeout, t.timeoutDescription, String(settings.timeoutMs), async (value) => {
      const parsed = Number(value);
      await this.pluginInstance.updateSetting("timeoutMs", Number.isFinite(parsed) && parsed > 0 ? parsed : 45000);
    });

    this.addSettingInput(t.paneWidth, t.paneWidthDescription, String(settings.paneWidthPercent), async (value) => {
      const parsed = Number(value);
      await this.pluginInstance.updateSetting("paneWidthPercent", Number.isFinite(parsed) ? parsed : 50);
    });

    this.addSetting((setting: SettingItem) => {
      setting.addName(t.toolbarMode);
      setting.addDescription(t.toolbarModeDescription);
      setting.addSelect((select) => {
        const options: Array<["compact" | "collapsed", string]> = [
          ["compact", t.toolbarCompact],
          ["collapsed", t.toolbarCollapsed]
        ];
        for (const [value, label] of options) {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = label;
          select.appendChild(option);
        }
        select.value = settings.toolbarDisplayMode;
        select.addEventListener("change", () => {
          void this.pluginInstance.updateSetting(
            "toolbarDisplayMode",
            select.value === "collapsed" ? "collapsed" : "compact"
          );
        });
      });
    });

    this.addSetting((setting: SettingItem) => {
      setting.addName(t.translationCache);
      setting.addDescription((description) => {
        description.textContent = t.calculatingCache;
        void this.pluginInstance
          .getCacheDescription()
          .then((value) => {
            description.textContent = value;
          })
          .catch((error) => {
            description.textContent = ui.format(t.cacheCalculationFailed, {
              error: this.pluginInstance.formatUserError(error)
            });
          });
      });
      setting.addButton((button) => {
        button.textContent = t.clearCurrentDocument;
        button.addEventListener("click", () => {
          if (window.confirm(t.confirmClearCurrentDocument)) {
            void this.runSettingAction(button, () => this.pluginInstance.clearCurrentCache());
          }
        });
      });
      setting.addButton((button) => {
        button.textContent = t.clearAllCaches;
        button.addEventListener("click", () => {
          if (window.confirm(t.confirmClearAllCaches)) {
            void this.runSettingAction(button, () => this.pluginInstance.clearAllCaches());
          }
        });
      });
    });

    const diagnosticsPath = this.pluginInstance.diagnosticsLogPath;
    if (diagnosticsPath) {
      this.addSetting((setting: SettingItem) => {
        setting.addName(t.diagnosticsLog);
        setting.addDescription(diagnosticsPath);
        setting.addButton((button) => {
          button.textContent = t.clearLog;
          button.addEventListener("click", () => void this.runSettingAction(button, () => this.pluginInstance.clearDiagnostics()));
        });
      });
    }

    this.addSetting((setting: SettingItem) => {
      setting.addName(t.eraseLocalData);
      setting.addDescription(t.eraseLocalDataDescription);
      setting.addButton((button) => {
        button.textContent = t.eraseLocalData;
        button.addEventListener("click", () => {
          if (!window.confirm(t.confirmEraseLocalData)) {
            return;
          }
          button.disabled = true;
          void this.pluginInstance.eraseAllLocalData().catch((error) => {
            button.disabled = false;
            window.alert(this.pluginInstance.formatUserError(error));
          });
        });
      });
    });
  }

  private async runSettingAction(button: HTMLButtonElement, action: () => Promise<void>): Promise<void> {
    button.disabled = true;
    try {
      await action();
      this.onshow();
    } catch (error) {
      window.alert(this.pluginInstance.formatUserError(error));
    } finally {
      button.disabled = false;
    }
  }
}
