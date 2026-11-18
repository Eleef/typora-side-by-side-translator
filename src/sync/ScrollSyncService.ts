export class ScrollSyncService {
  private cleanupFn: (() => void) | null = null;
  private handler: (() => void) | null = null;

  public bind(options: {
    scrollRoot: HTMLElement | Window;
    sourceBlocks: () => ReadonlyMap<string, HTMLElement>;
    onActiveBlock: (blockId: string | null) => void;
  }): void {
    this.unbind();

    const handler = () => {
      const top = "getBoundingClientRect" in options.scrollRoot
        ? options.scrollRoot.getBoundingClientRect().top + 24 : 80;
      let active: string | null = null;
      for (const [id, element] of options.sourceBlocks()) {
        active = id;
        if (element.getBoundingClientRect().bottom >= top) {
          break;
        }
      }
      options.onActiveBlock(active);
    };
    this.handler = handler;
    options.scrollRoot.addEventListener("scroll", handler, { passive: true });
    this.cleanupFn = () => options.scrollRoot.removeEventListener("scroll", handler);
  }

  public refresh(): void {
    this.handler?.();
  }

  public unbind(): void {
    if (this.cleanupFn) {
      this.cleanupFn();
      this.cleanupFn = null;
    }
    this.handler = null;
  }
}
