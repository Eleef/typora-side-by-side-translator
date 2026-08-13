const FNV_OFFSET_BASIS_64 = 0xcbf29ce484222325n;
const FNV_PRIME_64 = 0x100000001b3n;

function fnv1a64(input: string): string {
  let hash = FNV_OFFSET_BASIS_64;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= BigInt(input.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * FNV_PRIME_64);
  }
  return hash.toString(16).padStart(16, "0");
}

export function createStableCacheKey(sourcePath: string, basename: string): string {
  const readable = basename.replace(/[^\w.-]+/g, "_").slice(0, 64) || "document";
  const slashNormalized = sourcePath.replace(/\\/g, "/");
  const isWindowsPath = /^[a-zA-Z]:\//.test(slashNormalized) || slashNormalized.startsWith("//");
  const normalizedIdentity = isWindowsPath ? slashNormalized.toLowerCase() : slashNormalized;
  return `${readable}-${fnv1a64(normalizedIdentity)}`;
}

export function createLegacyCacheKey(sourcePath: string): string {
  const sanitized = sourcePath
    .replace(/[:]/g, "")
    .replace(/[\\/]+/g, "__")
    .replace(/[^\w\-.]+/g, "_")
    .slice(-120);
  return sanitized || "untitled";
}
