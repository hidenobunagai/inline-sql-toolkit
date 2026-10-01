import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { type RawFormatOptions, resolveFormatOptions } from "./format-options.js";
import type { FormatOptions } from "./protocol.js";
import { allocateNonce, combinedSource, formatDocument } from "./python-analysis/engine.js";
import { formatProtectedSql } from "./sql-formatter.js";

export const USAGE = `Usage: inline-sql-toolkit [options] [files...]

  -w, --write                      rewrite files in place
      --check                      exit 1 if any file would change
      --dialect <name>             sql | mysql | postgresql | sqlite (default: postgresql)
      --keyword-case <case>        upper | lower | preserve (default: upper)
      --indent-width <1-8>         (default: 2)
      --wrap-after <20-500>        (default: 88)
      --no-space-around-operators  keep dense operators (default: spaced)
      --ordinals                   replace GROUP BY / ORDER BY ordinals (default: off)
      --no-ordinals                do not replace ordinals (overrides the config file)
      --comma-position <pos>       after | before (default: after)
      --keep-functions-inline      keep SUM(...) / COUNT(CASE ...) on one line
  -c, --config <file>              config JSON (default: nearest .inline-sql.json)
  -q, --quiet                      do not report skipped candidates on stderr
  -h, --help / --version`;

function printError(message: string): void {
  process.stderr.write(`${message}\n`);
}

function getScriptDir(): string {
  if (typeof __dirname !== "undefined") {
    return __dirname;
  }
  return process.cwd();
}

export function getPackageVersion(): string {
  const dir = getScriptDir();
  const candidates = [resolve(dir, "..", "package.json"), resolve(dir, "package.json")];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { version?: unknown };
        if (typeof parsed.version === "string") return parsed.version;
      } catch {
        // continue
      }
    }
  }
  return "0.0.0";
}

export function findConfigFile(startDir: string = process.cwd()): string | undefined {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, ".inline-sql.json");
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

export function loadConfigFile(configPath: string): RawFormatOptions {
  const content = readFileSync(configPath, "utf8");
  const parsed = JSON.parse(content) as {
    readonly format?: RawFormatOptions;
    readonly inlineSql?: { readonly format?: RawFormatOptions };
  } & RawFormatOptions;
  if (parsed.format && typeof parsed.format === "object") {
    return parsed.format;
  }
  if (parsed.inlineSql?.format && typeof parsed.inlineSql.format === "object") {
    return parsed.inlineSql.format;
  }
  return parsed;
}

export function buildRawOptions(
  fileOptions: RawFormatOptions,
  cliValues: {
    dialect?: string;
    "keyword-case"?: string;
    "indent-width"?: string;
    "wrap-after"?: string;
    "no-space-around-operators"?: boolean;
    ordinals?: boolean;
    "no-ordinals"?: boolean;
    "comma-position"?: string;
    "keep-functions-inline"?: boolean;
  },
): RawFormatOptions {
  return {
    dialect: cliValues.dialect ?? fileOptions.dialect,
    keywordCase: cliValues["keyword-case"] ?? fileOptions.keywordCase,
    indentWidth:
      cliValues["indent-width"] !== undefined
        ? Number(cliValues["indent-width"])
        : fileOptions.indentWidth,
    wrapAfter:
      cliValues["wrap-after"] !== undefined
        ? Number(cliValues["wrap-after"])
        : fileOptions.wrapAfter,
    useSpaceAroundOperators: cliValues["no-space-around-operators"]
      ? false
      : fileOptions.useSpaceAroundOperators,
    replaceOrdinals: cliValues.ordinals
      ? true
      : cliValues["no-ordinals"]
        ? false
        : fileOptions.replaceOrdinals,
    commaPosition: cliValues["comma-position"] ?? fileOptions.commaPosition,
    keepFunctionsInline: cliValues["keep-functions-inline"]
      ? true
      : fileOptions.keepFunctionsInline,
  };
}

/** Formatted source plus the reasons of every candidate left unformatted. */
export interface FormatReport {
  readonly output: string;
  readonly skipReasons: readonly string[];
}

export function formatPythonSourceWithReport(
  text: string,
  options: FormatOptions,
  logger?: (message: string) => void,
): FormatReport {
  const nonce = allocateNonce(text, () => randomBytes(16).toString("hex"));
  const result = formatDocument(
    text,
    options,
    { mode: "all" },
    nonce,
    (sql, formatterOptions) => formatProtectedSql(sql, formatterOptions.options),
    logger,
  );
  return { output: combinedSource(text, result.edits), skipReasons: result.skipReasons };
}

export function formatPythonSource(
  text: string,
  options: FormatOptions,
  logger?: (message: string) => void,
): string {
  return formatPythonSourceWithReport(text, options, logger).output;
}

