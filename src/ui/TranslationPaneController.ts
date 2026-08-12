import MarkdownIt from "markdown-it";
import { PluginLocalizer } from "../i18n/PluginLocalizer";
import { AnchorMappingService } from "../sync/AnchorMappingService";
import { ScrollSyncService } from "../sync/ScrollSyncService";
import { FileAssociationReason, PaneRenderState, TargetLanguage, TranslationBlock, TranslationBlockType } from "../types";
import { TARGET_LANGUAGES } from "../translation/TargetLanguage";
import { createTranslationHtmlSanitizer } from "./TranslationHtmlSanitizer";

interface PaneActions {
  onTranslateAll: () => void;
  onRefreshStale: () => void;
  onCancelTranslation: () => void;
  onExportTarget: () => void;
  onTargetLanguageChange: (targetLang: TargetLanguage) => void;
  onJumpToSource: (blockId: string) => void;
  onResize: (paneWidthPercent: number) => void;
}

type StatusBadgeKind = "idle" | "cached" | "stale" | "error";
type ToolbarDisplayMode = "compact" | "collapsed";
type PrimaryAction = "translate-all" | "refresh-stale" | "cancel-translation";

export class TranslationPaneController {
  private readonly markdown = new MarkdownIt({ html: false, linkify: true, breaks: false });
  private readonly sanitizeHtml = createTranslationHtmlSanitizer(window);
  private readonly anchorMapping = new AnchorMappingService();
  private readonly scrollSync = new ScrollSyncService();
  private readonly sourceBlockSelector = "h1, h2, h3, h4, h5, h6, p, li, blockquote, table";
  private host: HTMLDivElement | null = null;
  private pane: HTMLDivElement | null = null;
  private paneBody: HTMLDivElement | null = null;
  private statusBadgeEl: HTMLDivElement | null = null;
  private messageEl: HTMLDivElement | null = null;
  private overlayEl: HTMLDivElement | null = null;
  private sourceContainer: HTMLElement | null = null;
  private scrollRoot: HTMLElement | Window = window;
  private activeBlockId: string | null = null;
  private resizeHandle: HTMLDivElement | null = null;
  private actions: PaneActions | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private windowResizeHandler: (() => void) | null = null;
  private layoutSyncFrame: number | null = null;
  private toolbarExpanded = false;
  private toolbarCollapseTimer: number | null = null;
  private moreMenuOpen = false;
  private primaryAction: PrimaryAction | null = null;
  private lastState: PaneRenderState | null = null;
  private currentPaneWidth = 50;
  private originalParent: HTMLElement | null = null;
  private originalNextSibling: ChildNode | null = null;
  private resizeDragCleanup: (() => void) | null = null;
  private documentMouseDownHandler: ((event: MouseEvent) => void) | null = null;
  private documentKeyDownHandler: ((event: KeyboardEvent) => void) | null = null;

  public constructor(private readonly localizer: PluginLocalizer) {}

  public refreshLocalizedText(): void {
    if (!this.pane || !this.resizeHandle) {
      return;
    }
    const { pane } = this.localizer.t;
    this.resizeHandle.title = pane.resizeHandle;
    const labels: Array<[string, string]> = [
      ['[data-action="translate-all"]', pane.retranslateAll],
      ['[data-action="export-target"]', pane.exportTarget],
      ['[data-action="toggle-more"]', pane.moreActions]
    ];
    for (const [selector, label] of labels) {
      const button = this.pane.querySelector<HTMLButtonElement>(selector);
      if (button) {
        button.textContent = label;
      }
    }
    const collapsedToggle = this.pane.querySelector<HTMLButtonElement>('[data-action="toggle-toolbar"]');
    collapsedToggle?.setAttribute("aria-label", pane.openToolbar);
    const layoutLabel = this.pane.querySelector<HTMLElement>(".typora-bilingual-pane__layout-cascade .typora-bilingual-pane__cascade-trigger");
    if (layoutLabel) {
      layoutLabel.textContent = pane.layout;
    }
    const languageTrigger = this.pane.querySelector<HTMLButtonElement>(".typora-bilingual-pane__language-cascade .typora-bilingual-pane__cascade-trigger");
    if (languageTrigger) {
      languageTrigger.textContent = pane.targetLanguage;
    }
    const languageSelect = this.pane.querySelector<HTMLSelectElement>('[data-action="target-language"]');
    languageSelect?.setAttribute("aria-label", pane.targetLanguage);
    for (const option of Array.from(languageSelect?.options ?? [])) {
      const language = option.value as TargetLanguage;
      option.textContent = this.localizer.targetLanguageShortLabel(language);
      option.title = this.localizer.targetLanguageLabel(language);
    }
    for (const button of Array.from(this.pane.querySelectorAll<HTMLButtonElement>("[data-target-language]"))) {
      const language = button.dataset.targetLanguage as TargetLanguage;
      button.textContent = this.localizer.targetLanguageShortLabel(language);
      button.title = this.localizer.targetLanguageLabel(language);
      button.setAttribute("aria-label", this.localizer.targetLanguageLabel(language));
    }
    this.refreshPresetLabels();
    if (this.lastState) {
      this.renderControls(this.lastState);
    }
  }

