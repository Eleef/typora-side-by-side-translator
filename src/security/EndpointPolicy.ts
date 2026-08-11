import { UserFacingError } from "../i18n/UserFacingError";

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
    throw new UserFacingError("invalidBaseUrl");
  }

  if (url.username || url.password) {
    throw new UserFacingError("baseUrlCredentials");
  }
  if (url.search || url.hash) {
    throw new UserFacingError("baseUrlQuery");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const isLoopback = LOOPBACK_HOSTS.has(hostname);
  const isAllowedProtocol = url.protocol === "https:" || (url.protocol === "http:" && isLoopback);
  if (!isAllowedProtocol) {
    throw new UserFacingError("insecureRemote");
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
