const fs = require("node:fs");
const path = require("node:path");
const { checksumFilename, parseChecksum, releaseFiles, sha256File } = require("./release-checksum");
const { isValidVersion } = require("./set-version");
const { inspectZip } = require("./zip-inspector");

const workspace = path.resolve(__dirname, "..");
const buildDir = path.join(workspace, "build", "typora-side-by-side-translator");
const zipPath = path.join(workspace, "release", "plugin.zip");
const checksumPath = path.join(workspace, "release", checksumFilename);
const expectedEntries = [
  "locales/lang.en.json",
  "locales/lang.ja.json",
  "locales/lang.ko.json",
  "locales/lang.zh-cn.json",
  "locales/lang.zh-tw.json",
  "main.js",
  "manifest.json",
  "style.css"
];
const packageOnly = process.argv.includes("--package-only");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertReleaseMetadata(manifest, packageJson) {
  assert(manifest.id === "eleef.typora-side-by-side-translator", "Unexpected plugin id.");
  assert(manifest.name === "Typora Side-by-Side Translator", "Unexpected plugin name.");
  assert(manifest.author === "Eleef", "Manifest author must be Eleef.");
  assert(manifest.authorUrl === "https://github.com/Eleef", "Manifest authorUrl is invalid.");
  assert(manifest.repo === "Eleef/typora-side-by-side-translator", "Manifest repo is invalid.");
  assert(manifest.minAppVersion === "1.12.4", "Manifest minAppVersion must match the tested baseline.");
  assert(manifest.minCoreVersion === "2.5.28", "Manifest minCoreVersion is invalid.");
  assert(JSON.stringify(manifest.platforms) === JSON.stringify(["win32", "darwin"]), "Manifest platforms must declare the Windows baseline and macOS candidate.");
  assert(!("entry" in manifest), "Manifest entry is not used by the community plugin core.");
  assert(!("homepage" in manifest), "Manifest homepage is not part of the current core contract.");
  assert(packageJson.private === true, "package.json must remain private to prevent accidental npm publishing.");
  assert(packageJson.license === "MIT", "package.json license must be MIT.");
  assert(packageJson.repository?.url === "https://github.com/Eleef/typora-side-by-side-translator.git", "Repository URL is invalid.");
  assert(fs.existsSync(path.join(workspace, "LICENSE")), "LICENSE is missing.");
}

function main() {
  const packageJson = readJson(path.join(workspace, "package.json"));
  const packageLock = readJson(path.join(workspace, "package-lock.json"));
  const sourceManifest = readJson(path.join(workspace, "manifest.json"));
  const buildManifest = readJson(path.join(buildDir, "manifest.json"));
  assert(packageJson.version === sourceManifest.version, "package.json and manifest versions differ.");
  assert(packageLock.version === sourceManifest.version, "package-lock.json and manifest versions differ.");
  assert(packageLock.packages?.[""]?.version === sourceManifest.version, "package-lock root package and manifest versions differ.");
  assert(isValidVersion(sourceManifest.version), `Invalid manifest version: ${sourceManifest.version}`);
  assert(JSON.stringify(sourceManifest) === JSON.stringify(buildManifest), "Build manifest differs from source manifest.");
  assertReleaseMetadata(sourceManifest, packageJson);

  if (!packageOnly) {
    const tag = process.env.RELEASE_TAG || process.env.GITHUB_REF_NAME || "";
    assert(tag, "RELEASE_TAG or GITHUB_REF_NAME is required for release validation.");
    assert(!tag.startsWith("v"), "Release tag must not use a v prefix.");
    assert(isValidVersion(tag), `Invalid release tag: ${tag}`);
    assert(tag === sourceManifest.version, `Release tag ${tag} does not match manifest version ${sourceManifest.version}.`);
  }

  assert(fs.existsSync(zipPath), `Missing release package: ${zipPath}`);
  assert(fs.existsSync(checksumPath), `Missing release checksum: ${checksumPath}`);
  const checksumText = fs.readFileSync(checksumPath, "utf8");
  for (const releaseFile of releaseFiles) {
    const filePath = path.join(workspace, releaseFile.relativePath);
    const expectedHash = parseChecksum(checksumText, releaseFile.name);
    const actualFileHash = sha256File(filePath);
    assert(expectedHash === actualFileHash, `Release checksum mismatch for ${releaseFile.name}: ${expectedHash} != ${actualFileHash}`);
  }
  const actualHash = sha256File(zipPath);
  const entries = inspectZip(zipPath);
  const names = entries.map((entry) => entry.name).sort();
  assert(JSON.stringify(names) === JSON.stringify(expectedEntries), `Unexpected ZIP entries: ${names.join(", ")}`);
  assert(names.every((name) => !name.includes("\\")), "ZIP entries must use forward slashes.");
  assert(names.filter((name) => name.includes("/")).every((name) => name.startsWith("locales/")), "Only locale resources may be nested.");

  const zippedManifestEntry = entries.find((entry) => entry.name === "manifest.json");
  assert(zippedManifestEntry, "ZIP manifest is missing.");
  const zippedManifest = JSON.parse(zippedManifestEntry.data.toString("utf8"));
  assert(JSON.stringify(zippedManifest) === JSON.stringify(sourceManifest), "ZIP manifest differs from source manifest.");

  for (const forbiddenPath of [
    path.join(workspace, "dist", "main.js.map"),
    path.join(buildDir, "main.js.map")
  ]) {
    assert(!fs.existsSync(forbiddenPath), `Source map must not be published: ${forbiddenPath}`);
  }

  console.log(`verified_package=${zipPath}`);
  console.log(`entries=${names.join(",")}`);
  console.log(`version=${sourceManifest.version}`);
  console.log(`sha256=${actualHash}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
