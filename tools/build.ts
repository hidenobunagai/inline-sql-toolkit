import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build, type Metafile } from "esbuild";

export interface BuildOptions {
  /** false computes the bundle and its metafile without touching dist/. */
  readonly write?: boolean;
}

/** Mark dist/ as CommonJS; the root package.json says "type": "module". */
async function prepareDist(write: boolean): Promise<void> {
  if (!write) return;
  await mkdir("dist", { recursive: true });
  // The repository uses ESM for TypeScript tooling, while VS Code loads the
  // bundled extension through require(). Scope the generated bundle as
  // CommonJS without changing the source package's module mode.
  await writeFile("dist/package.json", JSON.stringify({ type: "commonjs" }), {
    encoding: "utf8",
  });
}

export async function buildExtension({ write = true }: BuildOptions = {}): Promise<Metafile> {
  await prepareDist(write);
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
    write,
  });
  if (result.metafile === undefined) {
    throw new Error("esbuild did not return a metafile");
  }
  return result.metafile;
}

export async function buildCli({ write = true }: BuildOptions = {}): Promise<Metafile> {
  await prepareDist(write);
  const result = await build({
    entryPoints: ["src/cli.ts"],
    outfile: "dist/cli.js",
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    sourcemap: false,
    legalComments: "none",
    metafile: true,
    packages: "bundle",
    write,
    banner: {
      js: "#!/usr/bin/env node",
    },
  });
  if (result.metafile === undefined) {
    throw new Error("esbuild did not return a metafile");
  }
  return result.metafile;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await buildExtension();
  await buildCli();
}
