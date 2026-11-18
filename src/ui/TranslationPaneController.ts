import MarkdownIt from "markdown-it";
import { PluginLocalizer } from "../i18n/PluginLocalizer";
import { getYamlFrontmatterBody } from "../markdown/YamlFrontmatter";
import { AlignmentTarget, BlockAlignment, blockTextKey, hasComparableText } from "../sync/BlockAlignment";
import { ScrollSyncService } from "../sync/ScrollSyncService";
import { FileAssociationReason, PaneRenderState, TargetLanguage } from "../types";
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

type StatusBadgeKind = "idle" | "translating" | "cached" | "stale" | "error";
type ToolbarDisplayMode = "compact" | "collapsed";
type PrimaryAction = "translate-all" | "refresh-stale" | "cancel-translation";

export class TranslationPaneController {
  private readonly markdown = new MarkdownIt({ html: false, linkify: true, breaks: false });
  private readonly sanitizeHtml = createTranslationHtmlSanitizer(window);
  private readonly blockAlignment = new BlockAlignment();
  private readonly scrollSync = new ScrollSyncService();
  private alignmentTargets: AlignmentTarget[] = [];
  private alignedSources = new Map<string, HTMLElement>();
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
  private sourceObserver: MutationObserver | null = null;
  private windowResizeHandler: (() => void) | null = null;
  private layoutSyncFrame: number | null = null;
  private toolbarExpanded = false;
  private toolbarCloseTimer: number | null = null;
  private moreMenuOpen = false;
  private primaryAction: PrimaryAction | null = null;
  private lastState: PaneRenderState | null = null;
  private currentPaneWidth = 50;
  private originalParent: HTMLElement | null = null;
  private originalNextSibling: ChildNode | null = null;
  private resizeDragCleanup: (() => void) | null = null;
  private documentPointerDownHandler: ((event: PointerEvent) => void) | null = null;
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
    const layoutLabel = this.pane.querySelector<HTMLElement>("#typora-bilingual-layout-label");
    if (layoutLabel) {
      layoutLabel.textContent = pane.layout;
    }
    const languageSelect = this.pane.querySelector<HTMLSelectElement>('[data-action="target-language"]');
    languageSelect?.setAttribute("aria-label", pane.targetLanguage);
    for (const option of Array.from(languageSelect?.options ?? [])) {
      const language = option.value as TargetLanguage;
      option.textContent = this.localizer.targetLanguageShortLabel(language);
      option.title = this.localizer.targetLanguageLabel(language);
    }
    this.refreshPresetLabels();
    if (this.lastState) {
      this.renderStatus(this.lastState);
      this.renderControls(this.lastState);
      this.syncToolbarMode();
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
      '  <button class="typora-bilingual-pane__collapsed-toggle typora-bilingual-pane__status" data-action="toggle-toolbar" type="button" aria-expanded="false" aria-controls="typora-bilingual-toolbar"><span class="typora-bilingual-pane__bubble-count" aria-hidden="true" hidden></span><span class="typora-bilingual-pane__bubble-action" aria-hidden="true" hidden></span></button>',
      '  <div class="typora-bilingual-pane__flyout is-hidden" id="typora-bilingual-toolbar">',
      '    <div class="typora-bilingual-pane__toolbar">',
      '      <div class="typora-bilingual-pane__status-badge typora-bilingual-pane__status" data-kind="idle" role="status" aria-live="polite"></div>',
      '      <div class="typora-bilingual-pane__toolbar-controls">',
      '        <select class="typora-bilingual-pane__language" data-action="target-language">',
      ...TARGET_LANGUAGES.map((language) => `          <option value="${language.code}"></option>`),
      "        </select>",
      '        <button class="typora-bilingual-pane__more-toggle" data-action="toggle-more" type="button" aria-expanded="false" aria-controls="typora-bilingual-more"></button>',
      "      </div>",
      "    </div>",
      '    <button class="typora-bilingual-pane__button typora-bilingual-pane__primary is-hidden" data-action="primary" type="button"></button>',
      '    <div class="typora-bilingual-pane__message is-hidden" role="alert"></div>',
      '    <div class="typora-bilingual-pane__menu is-hidden" id="typora-bilingual-more">',
      '      <button class="typora-bilingual-pane__menu-item" data-action="export-target" type="button"></button>',
      '      <button class="typora-bilingual-pane__menu-item" data-action="translate-all" type="button"></button>',
      '      <div class="typora-bilingual-pane__layout-label" id="typora-bilingual-layout-label"></div>',
      '      <div class="typora-bilingual-pane__presets" role="group" aria-labelledby="typora-bilingual-layout-label">',
      '        <button class="typora-bilingual-pane__preset" data-preset="60" type="button">40/60</button>',
      '        <button class="typora-bilingual-pane__preset" data-preset="50" type="button">50/50</button>',
      '        <button class="typora-bilingual-pane__preset" data-preset="40" type="button">60/40</button>',
      "      </div>",
      "    </div>",
      "  </div>",
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
        if (this.primaryAction) {
          this.invokePrimaryAction(false);
        } else if (this.toolbarExpanded) {
          this.closeTransientControls();
        } else {
          this.openBubbleToolbar();
        }
        return;
      }
      if (action === "toggle-more") {
        this.moreMenuOpen = !this.moreMenuOpen;
        this.syncMoreMenu();
        return;
      }

