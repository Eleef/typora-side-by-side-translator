import { TranslationBlock } from "../types";

export class AnchorMappingService {
  public findCurrentSourceBlock(blocks: TranslationBlock[], sourceRoot: HTMLElement): TranslationBlock | null {
    const elements = Array.from(sourceRoot.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6, p, li, blockquote, table"));
    let candidate: HTMLElement | null = null;

    for (const element of elements) {
      const rect = element.getBoundingClientRect();
      if (rect.bottom >= 80) {
        candidate = element;
        break;
      }
    }

    if (!candidate) {
      return blocks.length > 0 ? blocks[blocks.length - 1] : null;
    }

    const headingPath = this.findHeadingPath(candidate, sourceRoot);
    const headingMatch = blocks.find((block) => this.serializeHeadingPath(block.headingPath) === this.serializeHeadingPath(headingPath));
    if (headingMatch) {
      return headingMatch;
    }

    return blocks[0] ?? null;
  }

  public findTargetElementForBlock(block: TranslationBlock, paneBody: HTMLElement): HTMLElement | null {
    const serialized = this.serializeHeadingPath(block.headingPath);
    const headingElement = serialized ? paneBody.querySelector<HTMLElement>(`[data-heading-path="${serialized}"]`) : null;
    if (headingElement) {
      return headingElement;
    }
    return paneBody.querySelector<HTMLElement>(`[data-block-id="${block.id}"]`);
  }

  public serializeHeadingPath(path: string[]): string {
    return path.join(" > ");
  }

  public findHeadingPath(element: HTMLElement, sourceRoot: HTMLElement): string[] {
    const headings = Array.from(sourceRoot.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"));
    const currentTop = element.getBoundingClientRect().top;
    const active: Array<{ depth: number; text: string }> = [];

    for (const heading of headings) {
      if (heading.getBoundingClientRect().top > currentTop) {
        break;
      }
      const depth = Number(heading.tagName.slice(1));
      active.length = depth - 1;
      active[depth - 1] = { depth, text: heading.innerText.trim() };
    }

    return active.filter(Boolean).map((item) => item.text);
  }
}