/** One stderr line naming why candidates in *name* were left unformatted. */
function skipNote(name: string, reasons: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  const detail = [...counts].map(([reason, count]) => `${reason} x${count}`).join(", ");
  const noun = reasons.length === 1 ? "candidate" : "candidates";
  return `inline-sql-toolkit: ${name}: skipped ${reasons.length} SQL ${noun} (${detail})`;
}

export function runCli(argv: string[]): number {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        write: { type: "boolean", short: "w", default: false },
        check: { type: "boolean", default: false },
        dialect: { type: "string" },
        "keyword-case": { type: "string" },
        "indent-width": { type: "string" },
        "wrap-after": { type: "string" },
        "no-space-around-operators": { type: "boolean", default: false },
        ordinals: { type: "boolean", default: false },
        "no-ordinals": { type: "boolean", default: false },
        "comma-position": { type: "string" },
        "keep-functions-inline": { type: "boolean", default: false },
        config: { type: "string", short: "c" },
        quiet: { type: "boolean", short: "q", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", default: false },
      },
      allowPositionals: true,
    });
  } catch (err) {
    printError(`inline-sql-toolkit: ${(err as Error).message}`);
    return 2;
  }

  const { values, positionals } = parsed;

  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  if (values.version) {
    process.stdout.write(`${getPackageVersion()}\n`);
    return 0;
  }

  if (values.write && values.check) {
    printError("inline-sql-toolkit: cannot use --write and --check together");
    return 2;
  }

  if (values.ordinals && values["no-ordinals"]) {
    printError("inline-sql-toolkit: cannot use --ordinals and --no-ordinals together");
    return 2;
  }

  let fileConfig: RawFormatOptions = {};
  if (values.config) {
    try {
      fileConfig = loadConfigFile(values.config);
    } catch (err) {
      printError(`inline-sql-toolkit: cannot read config: ${(err as Error).message}`);
      return 2;
    }
  } else {
    const configPath = findConfigFile();
    if (configPath !== undefined) {
      try {
        fileConfig = loadConfigFile(configPath);
      } catch (err) {
        printError(`inline-sql-toolkit: cannot read config: ${(err as Error).message}`);
        return 2;
      }
    }
  }

  const rawOptions = buildRawOptions(fileConfig, values);
  const resolved = resolveFormatOptions(rawOptions);
  if (!resolved.ok) {
    printError("inline-sql-toolkit: invalid configuration");
    return 2;
  }

  const options = resolved.options;

  if (positionals.length === 0) {
    if (values.write) {
      printError("inline-sql-toolkit: --write requires at least one file");
      return 2;
    }
    let input: string;
    try {
      input = readFileSync(0, "utf8");
    } catch (err) {
      printError(`inline-sql-toolkit: ${(err as Error).message}`);
      return 2;
    }
    let output: string;
    try {
      const report = formatPythonSourceWithReport(input, options);
      output = report.output;
      if (!values.quiet && report.skipReasons.length > 0) {
        printError(skipNote("<stdin>", report.skipReasons));
      }
    } catch (err) {
      printError(`inline-sql-toolkit: ${(err as Error).message}`);
      return 2;
    }
    if (values.check) {
      if (output !== input) {
        printError("inline-sql-toolkit: stdin is not formatted");
        return 1;
      }
      return 0;
    }
    process.stdout.write(output);
    return 0;
  }

  interface FileTask {
    file: string;
    input: string;
    output: string;
  }
  const tasks: FileTask[] = [];

  for (const file of positionals) {
    let input: string;
    try {
      input = readFileSync(file, "utf8");
    } catch (err) {
      printError(`inline-sql-toolkit: cannot read file: ${file}: ${(err as Error).message}`);
      return 2;
    }
    let output: string;
    try {
      const report = formatPythonSourceWithReport(input, options);
      output = report.output;
      if (!values.quiet && report.skipReasons.length > 0) {
        printError(skipNote(file, report.skipReasons));
      }
    } catch (err) {
      printError(`inline-sql-toolkit: ${file}: ${(err as Error).message}`);
      return 2;
    }
    tasks.push({ file, input, output });
  }

  if (values.check) {
    let hasDiff = false;
    for (const task of tasks) {
      if (task.output !== task.input) {
        printError(`inline-sql-toolkit: ${task.file} is not formatted`);
        hasDiff = true;
      }
    }
    return hasDiff ? 1 : 0;
  }

  if (values.write) {
    for (const task of tasks) {
      if (task.output !== task.input) {
        try {
          writeFileSync(task.file, task.output, "utf8");
        } catch (err) {
          printError(
            `inline-sql-toolkit: cannot write file: ${task.file}: ${(err as Error).message}`,
          );
          return 2;
        }
      }
    }
    return 0;
  }

  for (const task of tasks) {
    process.stdout.write(task.output);
  }
  return 0;
}

if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
  process.exitCode = runCli(process.argv.slice(2));
}
