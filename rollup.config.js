const path = require("path");
const commonjs = require("@rollup/plugin-commonjs");
const json = require("@rollup/plugin-json");
const nodeResolve = require("@rollup/plugin-node-resolve");
const builtinModules = require("module").builtinModules;
const esbuild = require("rollup-plugin-esbuild").default;
const exportedByCore = require("./node_modules/@typora-community-plugin/rollup-plugin-typora/exported-by-core.json");

const CORE_VIRTUAL_ID = "\0typora-community-plugin-core";

function copyFilePlugin() {
  return {
    name: "copy-static-files",
    writeBundle() {
      const fs = require("fs");
      const outputDir = path.resolve(__dirname, "build", "typora-side-by-side-translator");
      fs.mkdirSync(outputDir, { recursive: true });
      fs.copyFileSync(path.resolve(__dirname, "manifest.json"), path.join(outputDir, "manifest.json"));
      fs.copyFileSync(path.resolve(__dirname, "style.css"), path.join(outputDir, "style.css"));
      fs.copyFileSync(path.resolve(__dirname, "dist", "main.js"), path.join(outputDir, "main.js"));
      fs.cpSync(path.resolve(__dirname, "src", "i18n", "locales"), path.join(outputDir, "locales"), {
        recursive: true
      });
    }
  };
}

function typoraCoreVirtualPlugin() {
  const moduleSource =
    'const exported = window[Symbol.for("typora-plugin-core@v2")];' +
    exportedByCore.map((name) => `export const ${name} = exported.${name};`).join("");

  return {
    name: "typora-core-virtual",
    resolveId(source) {
      if (source === "@typora-community-plugin/core") {
        return CORE_VIRTUAL_ID;
      }
      return null;
    },
    load(id) {
      if (id === CORE_VIRTUAL_ID) {
        return moduleSource;
      }
      return null;
    }
  };
}

module.exports = {
  input: "src/main.ts",
  output: {
    file: "dist/main.js",
    format: "esm",
    sourcemap: false
  },
  plugins: [
    typoraCoreVirtualPlugin(),
    nodeResolve.nodeResolve({ browser: true, preferBuiltins: false }),
    commonjs(),
    json(),
    esbuild({
      target: "es2020",
      platform: "browser",
      loaders: {
        ".ts": "ts"
      }
    }),
    copyFilePlugin()
  ],
  external: [...builtinModules, ...builtinModules.map((name) => `node:${name}`)]
};
