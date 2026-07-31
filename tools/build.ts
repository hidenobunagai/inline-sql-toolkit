import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build, type Metafile } from "esbuild";

export async function buildExtension(): Promise<Metafile> {
  await mkdir("dist", { recursive: true });
  const result = await build({
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.js",
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["vscode"],
    sourcemap: false,
    legalComments: "none",
    metafile: true,
    packages: "bundle",
  });
  if (result.metafile === undefined) {
    throw new Error("esbuild did not return a metafile");
  }
  return result.metafile;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await buildExtension();
}