  public ensureMounted(actions: PaneActions): void {
    if (this.host) {
      this.actions = actions;
      return;
    }

    const source = this.findSourceContainer();
    if (!source || !source.parentElement) {
      throw new Error(this.localizer.t.pane.mountFailed);
    }

    this.actions = actions;
    const originalParent = source.parentElement;
    const originalNextSibling = source.nextSibling;
    const host = document.createElement("div");
    host.className = "typora-bilingual-host is-pane-hidden";
    const sourceWrapper = document.createElement("div");
    sourceWrapper.className = "typora-bilingual-source";
    originalParent.insertBefore(host, source);
    sourceWrapper.appendChild(source);
    host.appendChild(sourceWrapper);
    this.host = host;
    this.sourceContainer = source;
    this.originalParent = originalParent;
    this.originalNextSibling = originalNextSibling;

    const resizeHandle = document.createElement("div");
    resizeHandle.className = "typora-bilingual-resizer";
    resizeHandle.setAttribute("role", "separator");
    resizeHandle.setAttribute("tabindex", "0");
    resizeHandle.setAttribute("aria-orientation", "vertical");
    resizeHandle.setAttribute("aria-valuemin", "35");
    resizeHandle.setAttribute("aria-valuemax", "65");
    resizeHandle.setAttribute("aria-valuenow", "50");
    host.appendChild(resizeHandle);

    const pane = document.createElement("div");
    pane.className = "typora-bilingual-pane is-hidden";
    pane.innerHTML = [
      '<div class="typora-bilingual-pane__overlay">',
      '  <button class="typora-bilingual-pane__collapsed-toggle" data-action="toggle-toolbar" type="button"></button>',
      '  <div class="typora-bilingual-pane__toolbar">',
      '      <div class="typora-bilingual-pane__summary">',
      '        <select class="typora-bilingual-pane__language" data-action="target-language">',
      ...TARGET_LANGUAGES.map((language) => `          <option value="${language.code}"></option>`),
      "        </select>",
      '        <div class="typora-bilingual-pane__status-badge" data-kind="idle" role="status" aria-live="polite"></div>',
      "      </div>",
      '      <button class="typora-bilingual-pane__button typora-bilingual-pane__primary is-hidden" data-action="primary" type="button"></button>',
      '      <div class="typora-bilingual-pane__more">',
      '        <button class="typora-bilingual-pane__more-toggle" data-action="toggle-more" type="button" aria-haspopup="menu" aria-expanded="false"></button>',
      '        <div class="typora-bilingual-pane__menu is-hidden" role="menu">',
      '          <div class="typora-bilingual-pane__cascade typora-bilingual-pane__language-cascade">',
      '            <button class="typora-bilingual-pane__cascade-trigger" type="button"></button>',
      '            <div class="typora-bilingual-pane__cascade-options typora-bilingual-pane__language-options">',
      ...TARGET_LANGUAGES.map(
        (language) =>
          `              <button class="typora-bilingual-pane__cascade-option" data-target-language="${language.code}" type="button"></button>`
      ),
      "            </div>",
      "          </div>",
      '          <button class="typora-bilingual-pane__menu-item" data-action="export-target" type="button" role="menuitem"></button>',
      '          <button class="typora-bilingual-pane__menu-item" data-action="translate-all" type="button" role="menuitem"></button>',
      '          <div class="typora-bilingual-pane__menu-separator"></div>',
      '          <div class="typora-bilingual-pane__cascade typora-bilingual-pane__layout-cascade">',
      '            <button class="typora-bilingual-pane__cascade-trigger typora-bilingual-pane__menu-label" type="button"></button>',
      '            <div class="typora-bilingual-pane__cascade-options typora-bilingual-pane__presets">',
      '              <button class="typora-bilingual-pane__preset" data-preset="60" type="button">40/60</button>',
      '              <button class="typora-bilingual-pane__preset" data-preset="50" type="button">50/50</button>',
      '              <button class="typora-bilingual-pane__preset" data-preset="40" type="button">60/40</button>',
      "            </div>",
      "          </div>",
      "        </div>",
      "      </div>",
      "  </div>",
      '  <div class="typora-bilingual-pane__message is-hidden" role="alert" aria-live="assertive"></div>',
      "</div>",
      '<div class="typora-bilingual-pane__body"></div>'
    ].join("");

    const overlayEl = pane.querySelector<HTMLDivElement>(".typora-bilingual-pane__overlay");
    const statusBadgeEl = pane.querySelector<HTMLDivElement>(".typora-bilingual-pane__status-badge");
    const messageEl = pane.querySelector<HTMLDivElement>(".typora-bilingual-pane__message");
    const paneBody = pane.querySelector<HTMLDivElement>(".typora-bilingual-pane__body");
    if (!overlayEl || !statusBadgeEl || !messageEl || !paneBody) {
      throw new Error(this.localizer.t.pane.initializeFailed);
    }

    pane.addEventListener("change", (event) => {
      const select = event.target as HTMLSelectElement;
      if (select.dataset.action === "target-language") {
        this.closeAfterAction();
        actions.onTargetLanguageChange(select.value as TargetLanguage);
      }
    });

    pane.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;
      const action = target.closest<HTMLElement>("[data-action]")?.dataset.action;
      if (action === "primary") {
        this.invokePrimaryAction();
        return;
      }
      if (action === "translate-all") {
        this.closeAfterAction();
        actions.onTranslateAll();
        return;
      }
      if (action === "export-target") {
        this.closeAfterAction();
        actions.onExportTarget();
        return;
      }

      if (action === "toggle-toolbar") {
        if (this.toolbarExpanded) {
          this.closeTransientControls();
        } else {
          this.openCollapsedToolbar();
        }
        return;
      }
      if (action === "toggle-more") {
        this.moreMenuOpen = !this.moreMenuOpen;
        this.syncMoreMenu();
        return;
      }

      const targetLanguage = target.closest<HTMLElement>("[data-target-language]")?.dataset.targetLanguage;
      if (targetLanguage) {
        this.closeAfterAction();
        actions.onTargetLanguageChange(targetLanguage as TargetLanguage);
        return;
      }

      const preset = target.closest<HTMLElement>("[data-preset]")?.dataset.preset;
      if (preset) {
        const nextWidth = Number.parseInt(preset, 10);
        if (Number.isFinite(nextWidth)) {
          this.applyPaneWidth(nextWidth, true);
        }
        this.closeMoreMenu();
        return;
      }

      const blockEl = target.closest<HTMLElement>("[data-block-id]");
      const blockId = blockEl?.dataset.blockId;
      if (blockId) {
        actions.onJumpToSource(blockId);
      }
    });

    const collapsedToggle = pane.querySelector<HTMLButtonElement>('[data-action="toggle-toolbar"]');
    const toolbar = pane.querySelector<HTMLDivElement>(".typora-bilingual-pane__toolbar");
    collapsedToggle?.addEventListener("mouseenter", () => this.openCollapsedToolbar());
    collapsedToggle?.addEventListener("mouseleave", () => this.scheduleCollapsedToolbarClose());
    toolbar?.addEventListener("mouseenter", () => this.openCollapsedToolbar());
    toolbar?.addEventListener("mouseleave", () => this.scheduleCollapsedToolbarClose());
    overlayEl.addEventListener("focusin", () => this.openCollapsedToolbar());
    overlayEl.addEventListener("focusout", (event) => {
      if (!overlayEl.contains(event.relatedTarget as Node | null)) {
        this.scheduleCollapsedToolbarClose();
      }
    });

    this.documentMouseDownHandler = (event) => {
      if (this.overlayEl && !this.overlayEl.contains(event.target as Node)) {
        this.closeTransientControls();
      }
    };
    this.documentKeyDownHandler = (event) => {
      if (event.key === "Escape") {
        this.closeTransientControls();
      }
    };
    document.addEventListener("mousedown", this.documentMouseDownHandler);
    document.addEventListener("keydown", this.documentKeyDownHandler);

    this.bindResize(resizeHandle);

    host.appendChild(pane);
    this.pane = pane;
    this.paneBody = paneBody;
    this.statusBadgeEl = statusBadgeEl;
    this.messageEl = messageEl;
    this.overlayEl = overlayEl;
    this.scrollRoot = this.findScrollRoot(source);
    this.resizeHandle = resizeHandle;
    this.refreshLocalizedText();
    this.bindSharedResizeObservers();
  }

  public destroy(): void {
    this.scrollSync.unbind();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.windowResizeHandler) {
      window.removeEventListener("resize", this.windowResizeHandler);
      this.windowResizeHandler = null;
    }
    if (this.layoutSyncFrame !== null) {
      window.cancelAnimationFrame(this.layoutSyncFrame);
      this.layoutSyncFrame = null;
    }
    this.resizeDragCleanup?.();
    this.resizeDragCleanup = null;
    this.clearToolbarCollapseTimer();
    if (this.documentMouseDownHandler) {
      document.removeEventListener("mousedown", this.documentMouseDownHandler);
      this.documentMouseDownHandler = null;
    }
    if (this.documentKeyDownHandler) {
      document.removeEventListener("keydown", this.documentKeyDownHandler);
      this.documentKeyDownHandler = null;
    }

    const source = this.sourceContainer;
    const originalParent = this.originalParent;
    if (source && originalParent) {
      const nextSibling = this.originalNextSibling;
      if (nextSibling?.parentNode === originalParent) {
        originalParent.insertBefore(source, nextSibling);
      } else {
        originalParent.appendChild(source);
      }
    }
    this.host?.remove();

    this.host = null;
    this.pane = null;
    this.paneBody = null;
    this.statusBadgeEl = null;
    this.messageEl = null;
    this.overlayEl = null;
    this.sourceContainer = null;
    this.originalParent = null;
    this.originalNextSibling = null;
    this.resizeHandle = null;
    this.actions = null;
    this.activeBlockId = null;
    this.toolbarExpanded = false;
    this.moreMenuOpen = false;
    this.primaryAction = null;
    this.lastState = null;
    this.scrollRoot = window;
  }

  public render(state: PaneRenderState): void {
    if (!this.pane || !this.paneBody || !this.statusBadgeEl || !this.messageEl || !this.host) {
      return;
    }

    this.host.style.setProperty("--typora-bilingual-pane-width", `${state.paneWidthPercent}%`);
    this.currentPaneWidth = state.paneWidthPercent;
    this.resizeHandle?.setAttribute("aria-valuenow", String(state.paneWidthPercent));
    this.host.classList.toggle("is-pane-hidden", !state.isVisible);
    this.pane.classList.toggle("is-hidden", !state.isVisible);
    if (!state.isVisible) {
      this.closeTransientControls();
      return;
    }

    this.lastState = state;
    const previousToolbarMode = this.pane.dataset.toolbarMode as ToolbarDisplayMode | undefined;
    this.pane.dataset.toolbarMode = state.toolbarDisplayMode;
    const languageSelect = this.pane.querySelector<HTMLSelectElement>('[data-action="target-language"]');
    const collapsedToggle = this.pane.querySelector<HTMLButtonElement>('[data-action="toggle-toolbar"]');
    if (languageSelect) {
      languageSelect.value = state.targetLang;
      languageSelect.disabled = state.isTranslating;
      languageSelect.title = this.localizer.targetLanguageLabel(state.targetLang);
    }
    for (const button of Array.from(this.pane.querySelectorAll<HTMLButtonElement>("[data-target-language]"))) {
      const isActive = button.dataset.targetLanguage === state.targetLang;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-pressed", String(isActive));
    }
    if (state.toolbarDisplayMode === "collapsed" && previousToolbarMode !== "collapsed") {
      this.toolbarExpanded = false;
    }
    const unsupportedReason = !state.association?.isSupportedSource
      ? this.associationReason(state.association?.reason)
      : null;
    if (collapsedToggle) {
      const presentation = this.getStatusPresentation(state, unsupportedReason, "");
      collapsedToggle.textContent = `${this.localizer.targetLanguageShortLabel(state.targetLang)} · ${presentation.label}`;
    }
    this.renderStatus(state, unsupportedReason);
    this.renderControls(state);
    if (state.toolbarDisplayMode === "compact") {
      this.toolbarExpanded = true;
    }
    this.syncToolbarMode();
    this.renderPresetState(state.paneWidthPercent);

    this.paneBody.innerHTML = "";

    if (!state.association?.isSupportedSource) {
      this.paneBody.appendChild(this.createEmptyState(unsupportedReason ?? this.localizer.t.pane.unsupportedFile));
      this.scheduleLayoutSync();
      return;
    }

    if (!state.targetMarkdown) {
      this.paneBody.appendChild(this.createEmptyState(this.localizer.t.pane.noCachedTranslation));
      this.scheduleLayoutSync();
      return;
    }

    for (const block of state.blocks) {
      const markdown = state.translatedBlocks.get(block.id) ?? block.sourceMarkdown;
      const blockEl = document.createElement("section");
      blockEl.className = "typora-bilingual-pane__block";
      blockEl.dataset.blockId = block.id;
      blockEl.dataset.order = String(block.order);
      blockEl.dataset.type = block.type;
      blockEl.dataset.translatable = String(block.translatable);
      blockEl.dataset.headingPath = this.anchorMapping.serializeHeadingPath(block.headingPath);
      if (this.activeBlockId === block.id) {
        blockEl.classList.add("is-active");
      }
      blockEl.innerHTML = this.sanitizeHtml(this.markdown.render(markdown));
      this.paneBody.appendChild(blockEl);
    }

    this.bindScrollSync(state.blocks);
    this.scheduleLayoutSync();
  }

  public jumpToSource(blockId: string): void {
    const source = this.sourceContainer;
    const paneBody = this.paneBody;
    if (!source || !paneBody) {
      return;
    }

    const targetHeadingPath = paneBody.querySelector<HTMLElement>(`[data-block-id="${blockId}"]`)?.dataset.headingPath;
    if (!targetHeadingPath) {
      return;
    }

    const candidates = Array.from(source.querySelectorAll<HTMLElement>(this.sourceBlockSelector));
    for (const candidate of candidates) {
      const headingPath = this.anchorMapping.serializeHeadingPath(this.anchorMapping.findHeadingPath(candidate, source));
      if (headingPath === targetHeadingPath) {
        candidate.scrollIntoView({ block: "center", behavior: "smooth" });
        return;
      }
    }
  }

  private bindScrollSync(blocks: TranslationBlock[]): void {
    if (!this.sourceContainer || !this.paneBody) {
      return;
    }
    this.scrollSync.bind({
      scrollRoot: this.scrollRoot,
      sourceRoot: this.sourceContainer,
      blocks,
      anchorMapping: this.anchorMapping,
      onActiveBlock: (blockId) => this.setActiveBlock(blockId)
    });
  }

  private setActiveBlock(blockId: string | null): void {
    this.activeBlockId = blockId;
    if (!this.paneBody) {
      return;
    }
    for (const block of Array.from(this.paneBody.querySelectorAll<HTMLElement>(".typora-bilingual-pane__block"))) {
      block.classList.toggle("is-active", block.dataset.blockId === blockId);
    }
  }

  private bindResize(handle: HTMLDivElement): void {
    handle.addEventListener("mouseenter", () => {
      document.body.style.cursor = "col-resize";
    });

    handle.addEventListener("mouseleave", () => {
      if (!handle.classList.contains("is-active")) {
        document.body.style.cursor = "";
      }
    });

    handle.addEventListener("mousedown", (event) => {
      event.preventDefault();
      const host = this.host;
      if (!host) {
        return;
      }

      handle.classList.add("is-active");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      this.resizeDragCleanup?.();

      let cleanup = () => {};

      const onMouseMove = (moveEvent: MouseEvent) => {
        const rect = host.getBoundingClientRect();
        if (!rect.width) {
          return;
        }
        const paneWidth = rect.right - moveEvent.clientX;
        const percent = (paneWidth / rect.width) * 100;
        const clamped = Math.min(65, Math.max(35, Math.round(percent)));
        this.applyPaneWidth(clamped, false);
      };

      const onMouseUp = (upEvent: MouseEvent) => {
        const rect = host.getBoundingClientRect();
        const paneWidth = rect.right - upEvent.clientX;
        const percent = rect.width ? (paneWidth / rect.width) * 100 : 50;
        const clamped = Math.min(65, Math.max(35, Math.round(percent)));
        this.applyPaneWidth(clamped, true);
        cleanup();
      };

      cleanup = () => {
        handle.classList.remove("is-active");
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        if (this.resizeDragCleanup === cleanup) {
          this.resizeDragCleanup = null;
        }
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      this.resizeDragCleanup = cleanup;
    });

    handle.addEventListener("dblclick", (event) => {
      event.preventDefault();
      this.applyPaneWidth(50, true);
    });

    handle.addEventListener("keydown", (event) => {
      let nextWidth: number | null = null;
      if (event.key === "ArrowLeft") {
        nextWidth = this.currentPaneWidth + 2;
      } else if (event.key === "ArrowRight") {
        nextWidth = this.currentPaneWidth - 2;
      } else if (event.key === "Home") {
        nextWidth = 35;
      } else if (event.key === "End") {
        nextWidth = 65;
      }
      if (nextWidth !== null) {
        event.preventDefault();
        this.applyPaneWidth(nextWidth, true);
      }
    });
  }

  private createEmptyState(message: string): HTMLDivElement {
    const empty = document.createElement("div");
    empty.className = "typora-bilingual-pane__empty";
    empty.textContent = message;
    return empty;
  }

  private bindSharedResizeObservers(): void {
    if (!this.sourceContainer) {
      return;
    }

    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver?.disconnect();
      this.resizeObserver = new ResizeObserver(() => this.scheduleLayoutSync());
      this.resizeObserver.observe(this.sourceContainer);
      if (this.paneBody) {
        this.resizeObserver.observe(this.paneBody);
      }
      if (this.overlayEl) {
        this.resizeObserver.observe(this.overlayEl);
      }
    }

    if (!this.windowResizeHandler) {
      this.windowResizeHandler = () => this.scheduleLayoutSync();
      window.addEventListener("resize", this.windowResizeHandler, { passive: true });
    }
  }

  private renderStatus(state: PaneRenderState, unsupportedReason: string | null): void {
    if (!this.statusBadgeEl || !this.messageEl) {
      return;
    }

    const targetName = state.association?.cacheTargetPath ? state.association.cacheTargetPath.split(/[\\/]/).pop() ?? "" : "";
    const presentation = this.getStatusPresentation(state, unsupportedReason, targetName);
    this.statusBadgeEl.dataset.kind = presentation.kind;
    this.statusBadgeEl.textContent = presentation.label;
    this.statusBadgeEl.title = presentation.title;

    if (presentation.detail) {
      this.messageEl.className = "typora-bilingual-pane__message";
      this.messageEl.dataset.kind = presentation.detailKind ?? presentation.kind;
      this.messageEl.textContent = presentation.detail;
    } else {
      this.messageEl.className = "typora-bilingual-pane__message is-hidden";
      this.messageEl.dataset.kind = "";
      this.messageEl.textContent = "";
    }
  }

  private getStatusPresentation(
    state: PaneRenderState,
    unsupportedReason: string | null,
    targetName: string
  ): { kind: StatusBadgeKind; label: string; title: string; detail?: string; detailKind?: "warning" | "error" } {
    const pane = this.localizer.t.pane;
    const cacheName = targetName || pane.cacheNotGenerated;
    if (state.isTranslating) {
      return {
        kind: "idle",
        label: pane.statusTranslating,
        title: pane.translationRunning
      };
    }
    if (state.errorMessage) {
      return {
        kind: "error",
        label: pane.statusError,
        title: state.errorMessage,
        detail: state.errorMessage,
        detailKind: "error"
      };
    }

    if (unsupportedReason) {
      return {
        kind: "idle",
        label: pane.statusNotTranslated,
        title: unsupportedReason,
        detail: unsupportedReason,
        detailKind: "warning"
      };
    }

    if (state.warningMessage || state.staleCount > 0) {
      return {
        kind: "stale",
        label: pane.statusStale,
        title: state.warningMessage ?? this.localizer.format(pane.staleDetail, { cacheName, count: state.staleCount }),
        detail: state.warningMessage ?? this.localizer.format(pane.staleDetail, { cacheName, count: state.staleCount }),
        detailKind: "warning"
      };
    }

    if (state.targetMarkdown) {
      return {
        kind: "cached",
        label: pane.statusCached,
        title: state.infoMessage ?? this.localizer.format(pane.cachedDetail, { cacheName })
      };
    }

    return {
      kind: "idle",
      label: pane.statusNotTranslated,
      title: pane.noCachedTranslation
    };
  }

  private associationReason(reason?: FileAssociationReason): string {
    if (reason === "no-saved-markdown") {
      return this.localizer.t.pane.noSavedMarkdown;
    }
    if (reason === "markdown-only") {
      return this.localizer.t.pane.markdownOnly;
    }
    return this.localizer.t.pane.unsupportedFile;
  }

  private renderControls(state: PaneRenderState): void {
    if (!this.pane) {
      return;
    }
    const primaryButton = this.pane.querySelector<HTMLButtonElement>('[data-action="primary"]');
    const retranslateButton = this.pane.querySelector<HTMLButtonElement>('[data-action="translate-all"]');
    const exportButton = this.pane.querySelector<HTMLButtonElement>('[data-action="export-target"]');
    if (!primaryButton || !retranslateButton || !exportButton) {
      return;
    }

    const supported = state.association?.isSupportedSource === true;
    const hasTranslation = Boolean(state.targetMarkdown);
    let action: PrimaryAction | null = null;
    let label = "";
    if (state.isTranslating) {
      action = "cancel-translation";
      label = this.localizer.t.pane.cancelTranslation;
    } else if (state.retryMode) {
      action = state.retryMode === "stale" ? "refresh-stale" : "translate-all";
      label = this.localizer.t.pane.retry;
    } else if (supported && !hasTranslation) {
      action = "translate-all";
      label = this.localizer.format(this.localizer.t.pane.translateTo, {
        language: this.localizer.targetLanguageShortLabel(state.targetLang)
      });
    } else if (supported && state.staleCount > 0) {
      action = "refresh-stale";
      label = this.localizer.format(this.localizer.t.pane.updateChanges, { count: state.staleCount });
    } else if (supported && hasTranslation) {
      action = "translate-all";
      label = this.localizer.t.pane.retranslateAll;
    }

    this.primaryAction = action;
    primaryButton.textContent = label;
    primaryButton.classList.toggle("is-hidden", !action);
    primaryButton.dataset.kind = action === "cancel-translation" ? "cancel" : action === null ? "" : "action";
    retranslateButton.textContent = this.localizer.t.pane.retranslateAll;
    retranslateButton.disabled = state.isTranslating || !supported;
    retranslateButton.classList.toggle("is-hidden", action === "translate-all");
    exportButton.textContent = this.localizer.t.pane.exportTarget;
    exportButton.disabled = state.isTranslating || !hasTranslation;
    this.syncMoreMenu();
  }

  private invokePrimaryAction(): void {
    if (!this.actions || !this.primaryAction) {
      return;
    }
    const action = this.primaryAction;
    this.closeAfterAction();
    if (action === "translate-all") {
      this.actions.onTranslateAll();
    } else if (action === "refresh-stale") {
      this.actions.onRefreshStale();
    } else {
      this.actions.onCancelTranslation();
    }
  }

  private closeAfterAction(): void {
    this.closeMoreMenu();
    if (this.pane?.dataset.toolbarMode === "collapsed") {
      this.clearToolbarCollapseTimer();
      this.toolbarExpanded = false;
      this.syncToolbarMode();
    }
  }

  private closeMoreMenu(): void {
    if (!this.moreMenuOpen) {
      return;
    }
    this.moreMenuOpen = false;
    this.syncMoreMenu();
  }

  private closeTransientControls(): void {
    this.clearToolbarCollapseTimer();
    const wasExpanded = this.toolbarExpanded;
    this.closeMoreMenu();
    if (this.pane?.dataset.toolbarMode === "collapsed") {
      this.toolbarExpanded = false;
    }
    if (wasExpanded !== this.toolbarExpanded) {
      this.syncToolbarMode();
      this.scheduleLayoutSync();
    }
  }

  private openCollapsedToolbar(): void {
    if (this.pane?.dataset.toolbarMode !== "collapsed") {
      return;
    }
    this.clearToolbarCollapseTimer();
    this.toolbarExpanded = true;
    this.moreMenuOpen = true;
    this.syncToolbarMode();
    this.syncMoreMenu();
    this.scheduleLayoutSync();
  }

  private scheduleCollapsedToolbarClose(): void {
    if (this.pane?.dataset.toolbarMode !== "collapsed") {
      return;
    }
    this.clearToolbarCollapseTimer();
    this.toolbarCollapseTimer = window.setTimeout(() => {
      this.toolbarCollapseTimer = null;
      this.closeTransientControls();
    }, 200);
  }

  private clearToolbarCollapseTimer(): void {
    if (this.toolbarCollapseTimer !== null) {
      window.clearTimeout(this.toolbarCollapseTimer);
      this.toolbarCollapseTimer = null;
    }
  }

  private syncMoreMenu(): void {
    if (!this.pane) {
      return;
    }
    const toggle = this.pane.querySelector<HTMLButtonElement>('[data-action="toggle-more"]');
    const menu = this.pane.querySelector<HTMLDivElement>(".typora-bilingual-pane__menu");
    if (!toggle || !menu) {
      return;
    }
    toggle.textContent = this.localizer.t.pane.moreActions;
    toggle.title = this.localizer.t.pane.moreActions;
    toggle.setAttribute("aria-expanded", String(this.moreMenuOpen));
    menu.classList.toggle("is-hidden", !this.moreMenuOpen);
  }

  private refreshPresetLabels(): void {
    if (!this.pane) {
      return;
    }
    const labels: Record<string, string> = {
      "60": this.localizer.t.pane.translationWider,
      "50": this.localizer.t.pane.equalWidth,
      "40": this.localizer.t.pane.sourceWider
    };
    for (const button of Array.from(this.pane.querySelectorAll<HTMLButtonElement>(".typora-bilingual-pane__preset"))) {
      const ratio = button.textContent?.match(/\d+\/\d+/)?.[0] ?? "";
      const description = labels[button.dataset.preset ?? ""];
      button.title = description;
      button.setAttribute("aria-label", `${description} ${ratio}`.trim());
    }
  }

  private syncToolbarMode(): void {
    if (!this.pane || !this.overlayEl) {
      return;
    }

    const toolbarMode = (this.pane.dataset.toolbarMode as ToolbarDisplayMode | undefined) ?? "compact";
    const collapsedToggle = this.overlayEl.querySelector<HTMLButtonElement>(".typora-bilingual-pane__collapsed-toggle");
    const toolbar = this.overlayEl.querySelector<HTMLDivElement>(".typora-bilingual-pane__toolbar");
    const message = this.overlayEl.querySelector<HTMLDivElement>(".typora-bilingual-pane__message");
    if (!collapsedToggle || !toolbar || !message) {
      return;
    }

    const expanded = toolbarMode === "compact" ? true : this.toolbarExpanded;
    if (!expanded) {
      this.moreMenuOpen = false;
      this.syncMoreMenu();
    }
    this.overlayEl.dataset.toolbarMode = toolbarMode;
    this.overlayEl.dataset.expanded = String(expanded);
    collapsedToggle.classList.toggle("is-hidden", toolbarMode === "compact");
    collapsedToggle.setAttribute("aria-expanded", String(expanded));
    toolbar.classList.toggle("is-hidden", !expanded);
    message.classList.toggle("is-hidden", !expanded || !message.textContent);
  }

  private renderPresetState(paneWidthPercent: number): void {
    if (!this.pane) {
      return;
    }

    for (const presetButton of Array.from(this.pane.querySelectorAll<HTMLButtonElement>(".typora-bilingual-pane__preset"))) {
      const preset = Number.parseInt(presetButton.dataset.preset ?? "", 10);
      const isActive = Number.isFinite(preset) && preset === paneWidthPercent;
      presetButton.classList.toggle("is-active", isActive);
      presetButton.setAttribute("aria-pressed", String(isActive));
    }
  }

  private applyPaneWidth(percent: number, persist: boolean): void {
    const clamped = Math.min(65, Math.max(35, Math.round(percent)));
    if (!this.host) {
      return;
    }

    this.host.style.setProperty("--typora-bilingual-pane-width", `${clamped}%`);
    this.currentPaneWidth = clamped;
    this.resizeHandle?.setAttribute("aria-valuenow", String(clamped));
    this.renderPresetState(clamped);
    this.scheduleLayoutSync();

    if (persist && this.actions) {
      void this.actions.onResize(clamped);
    }
  }

  private scheduleLayoutSync(): void {
    if (this.layoutSyncFrame !== null) {
      window.cancelAnimationFrame(this.layoutSyncFrame);
    }

    this.layoutSyncFrame = window.requestAnimationFrame(() => {
      this.layoutSyncFrame = null;
      this.syncBlockHeights();
    });
  }

  private syncBlockHeights(): void {
    if (!this.sourceContainer || !this.paneBody) {
      return;
    }

    const sourceBlockQueues = this.collectSourceBlockQueues();
    const translatedBlocks = Array.from(this.paneBody.querySelectorAll<HTMLElement>(".typora-bilingual-pane__block"));

    for (const block of translatedBlocks) {
      block.style.minHeight = "";
    }

    for (const translatedBlock of translatedBlocks) {
      const blockType = (translatedBlock.dataset.type as TranslationBlockType | undefined) ?? "paragraph";
      const sourceBlock = sourceBlockQueues[blockType]?.shift();
      if (!sourceBlock) {
        continue;
      }
      const sourceHeight = Math.ceil(sourceBlock.getBoundingClientRect().height);
      if (sourceHeight > 0) {
        translatedBlock.style.minHeight = `${sourceHeight}px`;
      }
    }
  }

  private collectSourceBlockQueues(): Record<TranslationBlockType, HTMLElement[]> {
    const source = this.sourceContainer;
    if (!source) {
      return {
        heading: [],
        paragraph: [],
        list: [],
        blockquote: [],
        table: [],
        html: [],
        code: [],
        math: [],
        passthrough: []
      };
    }

    return {
      heading: Array.from(source.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")),
      paragraph: Array.from(source.querySelectorAll<HTMLElement>("p")),
      list: Array.from(source.querySelectorAll<HTMLElement>("ul, ol")),
      blockquote: Array.from(source.querySelectorAll<HTMLElement>("blockquote")),
      table: Array.from(source.querySelectorAll<HTMLElement>("table")),
      html: Array.from(source.querySelectorAll<HTMLElement>(".md-htmlblock, .md-rawblock, .htmlblock")),
      code: Array.from(source.querySelectorAll<HTMLElement>("pre, .md-fences")),
      math: Array.from(source.querySelectorAll<HTMLElement>(".mathjax-block, .md-math-block, .md-math, .md-equation, .MathJax_Display")),
      passthrough: Array.from(source.querySelectorAll<HTMLElement>("hr"))
    };
  }

  private findSourceContainer(): HTMLElement | null {
    return (
      document.querySelector<HTMLElement>("#write") ||
      document.querySelector<HTMLElement>(".file-content") ||
      document.querySelector<HTMLElement>(".md-focus")
    );
  }

  private findScrollRoot(source: HTMLElement): HTMLElement | Window {
    let current: HTMLElement | null = source.parentElement;
    while (current) {
      const style = window.getComputedStyle(current);
      const overflowY = style.overflowY;
      if ((overflowY === "auto" || overflowY === "scroll") && current.scrollHeight > current.clientHeight) {
        return current;
      }
      current = current.parentElement;
    }
    return window;
  }
}
