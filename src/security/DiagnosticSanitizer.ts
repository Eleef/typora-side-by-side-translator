const REDACTED = "<redacted>";
const LOCAL_PATH = "<local-path>";
const SENSITIVE_KEY = /(api.?key|authorization|cookie|credential|password|secret|token)/i;
const PATH_KEY = /(path|directory|dir|filename)$/i;
const URL_KEY = /(base.?url|endpoint|url)$/i;
const WINDOWS_PATH = /[a-zA-Z]:\\+(?:[^\s"'<>|]+\\+)*[^\s"'<>|]*/g;
const HTTP_URL = /https?:\/\/[^\s"'<>]+/gi;
const BEARER_TOKEN = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const API_KEY_TOKEN = /\bsk-[A-Za-z0-9_-]{8,}\b/g;

function sanitizeString(value: string): string {
  return value
    .replace(BEARER_TOKEN, "Bearer <redacted>")
    .replace(API_KEY_TOKEN, REDACTED)
    .replace(HTTP_URL, (url) => sanitizeUrl(url))
    .replace(WINDOWS_PATH, LOCAL_PATH);
}

function sanitizeUrl(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return "<invalid-endpoint>";
  }
}

function sanitizeValue(value: unknown, key: string | null, seen: WeakSet<object>, depth: number): unknown {
  if (key && SENSITIVE_KEY.test(key)) {
    return REDACTED;
  }
  if (key && PATH_KEY.test(key) && typeof value === "string") {
    return LOCAL_PATH;
  }
  if (key && URL_KEY.test(key) && typeof value === "string") {
    return sanitizeUrl(value);
  }
  if (typeof value === "string") {
    return sanitizeString(value);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (depth >= 6) {
    return "<max-depth>";
  }
  if (seen.has(value)) {
    return "<circular>";
  }

  seen.add(value);
  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeString(value.message),
      stack: value.stack ? sanitizeString(value.stack) : undefined
    };
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, null, seen, depth + 1));
  }

  const sanitized: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
    sanitized[childKey] = sanitizeValue(childValue, childKey, seen, depth + 1);
  }
  return sanitized;
}

export function sanitizeDiagnosticMeta(meta: unknown): unknown {
  return sanitizeValue(meta, null, new WeakSet<object>(), 0);
}
