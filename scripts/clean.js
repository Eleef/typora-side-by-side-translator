const fs = require("node:fs");
const path = require("node:path");

const workspace = path.resolve(__dirname, "..");
for (const relativePath of ["dist", "build", ".test-dist", "release"]) {
  fs.rmSync(path.join(workspace, relativePath), { recursive: true, force: true });
}
