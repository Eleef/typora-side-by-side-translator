import DOMPurify, { Config, WindowLike } from "dompurify";

const TRANSLATION_HTML_POLICY: Config = {
  ALLOWED_TAGS: [
    "a",
    "blockquote",
    "br",
    "code",
    "del",
    "em",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "li",
    "ol",
    "p",
    "pre",
    "s",
    "span",
    "strong",
    "sub",
    "sup",
    "table",
    "tbody",
    "td",
    "th",
    "thead",
    "tr",
    "ul"
  ],
  ALLOWED_ATTR: ["class", "colspan", "href", "rowspan", "title"],
  ALLOW_ARIA_ATTR: false,
  ALLOW_DATA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false
};

export function createTranslationHtmlSanitizer(windowLike: WindowLike): (html: string) => string {
  const purifier = DOMPurify(windowLike);
  return (html: string) => String(purifier.sanitize(html, TRANSLATION_HTML_POLICY));
}
