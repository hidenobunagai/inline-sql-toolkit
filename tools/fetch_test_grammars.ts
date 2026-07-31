import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface GrammarLockEntry {
  readonly repository: string;
  readonly commit: string;
  readonly path: string;
  readonly scopeName: string;
  readonly sha256: string;
  readonly license: string;
}

interface GrammarLock {
  readonly marimo: GrammarLockEntry;
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

function githubRepositoryPath(repository: string): string {
  const parsed = new URL(repository);
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") {
    throw new Error("Grammar repository must be an HTTPS github.com URL");
  }
  const repositoryPath = parsed.pathname.replace(/^\/|\/$/g, "");
  if (repositoryPath.split("/").length !== 2) {
    throw new Error("Grammar repository must identify one GitHub repository");
  }
  return repositoryPath;
}

export async function fetchTestGrammars(): Promise<void> {
  const lockPath = resolve(projectRoot, "test/fixtures/grammar-lock.json");
  const lock = JSON.parse(await readFile(lockPath, "utf8")) as GrammarLock;
  const entry = lock.marimo;
  const repositoryPath = githubRepositoryPath(entry.repository);
  const rawRoot = `https://raw.githubusercontent.com/${repositoryPath}/${entry.commit}`;
  const grammar = await fetchBytes(`${rawRoot}/${entry.path}`);
  const actualHash = createHash("sha256").update(grammar).digest("hex");
  if (actualHash !== entry.sha256) {
    throw new Error(
      `Marimo grammar hash mismatch: expected ${entry.sha256}, received ${actualHash}`,
    );
  }

  const license = await fetchBytes(`${rawRoot}/LICENSE`);
  const fixtureRoot = resolve(projectRoot, "test/fixtures/grammars");
  await mkdir(fixtureRoot, { recursive: true });
  await Promise.all([
    writeFile(resolve(fixtureRoot, "marimo-python.tmLanguage.json"), grammar),
    writeFile(resolve(fixtureRoot, "marimo-LICENSE"), license),
    writeFile(
      resolve(fixtureRoot, "marimo-SOURCE.json"),
      `${JSON.stringify(entry, undefined, 2)}\n`,
      "utf8",
    ),
  ]);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await fetchTestGrammars();
}
