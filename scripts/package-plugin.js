const { ZipArchive } = require("archiver");
const fs = require("node:fs");
const path = require("node:path");

const workspace = path.resolve(__dirname, "..");
const buildDir = path.join(workspace, "build", "typora-side-by-side-translator");
const releaseDir = path.join(workspace, "release");
const zipPath = path.join(releaseDir, "plugin.zip");
const packageFiles = [
  "manifest.json",
  "main.js",
  "style.css",
  "locales/lang.en.json",
  "locales/lang.ja.json",
  "locales/lang.ko.json",
  "locales/lang.zh-cn.json",
  "locales/lang.zh-tw.json"
];
const stableArchiveDate = new Date("1980-01-01T00:00:00.000Z");

for (const filename of packageFiles) {
  const sourcePath = path.join(buildDir, filename);
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
    throw new Error(`Missing build artifact: ${sourcePath}`);
  }
}

fs.mkdirSync(releaseDir, { recursive: true });
fs.rmSync(zipPath, { force: true });

const output = fs.createWriteStream(zipPath);
const archive = new ZipArchive({ zlib: { level: 9 } });
const packageCompleted = new Promise((resolve, reject) => {
  output.once("close", resolve);
  output.once("error", reject);
  archive.once("warning", reject);
  archive.once("error", reject);
});
archive.pipe(output);

for (const filename of packageFiles) {
  archive.append(fs.readFileSync(path.join(buildDir, filename)), {
    name: filename,
    date: stableArchiveDate,
    mode: 0o100644
  });
}

async function main() {
  await archive.finalize();
  await packageCompleted;
  console.log(`package=${zipPath}`);
  console.log(`bytes=${archive.pointer()}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
