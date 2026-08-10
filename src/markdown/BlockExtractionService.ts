import { Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { TranslationBlock, TranslationBlockType } from "../types";
import { normalizeLineEndings, sha256, slugifyHeading } from "../utils";
import { createTranslationBlockId } from "./BlockIdentity";

interface MdNode {
  type: string;
  children?: MdNode[];
  depth?: number;
  value?: string;
  position?: {
    start?: { offset?: number };
    end?: { offset?: number };
  };
}

export class BlockExtractionService {
  private readonly processor = unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkStringify);

  public async extract(markdown: string): Promise<TranslationBlock[]> {
    const normalizedMarkdown = normalizeLineEndings(markdown);
    const tree = this.processor.parse(normalizedMarkdown) as Root;
    const blocks: TranslationBlock[] = [];
    const currentHeadingPath: string[] = [];
    const headingLevels: string[] = [];
    let order = 0;

    const rootChildren = (tree.children ?? []) as MdNode[];
    for (const node of rootChildren) {
      const type = this.mapType(node);

      if (type === "heading") {
        const title = this.extractHeadingText(node);
        const depth = node.depth ?? 1;
        headingLevels.length = depth - 1;
        headingLevels[depth - 1] = title;
        currentHeadingPath.length = 0;
        currentHeadingPath.push(...headingLevels.filter(Boolean));
      }

      const sourceMarkdown = this.serializeNode(node, type, normalizedMarkdown);
      const headingPath = [...currentHeadingPath];
      const id = await createTranslationBlockId(type, order);
      blocks.push({
        id,
        type,
        sourceMarkdown,
        headingPath,
        order,
        translatable: this.isTranslatable(type),
        sourceHash: await sha256(`${type}\n${sourceMarkdown}`),
        anchorSlug: type === "heading" ? slugifyHeading(this.extractHeadingText(node)) : undefined
      });
      order += 1;
    }

    return blocks;
  }

  private mapType(node: MdNode): TranslationBlockType {
    switch (node.type) {
      case "heading":
      case "paragraph":
      case "list":
      case "blockquote":
      case "table":
      case "html":
      case "code":
        return node.type;
      case "math":
      case "inlineMath":
        return "math";
      default:
        return "passthrough";
    }
  }

  private isTranslatable(type: TranslationBlockType): boolean {
    return type === "heading" || type === "paragraph" || type === "list" || type === "blockquote" || type === "table";
  }

  private serializeNode(node: MdNode, type: TranslationBlockType, sourceMarkdown: string): string {
    if (type === "passthrough") {
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      if (typeof start === "number" && typeof end === "number") {
        return sourceMarkdown.slice(start, end).trim();
      }
    }

    return normalizeLineEndings(this.processor.stringify({ type: "root", children: [node] } as never)).trim();
  }

  private extractHeadingText(node: MdNode): string {
    if (!node.children || node.children.length === 0) {
      return "";
    }

    let text = "";
    visit(node as never, (child: MdNode) => {
      if (typeof child.value === "string") {
        text += child.value;
      }
    });
    return text.trim();
  }
}
