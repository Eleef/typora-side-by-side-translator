import { TranslationBlockType } from "../types";

export interface AlignmentTarget {
  id: string;
  type: TranslationBlockType;
  key: string | null;
  element: HTMLElement;
}

type AlignmentSource = Omit<AlignmentTarget, "id">;
type BlockPair = { source: AlignmentSource; target: AlignmentTarget };

export function blockTextKey(root: ParentNode): string | null {
  const readText = (node: Node): string => {
    if (node.nodeType === 3) {
      return node.nodeValue ?? "";
    }
    if (node.nodeType === 1) {
      const element = node as HTMLElement;
      if (element.matches(".md-meta, .md-tooltip, .md-tooltip-hide, .md-rawblock-control")) {
        return "";
      }
      if (element.matches("img")) {
        return element.getAttribute("alt") ?? "";
      }
    }
    return Array.from(node.childNodes, readText).join("");
  };
  return readText(root as Node).split(String.fromCodePoint(8203)).join("").replace(/\s+/g, "").normalize("NFC") || null;
}

function sourceBlockType(element: HTMLElement): TranslationBlockType | null {
  if (element.matches(".md-meta-block")) return "frontmatter";
  if (element.matches("h1, h2, h3, h4, h5, h6")) return "heading";
  if (element.matches("p")) return "paragraph";
  if (element.matches("ul, ol")) return "list";
  if (element.matches("blockquote, .md-alert")) return "blockquote";
  if (element.matches("table, .md-table-fig")) return "table";
  if (element.matches("pre, .md-fences")) return "code";
  if (element.matches(".mathjax-block, .md-math-block")) return "math";
  if (element.matches(".md-htmlblock")) return "html";
  if (element.matches("hr, .md-hr, .md-def-link, .md-def-footnote")) return "passthrough";
  return null;
}

export function hasComparableText(type: TranslationBlockType): boolean {
  return type === "heading" || type === "paragraph" || type === "list" || type === "blockquote" ||
    type === "table" || type === "frontmatter";
}

function uniquePositions(blocks: readonly AlignmentSource[]): Map<string, number> {
  const positions = new Map<string, number>();
  blocks.forEach(({ type, key }, index) => {
    if (key !== null) {
      const signature = `${type}:${key}`;
      positions.set(signature, positions.has(signature) ? -1 : index);
    }
  });
  return positions;
}

function pairBlocks(sources: AlignmentSource[], targets: readonly AlignmentTarget[]): BlockPair[] {
  const sourcePositions = uniquePositions(sources);
  const targetPositions = uniquePositions(targets);
  const pairs: BlockPair[] = [];
  let sourceStart = 0;
  let targetStart = 0;

  const pairGap = (sourceEnd: number, targetEnd: number) => {
    const length = sourceEnd - sourceStart;
    if (length !== targetEnd - targetStart) {
      return;
    }
    const gap: BlockPair[] = [];
    for (let offset = 0; offset < length; offset += 1) {
      const source = sources[sourceStart + offset];
      const target = targets[targetStart + offset];
      if (source.type !== target.type || source.key !== target.key) {
        return;
      }
      gap.push({ source, target });
    }
    pairs.push(...gap);
  };

  targets.forEach((target, targetIndex) => {
    if (target.key === null) {
      return;
    }
    const signature = `${target.type}:${target.key}`;
    const sourceIndex = sourcePositions.get(signature) ?? -1;
    if (sourceIndex < sourceStart || targetPositions.get(signature) !== targetIndex) {
      return;
    }
    pairGap(sourceIndex, targetIndex);
    pairs.push({ source: sources[sourceIndex], target });
    sourceStart = sourceIndex + 1;
    targetStart = targetIndex + 1;
  });
  pairGap(sources.length, targets.length);
  return pairs;
}

export class BlockAlignment {
  private readonly margins = new Map<HTMLElement, { value: string; priority: string }>();
  private sourceRoot: HTMLElement | null = null;

  public clear(): void {
    this.restoreMargins();
    this.sourceRoot?.classList.remove("typora-bilingual-aligned-source");
    this.sourceRoot = null;
  }

  public align(sourceRoot: HTMLElement, targets: readonly AlignmentTarget[]): Map<string, HTMLElement> {
    this.restoreMargins();
    const matched = new Map<string, HTMLElement>();
    if (!targets.length || !sourceRoot.getClientRects().length) {
      this.clear();
      return matched;
    }

    const sources = Array.from(sourceRoot.children).flatMap((child): AlignmentSource[] => {
      const element = child as HTMLElement;
      const type = sourceBlockType(element);
      if (!type) {
        return [];
      }
      const key = hasComparableText(type) ? blockTextKey(element) : null;
      if (type === "paragraph" && key === null && !element.querySelector("img, .md-image")) {
        return [];
      }
      return [{ type, key, element }];
    });
    const pairs = pairBlocks(sources, targets);
    if (!pairs.length) {
      this.clear();
      return matched;
    }

    this.sourceRoot = sourceRoot;
    sourceRoot.classList.add("typora-bilingual-aligned-source");
    const positions = pairs.flatMap(({ source, target }) => {
      const sourceAnchor = source.element.matches(".md-table-fig, .md-hr")
        ? source.element.firstElementChild ?? source.element : source.element;
      const targetAnchor = target.element.firstElementChild ?? target.element;
      if (!sourceAnchor.getClientRects().length || !target.element.firstChild || !targetAnchor.getClientRects().length) {
        return [];
      }
      return [{
        source, target,
        sourceTop: sourceAnchor.getBoundingClientRect().top,
        targetTop: targetAnchor.getBoundingClientRect().top,
        sourceMargin: this.marginTop(source.element),
        targetMargin: this.marginTop(target.element)
      }];
    });

    let sourceOffset = 0;
    let targetOffset = 0;
    for (const { source, target, sourceTop, targetTop, sourceMargin, targetMargin } of positions) {
      const difference = sourceTop + sourceOffset - targetTop - targetOffset;
      if (difference > 0.5) {
        this.addMargin(target.element, targetMargin, difference);
        targetOffset += difference;
      } else if (difference < -0.5) {
        this.addMargin(source.element, sourceMargin, -difference);
        sourceOffset -= difference;
      }
      matched.set(target.id, source.element);
    }
    return matched;
  }

  private marginTop(element: HTMLElement): number {
    return Number.parseFloat(element.ownerDocument.defaultView?.getComputedStyle(element).marginTop ?? "") || 0;
  }

  private addMargin(element: HTMLElement, baseline: number, spacing: number): void {
    this.margins.set(element, {
      value: element.style.getPropertyValue("margin-top"),
      priority: element.style.getPropertyPriority("margin-top")
    });
    element.style.setProperty("margin-top", `${baseline + spacing}px`, "important");
  }

  private restoreMargins(): void {
    for (const [element, { value, priority }] of this.margins) {
      element.style.setProperty("margin-top", value, priority);
    }
    this.margins.clear();
  }
}