      const preset = target.closest<HTMLElement>("[data-preset]")?.dataset.preset;
      if (preset) {
        const nextWidth = Number.parseInt(preset, 10);
        if (Number.isFinite(nextWidth)) {
          this.applyPaneWidth(nextWidth, true);
        }
        this.closeAfterAction();
        return;
      }

      const blockEl = target.closest<HTMLElement>("[data-block-id]");
      const blockId = blockEl?.dataset.blockId;
      if (blockId) {
        actions.onJumpToSource(blockId);
      }
    });

    const collapsedToggle = pane.querySelector<HTMLButtonElement>('[data-action="toggle-toolbar"]');
    collapsedToggle?.addEventListener("pointerenter", (event) => {
      if (event.pointerType === "mouse") {
        this.openBubbleToolbar();
      }
    });
    overlayEl.addEventListener("pointerenter", () => this.clearToolbarCloseTimer());
    overlayEl.addEventListener("pointerleave", (event) => {
      if (event.pointerType !== "mouse" || !this.toolbarExpanded) {
        return;
      }
      this.clearToolbarCloseTimer();
      this.toolbarCloseTimer = window.setTimeout(() => {
        this.toolbarCloseTimer = null;
        if (!overlayEl.contains(document.activeElement) || !document.activeElement?.matches(":focus-visible")) {
          this.closeTransientControls();
        }
      }, 220);
    });
    collapsedToggle?.addEventListener("focus", () => {
      if (collapsedToggle.matches(":focus-visible")) {
        this.openBubbleToolbar();
      }
    });
    overlayEl.addEventListener("focusout", (event) => {
      if (!overlayEl.contains(event.relatedTarget as Node | null) && !overlayEl.matches(":hover")) {
        this.closeTransientControls();
      }
    });

    this.documentPointerDownHandler = (event) => {
      if (this.overlayEl && !this.overlayEl.contains(event.target as Node)) {
        this.closeTransientControls();
      }
    };
    this.documentKeyDownHandler = (event) => {
      if (event.key === "Escape" && !event.defaultPrevented && (this.toolbarExpanded || this.moreMenuOpen)) {
        this.closeAfterAction();
        if (this.overlayEl?.contains(event.target as Node)) {
          event.preventDefault();
        }
      }
    };
    document.addEventListener("pointerdown", this.documentPointerDownHandler, true);
    document.addEventListener("keydown", this.documentKeyDownHandler, true);

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
    this.clearToolbarCloseTimer();
    this.clearAlignment();
    this.sourceObserver?.disconnect();
    this.sourceObserver = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.windowResizeHandler) {
      window.removeEventListener("resize", this.windowResizeHandler);
      this.windowResizeHandler = null;
    }
    this.resizeDragCleanup?.();
    this.resizeDragCleanup = null;
    if (this.documentPointerDownHandler) {
      document.removeEventListener("pointerdown", this.documentPointerDownHandler, true);
      this.documentPointerDownHandler = null;
    }
    if (this.documentKeyDownHandler) {
      document.removeEventListener("keydown", this.documentKeyDownHandler, true);
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
      this.clearAlignment();
      this.closeTransientControls();
      return;
    }

    const previousToolbarMode = this.pane.dataset.toolbarMode as ToolbarDisplayMode | undefined;
    if (state.toolbarDisplayMode !== previousToolbarMode || this.lastState?.association?.sourcePath !== state.association?.sourcePath) {
      this.clearToolbarCloseTimer();
      this.toolbarExpanded = false;
      this.moreMenuOpen = false;
    }
    this.lastState = state;
    this.pane.dataset.toolbarMode = state.toolbarDisplayMode;
    const languageSelect = this.pane.querySelector<HTMLSelectElement>('[data-action="target-language"]');
    if (languageSelect) {
      languageSelect.value = state.targetLang;
      languageSelect.disabled = state.isTranslating;
      languageSelect.title = this.localizer.targetLanguageLabel(state.targetLang);
    }
    this.renderStatus(state);
    this.renderControls(state);
    this.syncToolbarMode();
    this.renderPresetState(state.paneWidthPercent);

    this.clearAlignment();
    this.paneBody.innerHTML = "";

    if (!state.association?.isSupportedSource) {
      this.paneBody.appendChild(this.createEmptyState(this.associationReason(state.association?.reason)));
      return;
    }

    if (!state.targetMarkdown) {
      this.paneBody.appendChild(this.createEmptyState(this.localizer.t.pane.noCachedTranslation));
      return;
    }

    const sourcePreview = document.createElement("template");
    for (const block of state.blocks) {
      const markdown = state.translatedBlocks.get(block.id) ?? block.sourceMarkdown;
      const blockEl = document.createElement("section");
      blockEl.className = "typora-bilingual-pane__block";
      blockEl.dataset.blockId = block.id;
      blockEl.dataset.order = String(block.order);
      blockEl.dataset.type = block.type;
      blockEl.dataset.translatable = String(block.translatable);
      if (this.activeBlockId === block.id) {
        blockEl.classList.add("is-active");
      }
      if (block.type === "frontmatter") {
        const metadata = document.createElement("pre");
        metadata.className = "md-meta-block";
        metadata.textContent = getYamlFrontmatterBody(markdown) ?? getYamlFrontmatterBody(block.sourceMarkdown);
        blockEl.appendChild(metadata);
      } else {
        blockEl.innerHTML = this.sanitizeHtml(this.markdown.render(markdown));
      }
      this.paneBody.appendChild(blockEl);
      let key: string | null = null;
      if (block.type === "frontmatter") {
        sourcePreview.content.textContent = getYamlFrontmatterBody(block.sourceMarkdown) ?? "";
        key = blockTextKey(sourcePreview.content);
      } else if (hasComparableText(block.type)) {
        sourcePreview.innerHTML = this.sanitizeHtml(this.markdown.render(block.sourceMarkdown));
        key = blockTextKey(sourcePreview.content);
      }
      this.alignmentTargets.push({ id: block.id, type: block.type, element: blockEl, key });
    }

    this.scrollSync.bind({
      scrollRoot: this.scrollRoot,
      sourceBlocks: () => this.alignedSources,
      onActiveBlock: (blockId) => this.setActiveBlock(blockId)
    });
    this.scheduleLayoutSync();
  }

  public jumpToSource(blockId: string): void {
    this.syncAlignment();
    const source = this.alignedSources.get(blockId);
    if (source && source.parentElement === this.sourceContainer) {
      source.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }

  private clearAlignment(): void {
    if (this.layoutSyncFrame !== null) {
      window.cancelAnimationFrame(this.layoutSyncFrame);
      this.layoutSyncFrame = null;
    }
    this.scrollSync.unbind();
    this.blockAlignment.clear();
    this.alignmentTargets = [];
    this.alignedSources.clear();
    this.setActiveBlock(null);
  }

  private setActiveBlock(blockId: string | null): void {
    if (this.activeBlockId === blockId) {
      return;
    }
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

    if (typeof MutationObserver !== "undefined") {
      this.sourceObserver = new MutationObserver(() => this.scheduleLayoutSync());
      this.sourceObserver.observe(this.sourceContainer, { childList: true, characterData: true, subtree: true });
    }
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver?.disconnect();
      this.resizeObserver = new ResizeObserver(() => this.scheduleLayoutSync());
      this.resizeObserver.observe(this.sourceContainer);
      if (this.paneBody) {
        this.resizeObserver.observe(this.paneBody);
      }
    }

    if (!this.windowResizeHandler) {
      this.windowResizeHandler = () => this.scheduleLayoutSync();
      window.addEventListener("resize", this.windowResizeHandler, { passive: true });
    }
  }

  private renderStatus(state: PaneRenderState): void {
    if (!this.statusBadgeEl || !this.messageEl) {
      return;
    }

    const targetName = state.association?.cacheTargetPath ? state.association.cacheTargetPath.split(/[\\/]/).pop() ?? "" : "";
    const presentation = this.getStatusPresentation(state, targetName);
    this.statusBadgeEl.dataset.kind = presentation.kind;
    this.statusBadgeEl.textContent = presentation.label;
    this.statusBadgeEl.title = presentation.title;
    const collapsedToggle = this.pane?.querySelector<HTMLButtonElement>('[data-action="toggle-toolbar"]');
    const collapsedCount = collapsedToggle?.querySelector(".typora-bilingual-pane__bubble-count");
    if (collapsedToggle && collapsedCount) {
      collapsedToggle.dataset.kind = presentation.kind;
      collapsedCount.textContent = presentation.count ? String(presentation.count) : "";
      collapsedToggle.toggleAttribute("data-has-count", Boolean(presentation.count));
      collapsedToggle.setAttribute("aria-description", presentation.title);
    }

    this.messageEl.textContent = presentation.kind === "error" ? presentation.title : "";
    this.messageEl.classList.toggle("is-hidden", !this.messageEl.textContent);
  }

  private getStatusPresentation(
    state: PaneRenderState,
    targetName: string
  ): { kind: StatusBadgeKind; label: string; title: string; count?: number } {
    const pane = this.localizer.t.pane;
    const cacheName = targetName || pane.cacheNotGenerated;
    if (state.isTranslating) {
      return {
        kind: "translating",
        label: pane.statusTranslating,
        title: pane.translationRunning
      };
    }
    if (state.errorMessage) {
      return {
        kind: "error",
        label: pane.statusError,
        title: state.errorMessage
      };
    }

    if (!state.association?.isSupportedSource) {
      const reason = this.associationReason(state.association?.reason);
      return {
        kind: "idle",
        label: pane.statusNotTranslated,
        title: reason
      };
    }

    if (state.targetMarkdown && (state.warningMessage || state.staleCount > 0)) {
      const count = this.countUntranslatedPreviewBlocks(state);
      const detail = state.warningMessage ?? (count > 0
        ? this.localizer.format(pane.staleDetail, { cacheName, count })
        : pane.statusStale);
      return {
        kind: "stale",
        count,
        label: count > 0 ? this.localizer.format(pane.statusStaleCount, { count }) : pane.statusStale,
        title: detail
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

  private countUntranslatedPreviewBlocks(state: PaneRenderState): number {
    return state.blocks.filter((block) => block.translatable && !state.translatedBlocks.has(block.id)).length;
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
      const count = this.countUntranslatedPreviewBlocks(state);
      label = count === state.staleCount
        ? this.localizer.format(this.localizer.t.pane.updateChanges, { count })
        : this.localizer.t.pane.refreshStale;
    }

    this.primaryAction = action;
    primaryButton.textContent = label;
    primaryButton.classList.toggle("is-hidden", !action);
    primaryButton.dataset.kind = action === "cancel-translation" ? "cancel" : action === null ? "" : "action";
    retranslateButton.textContent = this.localizer.t.pane.retranslateAll;
    retranslateButton.disabled = state.isTranslating || !supported;
    retranslateButton.classList.toggle("is-hidden", !hasTranslation || action === "translate-all");
    exportButton.textContent = this.localizer.t.pane.exportTarget;
    exportButton.disabled = state.isTranslating || !hasTranslation || state.staleCount > 0;
    exportButton.title = hasTranslation && state.staleCount > 0 ? this.localizer.t.errors.cacheStaleExport : "";
    const collapsedToggle = this.pane.querySelector<HTMLButtonElement>('[data-action="toggle-toolbar"]');
    const bubbleAction = collapsedToggle?.querySelector(".typora-bilingual-pane__bubble-action");
    if (collapsedToggle && bubbleAction) {
      bubbleAction.textContent = label;
      collapsedToggle.toggleAttribute("data-has-action", Boolean(action));
      collapsedToggle.setAttribute("aria-label", [
        label || this.localizer.t.pane.openToolbar,
        this.localizer.targetLanguageLabel(state.targetLang),
        this.statusBadgeEl?.textContent
      ].filter(Boolean).join(" · "));
    }
    this.syncMoreMenu();
  }

  private invokePrimaryAction(closeControls = true): void {
    if (!this.actions || !this.primaryAction) {
      return;
    }
    const action = this.primaryAction;
    if (closeControls) {
      this.closeAfterAction();
    }
    if (action === "translate-all") {
      this.actions.onTranslateAll();
    } else if (action === "refresh-stale") {
      this.actions.onRefreshStale();
    } else {
      this.actions.onCancelTranslation();
    }
  }

  private closeAfterAction(): void {
    const triggerAction = this.toolbarExpanded ? "toggle-toolbar" : this.moreMenuOpen ? "toggle-more" : null;
    const focusTrigger = triggerAction && this.overlayEl?.contains(document.activeElement)
      ? this.overlayEl.querySelector<HTMLButtonElement>(`[data-action="${triggerAction}"]`)
      : null;
    focusTrigger?.focus({ preventScroll: true });
    this.closeTransientControls();
  }

  private openBubbleToolbar(): void {
    if (this.pane?.dataset.toolbarMode !== "collapsed") {
      return;
    }
    this.clearToolbarCloseTimer();
    if (!this.toolbarExpanded) {
      this.toolbarExpanded = true;
      this.syncToolbarMode();
    }
  }

  private clearToolbarCloseTimer(): void {
    if (this.toolbarCloseTimer !== null) {
      window.clearTimeout(this.toolbarCloseTimer);
      this.toolbarCloseTimer = null;
    }
  }

  private closeTransientControls(): void {
    this.clearToolbarCloseTimer();
    if (this.toolbarExpanded || this.moreMenuOpen) {
      this.toolbarExpanded = false;
      this.moreMenuOpen = false;
      this.syncToolbarMode();
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
    for (const button of Array.from(this.pane.querySelectorAll<HTMLButtonElement>("[data-preset]"))) {
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
    const flyout = this.overlayEl.querySelector<HTMLDivElement>(".typora-bilingual-pane__flyout");
    if (!collapsedToggle || !flyout) {
      return;
    }

    const expanded = toolbarMode === "compact" ? true : this.toolbarExpanded;
    this.overlayEl.dataset.toolbarMode = toolbarMode;
    collapsedToggle.classList.toggle("is-hidden", toolbarMode === "compact");
    collapsedToggle.setAttribute("aria-expanded", String(expanded));
    const showAction = expanded && collapsedToggle.hasAttribute("data-has-action");
    const bubbleCount = collapsedToggle.querySelector<HTMLElement>(".typora-bilingual-pane__bubble-count");
    const bubbleAction = collapsedToggle.querySelector<HTMLElement>(".typora-bilingual-pane__bubble-action");
    if (bubbleCount && bubbleAction) {
      bubbleCount.hidden = showAction || !collapsedToggle.hasAttribute("data-has-count");
      bubbleAction.hidden = !showAction;
    }
    flyout.classList.toggle("is-hidden", !expanded);
    this.syncMoreMenu();
  }

  private renderPresetState(paneWidthPercent: number): void {
    if (!this.pane) {
      return;
    }

    for (const presetButton of Array.from(this.pane.querySelectorAll<HTMLButtonElement>("[data-preset]"))) {
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
    if (!this.alignmentTargets.length || this.layoutSyncFrame !== null) {
      return;
    }

    this.layoutSyncFrame = window.requestAnimationFrame(() => {
      this.layoutSyncFrame = null;
      this.syncAlignment();
    });
  }

  private syncAlignment(): void {
    if (this.sourceContainer && this.alignmentTargets.length) {
      this.alignedSources = this.blockAlignment.align(this.sourceContainer, this.alignmentTargets);
      this.scrollSync.refresh();
    }
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
      if (overflowY === "auto" || overflowY === "scroll") {
        return current;
      }
      current = current.parentElement;
    }
    return window;
  }
}
