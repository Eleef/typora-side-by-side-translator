const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const workspace = path.resolve(__dirname, "..");
const checksumFilename = "SHA256SUMS.txt";
const releaseFiles = [
  { name: "plugin.zip", relativePath: path.join("release", "plugin.zip") },
  { name: "install-plugin.ps1", relativePath: path.join("scripts", "install-plugin.ps1") },
  { name: "doctor.ps1", relativePath: path.join("scripts", "doctor.ps1") }
];

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function formatChecksum(hash, filename = "plugin.zip") {
  return `${hash.toLowerCase()}  ${filename}\n`;
}

function parseChecksum(text, filename = "plugin.zip") {
  const escapedFilename = filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^[0-9a-fA-F]{64}\\s+\\*?${escapedFilename}$`);
  const line = text.split(/\r?\n/).find((candidate) => pattern.test(candidate.trim()));
  if (!line) {
    throw new Error(`SHA256SUMS.txt does not contain a valid ${filename} checksum.`);
  }
  return line.trim().split(/\s+/)[0].toLowerCase();
}

function writeReleaseChecksum(rootDirectory = workspace) {
  const releaseDirectory = path.join(rootDirectory, "release");
  const checksumPath = path.join(releaseDirectory, checksumFilename);
  const checksums = [];
  for (const releaseFile of releaseFiles) {
    const filePath = path.join(rootDirectory, releaseFile.relativePath);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Missing release file: ${filePath}`);
    }
    checksums.push({ ...releaseFile, hash: sha256File(filePath) });
  }
  fs.writeFileSync(checksumPath, checksums.map(({ hash, name }) => formatChecksum(hash, name)).join(""), "utf8");
  for (const { hash, name } of checksums) {
    console.log(`sha256_${name}=${hash}`);
  }
  console.log(`checksum=${checksumPath}`);
  return checksums;
}

if (require.main === module) {
  try {
    writeReleaseChecksum();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

module.exports = {
  checksumFilename,
  formatChecksum,
  parseChecksum,
  releaseFiles,
  sha256Buffer,
  sha256File,
  writeReleaseChecksum
};
