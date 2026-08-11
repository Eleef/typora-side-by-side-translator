import MarkdownIt from "markdown-it";
import { AnchorMappingService } from "../sync/AnchorMappingService";
import { ScrollSyncService } from "../sync/ScrollSyncService";
import { PaneRenderState, TargetLanguage, TranslationBlock, TranslationBlockType } from "../types";
import { getTargetLanguageDefinition, TARGET_LANGUAGES } from "../translation/TargetLanguage";

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

export class TranslationPaneController {
  private readonly markdown = new MarkdownIt({ html: true, linkify: true, breaks: false });
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

  public ensureMounted(actions: PaneActions): void {
    if (this.host) {
      this.actions = actions;
      return;
    }

    const source = this.findSourceContainer();
    if (!source || !source.parentElement) {
      throw new Error("未找到 Typora 写作区容器，无法挂载译文 pane。");
    }

    this.actions = actions;
    const originalParent = source.parentElement;
    const host = document.createElement("div");
    host.className = "typora-bilingual-host";
    const sourceWrapper = document.createElement("div");
    sourceWrapper.className = "typora-bilingual-source";
    originalParent.insertBefore(host, source);
    sourceWrapper.appendChild(source);
    host.appendChild(sourceWrapper);

    const resizeHandle = document.createElement("div");
    resizeHandle.className = "typora-bilingual-resizer";
    resizeHandle.title = "拖拽调整比例，双击恢复 50/50";
    host.appendChild(resizeHandle);

    const pane = document.createElement("div");
    pane.className = "typora-bilingual-pane is-hidden";
    pane.innerHTML = [
      '<div class="typora-bilingual-pane__overlay">',
      '  <button class="typora-bilingual-pane__collapsed-toggle" data-action="toggle-toolbar" type="button" aria-label="打开右侧工具栏">译</button>',
      '  <div class="typora-bilingual-pane__toolbar">',
      '    <div class="typora-bilingual-pane__actions">',
      '      <button class="typora-bilingual-pane__button" data-action="translate-all" type="button">全文翻译</button>',
      '      <button class="typora-bilingual-pane__button" data-action="refresh-stale" type="button">刷新脏区</button>',
      '      <button class="typora-bilingual-pane__button is-hidden" data-action="cancel-translation" type="button">取消翻译</button>',
      '      <button class="typora-bilingual-pane__button" data-action="export-target" type="button">导出译文</button>',
      "    </div>",
      '    <div class="typora-bilingual-pane__controls-row">',
      '      <select class="typora-bilingual-pane__language" data-action="target-language" aria-label="目标语言">',
      ...TARGET_LANGUAGES.map((language) => `        <option value="${language.code}">${language.label}</option>`),
      "      </select>",
      '      <div class="typora-bilingual-pane__presets">',
      '        <button class="typora-bilingual-pane__preset" data-preset="60" type="button">40/60</button>',
      '        <button class="typora-bilingual-pane__preset" data-preset="50" type="button">50/50</button>',
      '        <button class="typora-bilingual-pane__preset" data-preset="40" type="button">60/40</button>',
      "      </div>",
      '      <div class="typora-bilingual-pane__status-badge" data-kind="idle"></div>',
      "    </div>",
      "  </div>",
      '  <div class="typora-bilingual-pane__message is-hidden"></div>',
      "</div>",
      '<div class="typora-bilingual-pane__body"></div>'
    ].join("");

    const overlayEl = pane.querySelector<HTMLDivElement>(".typora-bilingual-pane__overlay");
    const statusBadgeEl = pane.querySelector<HTMLDivElement>(".typora-bilingual-pane__status-badge");
    const messageEl = pane.querySelector<HTMLDivElement>(".typora-bilingual-pane__message");
    const paneBody = pane.querySelector<HTMLDivElement>(".typora-bilingual-pane__body");
    if (!overlayEl || !statusBadgeEl || !messageEl || !paneBody) {
      throw new Error("译文 pane 初始化失败。");
    }

    pane.addEventListener("change", (event) => {
      const select = event.target as HTMLSelectElement;
      if (select.dataset.action === "target-language") {
        actions.onTargetLanguageChange(select.value as TargetLanguage);
      }
    });

    pane.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;
      const action = target.closest<HTMLElement>("[data-action]")?.dataset.action;
      if (action === "translate-all") {
        actions.onTranslateAll();
        return;
      }
      if (action === "refresh-stale") {
        actions.onRefreshStale();
        return;
      }
      if (action === "cancel-translation") {
        actions.onCancelTranslation();
        return;
      }
      if (action === "export-target") {
        actions.onExportTarget();
        return;
      }

      if (action === "toggle-toolbar") {
        this.toolbarExpanded = !this.toolbarExpanded;
        this.syncToolbarMode();
        this.scheduleLayoutSync();
        return;
      }

      const preset = target.closest<HTMLElement>("[data-preset]")?.dataset.preset;
      if (preset) {
        const nextWidth = Number.parseInt(preset, 10);
        if (Number.isFinite(nextWidth)) {
          this.applyPaneWidth(nextWidth, true);
        }
        return;
      }

      const blockEl = target.closest<HTMLElement>("[data-block-id]");
      const blockId = blockEl?.dataset.blockId;
      if (blockId) {
        actions.onJumpToSource(blockId);
      }
    });

    overlayEl.addEventListener("mouseenter", () => {
      if ((this.pane?.dataset.toolbarMode as ToolbarDisplayMode | undefined) === "collapsed") {
        this.toolbarExpanded = true;
        this.syncToolbarMode();
        this.scheduleLayoutSync();
      }
    });

    overlayEl.addEventListener("mouseleave", () => {
      if ((this.pane?.dataset.toolbarMode as ToolbarDisplayMode | undefined) === "collapsed") {
        this.toolbarExpanded = false;
        this.syncToolbarMode();
        this.scheduleLayoutSync();
      }
    });

    this.bindResize(resizeHandle);

    host.appendChild(pane);
    this.host = host;
    this.pane = pane;
    this.paneBody = paneBody;
    this.statusBadgeEl = statusBadgeEl;
    this.messageEl = messageEl;
    this.overlayEl = overlayEl;
    this.sourceContainer = source;
    this.scrollRoot = this.findScrollRoot(source);
    this.resizeHandle = resizeHandle;
    this.bindSharedResizeObservers();
  }

  public render(state: PaneRenderState): void {
    if (!this.pane || !this.paneBody || !this.statusBadgeEl || !this.messageEl || !this.host) {
      return;
    }

    this.host.style.setProperty("--typora-bilingual-pane-width", `${state.paneWidthPercent}%`);
    this.pane.classList.toggle("is-hidden", !state.isVisible);
    if (!state.isVisible) {
      return;
    }

    this.pane.dataset.toolbarMode = state.toolbarDisplayMode;
    const translateButton = this.pane.querySelector<HTMLButtonElement>('[data-action="translate-all"]');
    const refreshButton = this.pane.querySelector<HTMLButtonElement>('[data-action="refresh-stale"]');
    const cancelButton = this.pane.querySelector<HTMLButtonElement>('[data-action="cancel-translation"]');
    const languageSelect = this.pane.querySelector<HTMLSelectElement>('[data-action="target-language"]');
    const collapsedToggle = this.pane.querySelector<HTMLButtonElement>('[data-action="toggle-toolbar"]');
    if (translateButton && refreshButton && cancelButton) {
      translateButton.disabled = state.isTranslating;
      refreshButton.disabled = state.isTranslating;
      cancelButton.classList.toggle("is-hidden", !state.isTranslating);
    }
    if (languageSelect) {
      languageSelect.value = state.targetLang;
      languageSelect.disabled = state.isTranslating;
    }
    if (collapsedToggle) {
      collapsedToggle.textContent = getTargetLanguageDefinition(state.targetLang).shortLabel;
    }
    if (state.toolbarDisplayMode === "compact") {
      this.toolbarExpanded = true;
    }
    this.syncToolbarMode();
    const unsupportedReason = !state.association?.isSupportedSource ? state.association?.reason ?? "当前文件不受支持。" : null;
    this.renderStatus(state, unsupportedReason);
    this.renderPresetState(state.paneWidthPercent);

    this.paneBody.innerHTML = "";

    if (!state.association?.isSupportedSource) {
      this.paneBody.appendChild(this.createEmptyState(unsupportedReason ?? "当前文件不受支持。"));
      this.scheduleLayoutSync();
      return;
    }

    if (!state.targetMarkdown) {
      this.paneBody.appendChild(this.createEmptyState("还没有缓存译文。执行“全文翻译”后会在插件缓存区生成译文。"));
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
      blockEl.innerHTML = this.markdown.render(markdown);
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
        handle.classList.remove("is-active");
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    });

    handle.addEventListener("dblclick", (event) => {
      event.preventDefault();
      this.applyPaneWidth(50, true);
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
    const cacheName = targetName || "未生成缓存译文";
    if (state.isTranslating) {
      return {
        kind: "idle",
        label: "翻译中",
        title: "翻译任务正在运行，可点击“取消翻译”停止。"
      };
    }
    if (state.errorMessage) {
      return {
        kind: "error",
        label: "错误",
        title: state.errorMessage,
        detail: state.errorMessage,
        detailKind: "error"
      };
    }

    if (unsupportedReason) {
      return {
        kind: "idle",
        label: "未翻译",
        title: unsupportedReason,
        detail: unsupportedReason,
        detailKind: "warning"
      };
    }

    if (state.warningMessage || state.staleCount > 0) {
      return {
        kind: "stale",
        label: "译文过期",
        title: state.warningMessage ?? `${cacheName} 已过期，当前脏区 ${state.staleCount}`,
        detail: state.warningMessage ?? `${cacheName} 已过期，当前脏区 ${state.staleCount}`,
        detailKind: "warning"
      };
    }

    if (state.targetMarkdown) {
      return {
        kind: "cached",
        label: "已缓存",
        title: state.infoMessage ?? `${cacheName} | 缓存译文`
      };
    }

    return {
      kind: "idle",
      label: "未翻译",
      title: "还没有缓存译文。执行“全文翻译”后会在插件缓存区生成译文。"
    };
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
