import { Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { UserFacingError } from "../i18n/UserFacingError";
import { normalizeLineEndings } from "../utils";

interface MutableNode {
  type: string;
  children?: MutableNode[];
  value?: string;
  url?: string;
  title?: string | null;
  identifier?: string;
  label?: string;
  depth?: number;
  ordered?: boolean;
  start?: number | null;
}

interface ProtectedValue {
  token: string;
  placeholder: string;
  value: string;
}

export interface ProtectedMarkdown {
  markdown: string;
  restoreAndValidate(translatedMarkdown: string): string;
}

const TOKEN_PATTERN = /TYPORASIDEBYSIDEPROTECTED\d+TOKEN/g;

export class MarkdownStructureProtector {
  private readonly processor = unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkStringify);

  public protect(markdown: string): ProtectedMarkdown {
    const normalizedSource = normalizeLineEndings(markdown).trim();
    const protectedValues: ProtectedValue[] = [];
    const protectValue = (value: string, asHtml = false): string => {
      const token = `TYPORASIDEBYSIDEPROTECTED${protectedValues.length}TOKEN`;
      const placeholder = asHtml ? `<!--${token}-->` : token;
      protectedValues.push({ token, placeholder, value });
      return placeholder;
    };
    const sourceWithProtectedReferences = normalizedSource.replace(
      /!?\[[^\]\n]*\]\[[^\]\n]*\]/g,
      (reference) => protectValue(reference, true)
    );
    const tree = this.processor.parse(sourceWithProtectedReferences) as Root;

    visit(tree, (rawNode) => {
      const node = rawNode as MutableNode;
      if ((node.type === "inlineCode" || node.type === "inlineMath") && node.value) {
        node.value = protectValue(node.value);
      }
      if (node.type === "html" && node.value && !node.value.includes("TYPORASIDEBYSIDEPROTECTED")) {
        node.value = protectValue(node.value, true);
      }
      if ((node.type === "link" || node.type === "image" || node.type === "definition") && node.url) {
        node.url = protectValue(node.url);
        if (node.title) {
          node.title = protectValue(node.title);
        }
      }
      if (
        (node.type === "linkReference" || node.type === "imageReference" || node.type === "footnoteReference") &&
        node.identifier
      ) {
        const placeholder = protectValue(node.label ?? node.identifier);
        node.identifier = placeholder;
        node.label = placeholder;
      }
    });

    const protectedMarkdown = normalizeLineEndings(this.processor.stringify(tree)).trim();
    const expectedTree = this.processor.parse(protectedMarkdown) as Root;
    const expectedStructure = this.structureSignature(expectedTree as unknown as MutableNode);
    const expectedTokenContexts = this.tokenContexts(expectedTree as unknown as MutableNode);

    return {
      markdown: protectedMarkdown,
      restoreAndValidate: (translatedMarkdown) => {
        const normalizedTranslation = normalizeLineEndings(translatedMarkdown).trim();
        if (normalizedSource && !normalizedTranslation) {
          throw new UserFacingError("markdownProtectionFailed");
        }

        const receivedTokens = normalizedTranslation.match(TOKEN_PATTERN) ?? [];
        for (const { token } of protectedValues) {
          if (receivedTokens.filter((candidate) => candidate === token).length !== 1) {
            throw new UserFacingError("markdownProtectionFailed");
          }
        }
        if (receivedTokens.length !== protectedValues.length) {
          throw new UserFacingError("markdownProtectionFailed");
        }

        const translatedTree = this.processor.parse(normalizedTranslation) as Root;
        if (this.tokenContexts(translatedTree as unknown as MutableNode) !== expectedTokenContexts) {
          throw new UserFacingError("markdownProtectionFailed");
        }
        if (this.structureSignature(translatedTree as unknown as MutableNode) !== expectedStructure) {
          throw new UserFacingError("markdownProtectionFailed");
        }

        let restored = normalizedTranslation;
        for (const { placeholder, value } of protectedValues) {
          if (!restored.includes(placeholder)) {
            throw new UserFacingError("markdownProtectionFailed");
          }
          restored = restored.replace(placeholder, value);
        }
        return restored;
      }
    };
  }

  private structureSignature(node: MutableNode): string {
    const structuralChildren = (node.children ?? [])
      .map((child) => this.structureSignature(child))
      .filter(Boolean);
    switch (node.type) {
      case "root":
      case "paragraph":
      case "blockquote":
      case "listItem":
      case "table":
      case "tableRow":
      case "tableCell":
      case "emphasis":
      case "strong":
      case "delete":
      case "link":
      case "linkReference":
        return `${node.type}[${structuralChildren.join(",")}]`;
      case "heading":
        return `heading:${node.depth ?? 0}[${structuralChildren.join(",")}]`;
      case "list":
        return `list:${node.ordered ? "ordered" : "unordered"}:${node.start ?? ""}[${structuralChildren.join(",")}]`;
      case "image":
      case "imageReference":
      case "inlineCode":
      case "inlineMath":
      case "html":
      case "break":
      case "footnoteReference":
        return node.type;
      case "text":
        return "";
      default:
        return `${node.type}[${structuralChildren.join(",")}]`;
    }
  }

  private tokenContexts(root: MutableNode): string {
    const contexts: string[] = [];
    visit(root as never, (rawNode: MutableNode) => {
      const node = rawNode as MutableNode;
      for (const field of ["value", "url", "title", "identifier", "label"] as const) {
        const value = node[field];
        if (typeof value !== "string") {
          continue;
        }
        for (const token of value.match(TOKEN_PATTERN) ?? []) {
          contexts.push(`${token}:${node.type}:${field}`);
        }
      }
    });
    return contexts.join("|");
  }
}
