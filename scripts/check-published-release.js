const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { inspectZip } = require("./zip-inspector");
const { checksumFilename, parseChecksum, releaseFiles, sha256Buffer } = require("./release-checksum");

const workspace = path.resolve(__dirname, "..");
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
const maximumAssetBytes = 32 * 1024 * 1024;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function parseArguments(argv) {
  const manifest = JSON.parse(fs.readFileSync(path.join(workspace, "manifest.json"), "utf8"));
  const options = { repo: manifest.repo, version: manifest.version };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== "--repo" && argument !== "--version") {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${argument}`);
    }
    options[argument.slice(2)] = value;
    index += 1;
  }
  assert(/^[^/]+\/[^/]+$/.test(options.repo), `Invalid GitHub repository: ${options.repo}`);
  assert(options.version, "Published version is required.");
  return options;
}

function validateReleaseInfo(release, version) {
  assert(release && typeof release === "object", "GitHub release response is invalid.");
  assert(release.tag_name === version, `Published tag ${release.tag_name} does not match ${version}.`);
  assert(release.draft === false, `Release ${version} is still a draft.`);
  assert(release.prerelease === version.includes("-"), `Release ${version} prerelease state is incorrect.`);
  assert(Array.isArray(release.assets), `Release ${version} has no asset list.`);
  return release;
}

function requestHeaders() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "typora-side-by-side-translator-release-check",
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
}

async function fetchRequired(url, fetchImpl) {
  const response = await fetchImpl(url, { headers: requestHeaders(), redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}`);
  }
  return response;
}

async function readLimitedBuffer(response, label) {
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > maximumAssetBytes) {
    throw new Error(`${label} exceeds the ${maximumAssetBytes}-byte limit.`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maximumAssetBytes) {
    throw new Error(`${label} exceeds the ${maximumAssetBytes}-byte limit.`);
  }
  return buffer;
}

async function fetchRelease(repo, endpoint, fetchImpl) {
  const response = await fetchRequired(`https://api.github.com/repos/${repo}/releases/${endpoint}`, fetchImpl);
  return response.json();
}

async function verifyPublishedRelease(options, fetchImpl = globalThis.fetch) {
  assert(typeof fetchImpl === "function", "A fetch implementation is required.");
  const { repo, version } = options;
  const release = validateReleaseInfo(await fetchRelease(repo, `tags/${encodeURIComponent(version)}`, fetchImpl), version);
  if (!version.includes("-")) {
    const latest = await fetchRelease(repo, "latest", fetchImpl);
    assert(latest.tag_name === version, `GitHub latest release is ${latest.tag_name}, expected ${version}.`);
  }

  const checksumAsset = release.assets.find((asset) => asset.name === checksumFilename);
  assert(checksumAsset?.browser_download_url, `Release ${version} is missing ${checksumFilename}.`);
  const checksumResponse = await fetchRequired(checksumAsset.browser_download_url, fetchImpl);
  const checksumBuffer = await readLimitedBuffer(checksumResponse, checksumFilename);
  const checksumText = checksumBuffer.toString("utf8");
  const publishedFiles = new Map();
  for (const releaseFile of releaseFiles) {
    const asset = release.assets.find((candidate) => candidate.name === releaseFile.name);
    assert(asset?.browser_download_url, `Release ${version} is missing ${releaseFile.name}.`);
    const response = await fetchRequired(asset.browser_download_url, fetchImpl);
    const buffer = await readLimitedBuffer(response, releaseFile.name);
    const expectedHash = parseChecksum(checksumText, releaseFile.name);
    const actualHash = sha256Buffer(buffer);
    assert(actualHash === expectedHash, `Published ${releaseFile.name} checksum mismatch: ${actualHash} != ${expectedHash}`);
    publishedFiles.set(releaseFile.name, { buffer, hash: actualHash });
  }
  const zipBuffer = publishedFiles.get("plugin.zip").buffer;
  const actualHash = publishedFiles.get("plugin.zip").hash;

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "typora-side-by-side-release-"));
  try {
    const zipPath = path.join(temporaryDirectory, "plugin.zip");
    fs.writeFileSync(zipPath, zipBuffer);
    const entries = inspectZip(zipPath);
    const names = entries.map((entry) => entry.name).sort();
    assert(JSON.stringify(names) === JSON.stringify(expectedEntries), `Unexpected published ZIP entries: ${names.join(", ")}`);
    const manifestEntry = entries.find((entry) => entry.name === "manifest.json");
    const manifest = JSON.parse(manifestEntry.data.toString("utf8"));
    assert(manifest.id === "eleef.typora-side-by-side-translator", `Unexpected published plugin id: ${manifest.id}`);
    assert(manifest.repo === repo, `Published manifest repo ${manifest.repo} does not match ${repo}.`);
    assert(manifest.version === version, `Published manifest version ${manifest.version} does not match ${version}.`);
    assert(JSON.stringify(manifest.platforms) === JSON.stringify(["win32", "darwin"]), "Published manifest platform contract is incorrect.");
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }

  console.log(`verified_published_release=${repo}@${version}`);
  console.log(`published_sha256=${actualHash}`);
  return { release, sha256: actualHash };
}

if (require.main === module) {
  verifyPublishedRelease(parseArguments(process.argv.slice(2))).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

module.exports = { parseArguments, validateReleaseInfo, verifyPublishedRelease };
