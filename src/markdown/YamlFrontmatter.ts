import { isMap, isScalar, parseDocument, type Scalar } from "yaml";

const DESCRIPTIVE_KEYS = new Set(["title", "description", "summary", "subtitle", "abstract", "excerpt"]);

export function getYamlFrontmatterBody(markdown: string): string | null {
  const lines = markdown.trimEnd().split("\n");
  if (lines.length < 2 || !/^---[ \t]*$/.test(lines[0]) || lines[lines.length - 1] !== "---") {
    return null;
  }
  return lines.slice(1, -1).join("\n");
}

export function planYamlFrontmatterTranslation(markdown: string) {
  const body = getYamlFrontmatterBody(markdown);
  if (body === null) {
    return null;
  }
  const document = parseDocument(body);
  if (document.errors.length || document.warnings.length || !isMap(document.contents)) {
    return null;
  }

  const fields = new Map<string, Scalar>();
  for (const { key, value } of document.contents.items) {
    if (isScalar(key) && typeof key.value === "string" && DESCRIPTIVE_KEYS.has(key.value) &&
      isScalar(value) && typeof value.value === "string" && value.value.trim() && !value.anchor && !value.tag) {
      fields.set(key.value, value);
    }
  }
  if (fields.size === 0) {
    return null;
  }

  return {
    values: Object.fromEntries([...fields].map(([key, node]) => [key, node.value as string])),
    render(values: unknown): string | null {
      if (!values || typeof values !== "object" || Array.isArray(values) || Object.keys(values).length !== fields.size) {
        return null;
      }
      const translated = values as Record<string, unknown>;
      for (const key of fields.keys()) {
        const value = translated[key];
        if (!Object.prototype.hasOwnProperty.call(translated, key) || typeof value !== "string" || !value.trim()) {
          return null;
        }
      }
      for (const [key, node] of fields) {
        node.value = translated[key];
      }
      return `---\n${document.toString({ lineWidth: 0 })}---`;
    }
  };
}
