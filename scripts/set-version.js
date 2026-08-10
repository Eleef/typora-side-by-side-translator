const fs = require("node:fs");
const path = require("node:path");

const workspace = path.resolve(__dirname, "..");
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function isValidVersion(version) {
  const match = VERSION_PATTERN.exec(version);
  if (!match) {
    return false;
  }

  const prerelease = match[4];
  return !prerelease || prerelease.split(".").every((part) => !/^\d+$/.test(part) || part === "0" || !part.startsWith("0"));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function setProjectVersion(version, rootDirectory = workspace) {
  if (!isValidVersion(version)) {
    throw new Error(`Invalid release version: ${version}. Use a version such as 0.1.0 or 0.1.0-alpha.1 without a v prefix.`);
  }

  const packagePath = path.join(rootDirectory, "package.json");
  const packageLockPath = path.join(rootDirectory, "package-lock.json");
  const manifestPath = path.join(rootDirectory, "manifest.json");
  const packageJson = readJson(packagePath);
  const packageLock = readJson(packageLockPath);
  const manifest = readJson(manifestPath);

  if (!packageLock.packages?.[""]) {
    throw new Error("package-lock.json does not contain a root package entry.");
  }

  packageJson.version = version;
  packageLock.version = version;
  packageLock.packages[""].version = version;
  manifest.version = version;

  writeJson(packagePath, packageJson);
  writeJson(packageLockPath, packageLock);
  writeJson(manifestPath, manifest);
  console.log(`version=${version}`);
}

if (require.main === module) {
  const [version, ...extraArguments] = process.argv.slice(2);
  if (!version || extraArguments.length > 0) {
    console.error("Usage: npm run version:set -- 0.1.0-alpha.1");
    process.exitCode = 1;
  } else {
    try {
      setProjectVersion(version);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  }
}

module.exports = { isValidVersion, setProjectVersion };
