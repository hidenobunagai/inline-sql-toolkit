import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { downloadAndUnzipVSCode } from "@vscode/test-electron";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface InstallLaunchInput {
  readonly executable: string;
  readonly vsix: string;
  readonly driver: string;
  readonly workspace: string;
  readonly userData: string;
  readonly extensions: string;
}

export function buildInstallCommand(input: InstallLaunchInput): readonly string[] {
  return [
    input.executable,
    "--extensions-dir",
    input.extensions,
    "--user-data-dir",
    input.userData,
    "--install-extension",
    input.vsix,
    "--force",
  ];
}

export function buildSmokeCommand(input: InstallLaunchInput): readonly string[] {
  return [
    input.executable,
    input.workspace,
    `--extensionDevelopmentPath=${input.driver}`,
    "--extensions-dir",
    input.extensions,
    "--user-data-dir",
    input.userData,
    "--disable-workspace-trust",
    "--disable-updates",
    "--skip-welcome",
    "--skip-release-notes",
  ];
}

export function resolveCliScript(executable: string): string {
  return process.platform === "darwin"
    ? path.resolve(executable, "../../Resources/app/out/cli.js")
    : path.resolve(path.dirname(executable), "resources/app/out/cli.js");
}

export function buildInstallInvocation(input: InstallLaunchInput): {
  readonly command: string;
  readonly args: readonly string[];
} {
  return {
    command: input.executable,
    args: [resolveCliScript(input.executable), ...buildInstallCommand(input).slice(1)],
  };
}

async function runCommand(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(command, [...args], {
        shell: false,
        env,
        stdio: "inherit",
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch {
      reject(new Error("VSIX smoke process failed"));
      return;
    }
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeAllListeners();
      child.on("error", () => {
        // Keep a sink for late process errors after the promise settles.
      });
      if (error === undefined) resolve();
      else reject(error);
    };
    const timer = setTimeout(() => {
      if (child.pid !== undefined && process.platform !== "win32") {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // The process may have exited between the check and the kill.
          void 0;
        }
      } else {
        child.kill();
      }
      finish(new Error("VSIX smoke timed out"));
    }, timeoutMs);
    child.once("error", () => {
      finish(new Error("VSIX smoke process failed"));
    });
    child.once("exit", (code, signal) => {
      if (code === 0 && signal === null) finish();
      else finish(new Error("VSIX smoke process exited unsuccessfully"));
    });
  });
}

export async function runInstallSmoke(vsixArgument: string): Promise<void> {
  const vsix = path.resolve(vsixArgument);
  const stat = await fs.stat(vsix);
  if (!stat.isFile() || !vsix.endsWith(".vsix")) throw new Error("VSIX path is invalid");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "inline-sql-vsix-install-"));
  try {
    const userData = path.join(root, "user-data");
    const extensions = path.join(root, "extensions");
    const workspace = path.join(root, "workspace");
    const result = path.join(root, "result.json");
    await Promise.all([fs.mkdir(userData), fs.mkdir(extensions), fs.mkdir(workspace)]);
    await fs.writeFile(
      path.join(workspace, "query.py"),
      'query = "select id, name from users"\n',
      "utf8",
    );
    const executable = await downloadAndUnzipVSCode("stable");
    const driver = path.join(ROOT, "test", "fixtures", "extensions", "vsix-driver");
    const input = { executable, vsix, driver, workspace, userData, extensions };
    const install = buildInstallInvocation(input);
    await runCommand(
      install.command,
      install.args,
      { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      120_000,
    );
    await runCommand(
      executable,
      buildSmokeCommand(input).slice(1),
      {
        ...process.env,
        INLINE_SQL_VSIX_SMOKE_FIXTURE: path.join(workspace, "query.py"),
        INLINE_SQL_VSIX_SMOKE_RESULT: result,
      },
      120_000,
    );
    const outcome = JSON.parse(await fs.readFile(result, "utf8")) as { ok?: unknown };
    if (outcome.ok !== true) throw new Error("VSIX smoke did not pass");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const vsix = process.argv[2];
  if (vsix === undefined) throw new Error("usage: bun tools/install_and_smoke_vsix.ts <vsix>");
  await runInstallSmoke(vsix);
}
