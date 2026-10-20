import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Nested entry sources exercising inventoried folder and glob selection. */
export const writeJavaScriptSourceTreeFixture = async (root: string) => {
  const sources = new Map<string, Buffer>([
    [
      "package.json",
      Buffer.from(
        '{"name":"rea-source-tree-fixture","main":"out/main/index.js"}\n',
      ),
    ],
    ["out/main.js", Buffer.from("module.exports = { shared: true };\n")],
    [
      "out/main/index.js",
      Buffer.from(
        'const { app } = require("electron");\nrequire("./nested/worker.js");\napp.whenReady(() => {});\n',
      ),
    ],
    [
      "out/main/nested/worker.js",
      Buffer.from("module.exports = { worker: true };\n"),
    ],
    [
      "out/preload/index.js",
      Buffer.from(
        'const { contextBridge } = require("electron");\nrequire("./deep/nested.js");\ncontextBridge.exposeInMainWorld("rea", {});\n',
      ),
    ],
    [
      "out/preload/deep/nested.js",
      Buffer.from("module.exports = { deep: true };\n"),
    ],
    [
      "out/web/assets/chunk-one.js",
      Buffer.from("export const renderer = 1;\n"),
    ],
    ["out/mainx/other.js", Buffer.from("module.exports = { other: true };\n")],
  ]);
  for (const [path, bytes] of sources) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), bytes);
  }
  return sources;
};
