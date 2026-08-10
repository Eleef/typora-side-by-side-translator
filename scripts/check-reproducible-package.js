const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { checksumFilename, parseChecksum, sha256File } = require("./release-checksum");

const workspace = path.resolve(__dirname, "..");
const zipPath = path.join(workspace, "release", "plugin.zip");
const checksumPath = path.join(workspace, "release", checksumFilename);

if (!fs.existsSync(zipPath)) {
  throw new Error(`Missing package for reproducibility check: ${zipPath}`);
}

const firstHash = sha256File(zipPath);
if (parseChecksum(fs.readFileSync(checksumPath, "utf8")) !== firstHash) {
  throw new Error("Initial release checksum does not match plugin.zip.");
}
const npmCommand = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "npm";
const npmArgs = process.platform === "win32" ? ["/d", "/s", "/c", "npm run package"] : ["run", "package"];
const result = spawnSync(npmCommand, npmArgs, {
  cwd: workspace,
  stdio: "inherit"
});

if (result.error) {
  throw result.error;
}
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const secondHash = sha256File(zipPath);
if (firstHash !== secondHash) {
  throw new Error(`Package is not reproducible: ${firstHash} != ${secondHash}`);
}
if (parseChecksum(fs.readFileSync(checksumPath, "utf8")) !== secondHash) {
  throw new Error("Rebuilt release checksum does not match plugin.zip.");
}

console.log(`verified_reproducible_package=${secondHash}`);
