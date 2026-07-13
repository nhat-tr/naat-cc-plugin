import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(repositoryRoot, "skills", "brainstorming", "ui");
const outputRoot = path.join(repositoryRoot, "skills", "brainstorming", "assets", "visual-shell");
const elkWorker = path.join(repositoryRoot, "node_modules", "elkjs", "lib", "elk-worker.min.js");
const entryPoints = {
  app: path.join(sourceRoot, "main.tsx"),
  styles: path.join(sourceRoot, "styles", "shell.css"),
};

const missingInputs = [];
for (const input of [...Object.values(entryPoints), elkWorker]) {
  try {
    const stat = await fs.stat(input);
    if (!stat.isFile()) missingInputs.push(input);
  } catch {
    missingInputs.push(input);
  }
}

if (missingInputs.length > 0) {
  throw new Error(`Visual Shell build inputs are missing:\n${missingInputs.join("\n")}`);
}

const buildResult = await build({
  entryPoints,
  outdir: outputRoot,
  entryNames: "[name]",
  bundle: true,
  format: "iife",
  globalName: "BrainstormVisualShell",
  footer: {
    js: "if (typeof module !== 'undefined' && module.exports) module.exports = BrainstormVisualShell;",
  },
  splitting: false,
  platform: "browser",
  target: ["es2022"],
  minify: true,
  sourcemap: false,
  legalComments: "none",
  write: false,
});

const expectedOutputs = new Set(["app.js", "styles.css"]);
const actualOutputs = new Set(buildResult.outputFiles.map((output) => path.basename(output.path)));
if (
  expectedOutputs.size !== actualOutputs.size
  || [...expectedOutputs].some((output) => !actualOutputs.has(output))
) {
  throw new Error(`Visual Shell build produced unexpected outputs: ${[...actualOutputs].join(", ")}`);
}

await fs.mkdir(outputRoot, { recursive: true });
await Promise.all([
  ...buildResult.outputFiles.map((output) => fs.writeFile(output.path, output.contents)),
  fs.copyFile(elkWorker, path.join(outputRoot, "elk-worker.min.js")),
]);
