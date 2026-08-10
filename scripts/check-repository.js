const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const workspace = path.resolve(__dirname, "..");
const forbiddenRoots = new Set([".agents", ".test-dist", ".tmp", "build", "dist", "node_modules", "release"]);
const allowedExamplePaths = [/^C:\\Users\\alice\\/i, /^\/home\/alice\//i, /^\/Users\/alice\//i];
const sensitivePatterns = [
  { name: "OpenAI-style API key", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { name: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { name: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "Bearer credential", pattern: /\bBearer\s+[A-Za-z0-9._-]{20,}\b/g },
  { name: "private key", pattern: /-----BEGIN (?:EC |OPENSSH |PGP |RSA )?PRIVATE KEY-----/g }
];
const localPathPatterns = [
  /\b[A-Za-z]:\\+[^\s"'`]+/g,
  /\b[A-Za-z]:\/(?!\/)[^\s"'`]+/g,
  /\/(?:home|Users)\/[^\s/"'`]+\/[^\s"'`]+/g
];

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function trackedFiles() {
  const output = execFileSync("git", ["ls-files", "-z"], {
    cwd: workspace,
    encoding: "utf8"
  });
  return output.split("\0").filter(Boolean);
}

function isForbiddenPath(relativePath) {
  const normalized = relativePath.replaceAll("\\", "/");
  const segments = normalized.split("/");
  const basename = segments.at(-1) ?? "";
  if (segments.some((segment) => forbiddenRoots.has(segment))) {
    return true;
  }
  if (basename.endsWith(".log")) {
    return true;
  }
  return basename === ".env" || (basename.startsWith(".env.") && basename !== ".env.example");
}

function isBinary(buffer) {
  return buffer.subarray(0, Math.min(buffer.length, 8_000)).includes(0);
}

function isAllowedExamplePath(value) {
  const normalized = value.replace(/\\+/g, "\\");
  return allowedExamplePaths.some((pattern) => pattern.test(normalized));
}

function findTextIssues(relativePath, text) {
  const issues = [];
  for (const { name, pattern } of sensitivePatterns) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      issues.push(`Sensitive ${name} pattern found in tracked file: ${relativePath}`);
    }
  }

  for (const pattern of localPathPatterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      if (!isAllowedExamplePath(match[0])) {
        issues.push(`Local absolute path found in tracked file: ${relativePath}`);
      }
    }
  }
  return issues;
}

function main() {
  const files = trackedFiles();
  for (const relativePath of files) {
    if (isForbiddenPath(relativePath)) {
      fail(`Forbidden tracked path: ${relativePath}`);
      continue;
    }

    const buffer = fs.readFileSync(path.join(workspace, relativePath));
    if (!isBinary(buffer)) {
      for (const issue of findTextIssues(relativePath, buffer.toString("utf8"))) {
        fail(issue);
      }
    }
  }

  if (process.exitCode) {
    return;
  }
  console.log(`verified_tracked_files=${files.length}`);
}

if (require.main === module) {
  main();
}

module.exports = { findTextIssues, isForbiddenPath };
