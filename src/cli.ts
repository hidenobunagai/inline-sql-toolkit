import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { type RawFormatOptions, resolveFormatOptions } from "./format-options.js";
import type { FormatOptions } from "./protocol.js";
import { allocateNonce, combinedSource, formatDocument } from "./python-analysis/engine.js";
import { collapseReplacement } from "./replacement.js";
import { formatProtectedSql } from "./sql-formatter.js";

export const USAGE = `Usage: inline-sql-toolkit [options] [files...]

  -w, --write                      rewrite files in place
      --check                      exit 1 if any file would change
      --dialect <name>             sql | mysql | postgresql | sqlite (default: postgresql)
      --keyword-case <case>        upper | lower | preserve (default: upper)
      --indent-width <1-8>         (default: 2)
      --wrap-after <20-500>        (default: 88)
      --no-space-around-operators  keep dense operators (default: spaced)
      --no-ordinals                do not replace GROUP BY / ORDER BY ordinals
      --comma-position <pos>       after | before (default: after)
  -c, --config <file>              config JSON (default: nearest .inline-sql.json)
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
    "no-ordinals"?: boolean;
    "comma-position"?: string;
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
    replaceOrdinals: cliValues["no-ordinals"] ? false : fileOptions.replaceOrdinals,
    commaPosition: cliValues["comma-position"] ?? fileOptions.commaPosition,
  };
}

export function formatPythonSource(
  text: string,
  options: FormatOptions,
  logger?: (message: string) => void,
): string {
  const nonce = allocateNonce(text, () => randomBytes(16).toString("hex"));
  const result = formatDocument(
    text,
    options,
    { mode: "all" },
    nonce,
    (sql, formatterOptions) => formatProtectedSql(sql, formatterOptions.options),
    logger,
  );
  const edits = result.edits.map((edit) => ({
    ...edit,
    replacementText: collapseReplacement(
      text.slice(edit.sourceSpan.start, edit.sourceSpan.end),
      edit.replacementText,
    ),
  }));
  return combinedSource(text, edits);
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
        "no-ordinals": { type: "boolean", default: false },
        "comma-position": { type: "string" },
        config: { type: "string", short: "c" },
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
      output = formatPythonSource(input, options);
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
      output = formatPythonSource(input, options);
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
