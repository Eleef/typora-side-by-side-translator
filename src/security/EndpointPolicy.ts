const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export function normalizeAndValidateBaseUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return "";
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("baseUrl 不是有效的网址。");
  }

  if (url.username || url.password) {
    throw new Error("baseUrl 不能包含用户名或密码。");
  }
  if (url.search || url.hash) {
    throw new Error("baseUrl 不能包含查询参数或页面锚点。");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const isLoopback = LOOPBACK_HOSTS.has(hostname);
  const isAllowedProtocol = url.protocol === "https:" || (url.protocol === "http:" && isLoopback);
  if (!isAllowedProtocol) {
    throw new Error("远程翻译服务必须使用 HTTPS；只有本机 localhost、127.0.0.1 或 ::1 可以使用 HTTP。");
  }

  return url.toString().replace(/\/+$/, "");
}

export function describeEndpointForDiagnostics(input: string): string {
  try {
    const url = new URL(input);
    return url.origin;
  } catch {
    return input ? "<invalid-endpoint>" : "<not-configured>";
  }
}
