import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
// Only this explicitly checked build directory may be recursively cleared
if (path.dirname(dist) !== root || path.basename(dist) !== "dist")
  throw new Error("invalid build directory");
await fs.rm(dist, { recursive: true, force: true });
const result = spawnSync(
  process.execPath,
  [
    require.resolve("typescript/lib/tsc.js"),
    "-p",
    path.join(root, "tsconfig.json"),
  ],
  { stdio: "inherit", cwd: root },
);
if (result.status !== 0) process.exit(result.status || 1);
async function assets(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const source = path.join(directory, entry.name);
    if (entry.isSymbolicLink())
      throw new Error("symlink in source tree is not allowed");
    if (entry.isDirectory()) await assets(source);
    else if (!entry.name.endsWith(".ts")) {
      const target = path.join(
        dist,
        path.relative(path.join(root, "src"), source),
      );
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(source, target);
    }
  }
}
await assets(path.join(root, "src"));
console.log(
  "Native build complete: dist (verification stage, not device certification)",
);
