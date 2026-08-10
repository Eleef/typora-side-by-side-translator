import { TranslationBlock } from "../types";
import { AnchorMappingService } from "./AnchorMappingService";

export class ScrollSyncService {
  private cleanupFn: (() => void) | null = null;

  public bind(options: {
    scrollRoot: HTMLElement | Window;
    sourceRoot: HTMLElement;
    blocks: TranslationBlock[];
    anchorMapping: AnchorMappingService;
    onActiveBlock: (blockId: string | null) => void;
  }): void {
    this.unbind();

    const handler = () => {
      const block = options.anchorMapping.findCurrentSourceBlock(options.blocks, options.sourceRoot);
      if (!block) {
        options.onActiveBlock(null);
        return;
      }

      options.onActiveBlock(block.id);
    };

    if (options.scrollRoot instanceof Window) {
      options.scrollRoot.addEventListener("scroll", handler, { passive: true });
      handler();
      this.cleanupFn = () => options.scrollRoot.removeEventListener("scroll", handler);
      return;
    }

    options.scrollRoot.addEventListener("scroll", handler, { passive: true });
    handler();
    this.cleanupFn = () => options.scrollRoot.removeEventListener("scroll", handler);
  }

  public unbind(): void {
    if (this.cleanupFn) {
      this.cleanupFn();
      this.cleanupFn = null;
    }
  }
}
