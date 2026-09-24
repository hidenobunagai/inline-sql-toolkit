import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildCli } from "../../tools/build.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const cliPath = resolve(__dirname, "../../dist/cli.js");

function runCli(
  args: string[],
  options: { input?: string; cwd?: string } = {},
): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [cliPath, ...args], {
    input: options.input,
    cwd: options.cwd,
    encoding: "utf8",
  });
  return {
    status: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
  };
}

describe("CLI inline-sql-toolkit", () => {
  let tempDir: string;

  beforeAll(async () => {
    await buildCli();
    tempDir = mkdtempSync(join(tmpdir(), "inline-sql-cli-test-"));
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("formats file to stdout keeping single-line literals on a single line", () => {
    const filePath = join(tempDir, "sample.py");
    const inputCode = [
      'query = "select id, name from users where id = 1"',
      'multiline = """--sql',
      "select id, name from users where id = 1",
      '"""',
      "",
    ].join("\n");
    writeFileSync(filePath, inputCode, "utf8");

    const res = runCli([filePath]);
    expect(res.status).toBe(0);
    expect(res.stderr).toBe("");

    // Single-line literal stays collapsed
    expect(res.stdout).toContain('query = "SELECT id, name FROM users WHERE id = 1"');
    // Multiline literal is formatted with indentation
    expect(res.stdout).toContain(
      'multiline = """--sql\n  SELECT\n    id,\n    name\n  FROM\n    users\n  WHERE\n    id = 1\n"""',
    );

    // Original file remains unchanged
    expect(readFileSync(filePath, "utf8")).toBe(inputCode);
  });

  it("formats stdin to stdout", () => {
    const inputCode = 'query = "select id, name from users where id = 1"\n';
    const res = runCli([], { input: inputCode });
    expect(res.status).toBe(0);
    expect(res.stderr).toBe("");
    expect(res.stdout).toBe('query = "SELECT id, name FROM users WHERE id = 1"\n');
  });

  it("rewrites files in place with --write and is idempotent", () => {
    const filePath = join(tempDir, "write_test.py");
    const initialCode = 'query = "select id from users where id = 1"\n';
    writeFileSync(filePath, initialCode, "utf8");

    // First write modifies the file
    const firstRun = runCli(["--write", filePath]);
    expect(firstRun.status).toBe(0);
    const formattedCode = readFileSync(filePath, "utf8");
    expect(formattedCode).toBe('query = "SELECT id FROM users WHERE id = 1"\n');

    // Set a known past mtime to verify idempotency does not touch the file
    const pastTime = new Date(Date.now() - 10000);
    utimesSync(filePath, pastTime, pastTime);
    const beforeMtime = statSync(filePath).mtimeMs;

    // Second write does not alter content or mtime
    const secondRun = runCli(["-w", filePath]);
    expect(secondRun.status).toBe(0);
    expect(readFileSync(filePath, "utf8")).toBe(formattedCode);
    const afterMtime = statSync(filePath).mtimeMs;
    expect(afterMtime).toBe(beforeMtime);

    // --write without files fails with usage error (code 2)
    const noFileRun = runCli(["--write"]);
    expect(noFileRun.status).toBe(2);
    expect(noFileRun.stderr).toContain("inline-sql-toolkit: --write requires at least one file");
  });

  it("exits 1 on unformatted files and 0 on formatted files with --check", () => {
    const filePath = join(tempDir, "check_test.py");
    const unformatted = 'query = "select id from users"\n';
    writeFileSync(filePath, unformatted, "utf8");

    // Unformatted check fails
    const unformattedRes = runCli(["--check", filePath]);
    expect(unformattedRes.status).toBe(1);
    expect(unformattedRes.stderr).toContain(filePath);
    expect(unformattedRes.stderr).toContain("inline-sql-toolkit:");
    // File content not modified
    expect(readFileSync(filePath, "utf8")).toBe(unformatted);

    // Format file
    runCli(["-w", filePath]);

    // Formatted check passes
    const formattedRes = runCli(["--check", filePath]);
    expect(formattedRes.status).toBe(0);
    expect(formattedRes.stderr).toBe("");
  });

  it("finds and applies .inline-sql.json from parent directory", () => {
    const parentDir = join(tempDir, "parent_config_test");
    const childDir = join(parentDir, "child");
    mkdirSync(childDir, { recursive: true });

    // Config specifying lowercase keywords and indent width 4
    writeFileSync(
      join(parentDir, ".inline-sql.json"),
      JSON.stringify({
        format: {
          keywordCase: "lower",
          indentWidth: 4,
          dialect: "sqlite",
          commaPosition: "before",
        },
      }),
      "utf8",
    );

    const childPy = join(childDir, "query.py");
    writeFileSync(
      childPy,
      ['query = """--sql', "SELECT id, name FROM users", '"""', ""].join("\n"),
      "utf8",
    );

    // Run from child directory
    const res = runCli(["query.py"], { cwd: childDir });
    expect(res.status).toBe(0);
    // Lowercase keywords from parent config
    expect(res.stdout).toContain("select");
    expect(res.stdout).toContain("from");
    // Indent width 4
    expect(res.stdout).toContain("    id");
    // Leading comma from parent config
    expect(res.stdout).toMatch(/id\n\s+, name/);

    // CLI flag overrides config file
    const overrideRes = runCli(["--keyword-case", "upper", "query.py"], { cwd: childDir });
    expect(overrideRes.status).toBe(0);
    expect(overrideRes.stdout).toContain("SELECT");
  });

  it("exits 2 on invalid configuration values", () => {
    const filePath = join(tempDir, "valid.py");
    writeFileSync(filePath, 'query = "select 1"\n', "utf8");

    // Invalid CLI dialect
    const dialectRes = runCli(["--dialect", "invalid_dialect", filePath]);
    expect(dialectRes.status).toBe(2);
    expect(dialectRes.stderr).toContain("inline-sql-toolkit: invalid configuration");

    // Invalid CLI indent width
    const indentRes = runCli(["--indent-width", "99", filePath]);
    expect(indentRes.status).toBe(2);
    expect(indentRes.stderr).toContain("inline-sql-toolkit: invalid configuration");

    // Invalid config file
    const badConfig = join(tempDir, "bad_config.json");
    writeFileSync(badConfig, JSON.stringify({ format: { wrapAfter: 10 } }), "utf8");
    const configRes = runCli(["-c", badConfig, filePath]);
    expect(configRes.status).toBe(2);
    expect(configRes.stderr).toContain("inline-sql-toolkit: invalid configuration");
  });

  it("exits 2 on unknown CLI options", () => {
    const res = runCli(["--no-such-option"]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("inline-sql-toolkit:");
  });

  it("moves wrapping commas to the next line with --comma-position before", () => {
    const filePath = join(tempDir, "comma_before.py");
    writeFileSync(
      filePath,
      ['query = """--sql', "SELECT id, name FROM users", '"""', ""].join("\n"),
      "utf8",
    );

    const res = runCli(["--comma-position", "before", filePath]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("    id\n    , name\n");

    const defaultRes = runCli([filePath]);
    expect(defaultRes.status).toBe(0);
    expect(defaultRes.stdout).toContain("    id,\n    name\n");

    const badRes = runCli(["--comma-position", "middle", filePath]);
    expect(badRes.status).toBe(2);
    expect(badRes.stderr).toContain("inline-sql-toolkit: invalid configuration");
  });

  it("displays version matching package.json on --version", () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, "../../package.json"), "utf8")) as {
      version: string;
    };

    const res = runCli(["--version"]);
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe(pkg.version);
  });

  it("displays help text on --help and -h", () => {
    const res = runCli(["--help"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Usage: inline-sql-toolkit [options] [files...]");
    expect(res.stdout).toContain("-w, --write");
    expect(res.stdout).toContain("--check");

    const resShort = runCli(["-h"]);
    expect(resShort.status).toBe(0);
    expect(resShort.stdout).toContain("Usage: inline-sql-toolkit [options] [files...]");
  });

  it("does not partially write files if an error occurs during multi-file processing", () => {
    const file1 = join(tempDir, "file1.py");
    const file2 = join(tempDir, "non_existent_file2.py");
    const original1 = 'query = "select 1"\n';
    writeFileSync(file1, original1, "utf8");

    const res = runCli(["--write", file1, file2]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("inline-sql-toolkit:");
    // file1 must not have been modified
    expect(readFileSync(file1, "utf8")).toBe(original1);
  });

  it("runs from the packed npm tarball", () => {
    // The published artifact is the tarball, not the working tree. 0.4.7 shipped
    // without dist/package.json (excluded by .npmignore), so Node loaded the CJS
    // bundle as ESM ("module is not defined in ES module scope") and the CLI died
    // on start — invisible to every test that ran `node dist/cli.js` locally,
    // because the working tree has dist/package.json. Only packing and running
    // the extracted tree catches it.
    const packDir = mkdtempSync(join(tmpdir(), "inline-sql-toolkit-pack-"));
    try {
      const packed = spawnSync("npm", ["pack", "--pack-destination", packDir], {
        cwd: resolve(__dirname, "../.."),
        encoding: "utf8",
      });
      expect(packed.status).toBe(0);
      const tarball = readdirSync(packDir).find((name) => name.endsWith(".tgz"));
      expect(tarball).toBeDefined();
      if (tarball === undefined) return;

      const extractDir = join(packDir, "extract");
      mkdirSync(extractDir);
      const untar = spawnSync("tar", ["xzf", join(packDir, tarball), "-C", extractDir], {
        encoding: "utf8",
      });
      expect(untar.status).toBe(0);

      const packageRoot = join(extractDir, "package");
      const cliEntry = join(packageRoot, "dist", "cli.js");
      expect(existsSync(cliEntry)).toBe(true);
      // dist/package.json marks dist/ as CommonJS; without it the CLI cannot load.
      expect(existsSync(join(packageRoot, "dist", "package.json"))).toBe(true);

      const version = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
        version: string;
      };
      const run = spawnSync(process.execPath, [cliEntry, "--version"], { encoding: "utf8" });
      expect(run.status).toBe(0);
      expect(run.stdout.trim()).toBe(version.version);
    } finally {
      rmSync(packDir, { recursive: true, force: true });
    }
  });
});
