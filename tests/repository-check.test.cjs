const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { validateReleaseInfo } = require("../scripts/check-published-release");
const { findTextIssues, isForbiddenPath } = require("../scripts/check-repository");
const { formatChecksum, parseChecksum, sha256Buffer } = require("../scripts/release-checksum");
const { isValidVersion, setProjectVersion } = require("../scripts/set-version");

test("repository check rejects generated and environment files at any depth", () => {
  assert.equal(isForbiddenPath("dist/main.js"), true);
  assert.equal(isForbiddenPath("nested/build/main.js"), true);
  assert.equal(isForbiddenPath("config/.env.production"), true);
  assert.equal(isForbiddenPath("config/.env.example"), false);
  assert.equal(isForbiddenPath("src/main.ts"), false);
});

test("repository check detects credential and private-key patterns", () => {
  const apiKey = ["sk", "a".repeat(24)].join("-");
  const privateKeyHeader = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
  const issues = findTextIssues("unsafe.txt", `${apiKey}\n${privateKeyHeader}`);

  assert.equal(issues.length, 2);
  assert.match(issues[0], /API key/);
  assert.match(issues[1], /private key/);
});

test("repository check detects Windows and Unix local paths", () => {
  const windowsPath = ["D:", "private", "article.md"].join("\\");
  const unixPath = ["", "home", "owner", "article.md"].join("/");
  const issues = findTextIssues("unsafe.txt", `${windowsPath}\n${unixPath}`);

  assert.equal(issues.length, 2);
  assert.ok(issues.every((issue) => issue.includes("Local absolute path")));
});

test("repository check permits explicit sanitizer-test example paths", () => {
  const examplePath = ["C:", "Users", "alice", "private", "article.md"].join("\\");
  assert.deepEqual(findTextIssues("tests/example.ts", examplePath), []);
});

test("Windows installer writes plugin state JSON without a UTF-8 BOM", () => {
  const installer = fs.readFileSync(path.join(__dirname, "..", "scripts", "install-plugin.ps1"), "utf8");

  assert.match(installer, /\[Text\.UTF8Encoding\]::new\(\$false\)/);
  assert.match(installer, /\[IO\.File\]::WriteAllText\(\$pluginStatesPath,/);
  assert.doesNotMatch(installer, /Set-Content[^\r\n]*-Encoding\s+UTF8/i);
});

test("Windows installer gates installation on community market health and enables the plugin", () => {
  const installer = fs.readFileSync(path.join(__dirname, "..", "scripts", "install-plugin.ps1"), "utf8");

  assert.match(installer, /Mode\s*=\s*"Community"/);
  assert.match(installer, /Mode\s*=\s*"Installed"/);
  assert.match(installer, /NotePropertyValue\s+\$true/);
  assert.match(installer, /Typora is open\. Close Typora/);
  assert.match(installer, /Get-FileHash/);
  assert.match(installer, /\$pluginId\.installing/);
  assert.match(installer, /PackagePath/);
  assert.match(installer, /ExpectedSha256/);
  assert.match(installer, /Expand-Archive/);
});

test("Windows doctor checks the community market, compatibility and runtime marker", () => {
  const doctor = fs.readFileSync(path.join(__dirname, "..", "scripts", "doctor.ps1"), "utf8");

  for (const contract of [
    "community-market.injection",
    "community-market.loader-config",
    "community-market.core",
    "plugin.enabled-config",
    "plugin.core-compatibility",
    "plugin.typora-compatibility",
    "plugin.verified-matrix",
    "plugin.runtime-marker"
  ]) {
    assert.ok(doctor.includes(contract), `missing doctor contract: ${contract}`);
  }
  assert.match(doctor, /Test-Utf8Bom/);
});

test("release versions use numeric semantic versions without a v prefix", () => {
  assert.equal(isValidVersion("0.1.0-alpha.1"), true);
  assert.equal(isValidVersion("0.1.0"), true);
  assert.equal(isValidVersion("v0.1.0"), false);
  assert.equal(isValidVersion("01.0.0"), false);
  assert.equal(isValidVersion("0.1.0-alpha.01"), false);
});

test("release checksum round-trips plugin.zip and rejects malformed input", () => {
  const hash = sha256Buffer(Buffer.from("plugin package"));
  assert.equal(parseChecksum(formatChecksum(hash)), hash);
  assert.throws(() => parseChecksum(`${hash}  other.zip\n`), /valid plugin\.zip checksum/);
});

test("published release metadata distinguishes Alpha and stable releases", () => {
  const alpha = { tag_name: "0.1.0-alpha.1", draft: false, prerelease: true, assets: [] };
  const stable = { tag_name: "0.1.0", draft: false, prerelease: false, assets: [] };
  assert.equal(validateReleaseInfo(alpha, "0.1.0-alpha.1"), alpha);
  assert.equal(validateReleaseInfo(stable, "0.1.0"), stable);
  assert.throws(() => validateReleaseInfo({ ...alpha, draft: true }, "0.1.0-alpha.1"), /still a draft/);
  assert.throws(() => validateReleaseInfo({ ...stable, prerelease: true }, "0.1.0"), /prerelease state/);
});

test("version setter updates package, lock and plugin manifest together", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "typora-side-by-side-version-"));
  try {
    fs.writeFileSync(path.join(temporaryRoot, "package.json"), JSON.stringify({ version: "0.0.0" }));
    fs.writeFileSync(path.join(temporaryRoot, "package-lock.json"), JSON.stringify({ version: "0.0.0", packages: { "": { version: "0.0.0" } } }));
    fs.writeFileSync(path.join(temporaryRoot, "manifest.json"), JSON.stringify({ version: "0.0.0" }));

    setProjectVersion("0.1.0-alpha.1", temporaryRoot);

    assert.equal(JSON.parse(fs.readFileSync(path.join(temporaryRoot, "package.json"), "utf8")).version, "0.1.0-alpha.1");
    const packageLock = JSON.parse(fs.readFileSync(path.join(temporaryRoot, "package-lock.json"), "utf8"));
    assert.equal(packageLock.version, "0.1.0-alpha.1");
    assert.equal(packageLock.packages[""].version, "0.1.0-alpha.1");
    assert.equal(JSON.parse(fs.readFileSync(path.join(temporaryRoot, "manifest.json"), "utf8")).version, "0.1.0-alpha.1");
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
