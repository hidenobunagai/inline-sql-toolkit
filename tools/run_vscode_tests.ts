import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { downloadAndUnzipVSCode } from "@vscode/test-electron";
import { build } from "esbuild";

import { type IntegrationScenario, parseScenario } from "../test/support/integration-scenario.js";
import { buildExtension } from "./build.js";

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const VSCODE_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const VSCODE_DOWNLOAD_RETRIES = 3;
const VSCODE_STABLE_RELEASES_API =
  "https://update.code.visualstudio.com/api/releases/stable?released=true";
// The @vscode/test-electron downloader streams through the deprecated
// `request` module and truncates mid-transfer on CI runners (gzip: stdin:
// unexpected end of file). Download with curl instead: it resumes partial
// transfers (`-C -`) and retries every failure, and the cached extract is
// reused across runs via the same `is-complete` marker the library checks.
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export type GrammarVersion = "1.95.0" | "stable";

export interface ScenarioOptions {
  readonly scenario: IntegrationScenario;
  readonly vscodeVersion: GrammarVersion;
  readonly repositoryRoot: string;
}

export interface LaunchInput {
  readonly executable: string;
  readonly repositoryRoot: string;
  readonly testsPath: string;
  readonly workspacePath: string;
  readonly userDataDir: string;
  readonly extensionsDir: string;
  readonly scenario: IntegrationScenario;
}

export interface LaunchCommand {
  readonly command: string;
  readonly args: readonly string[];
}

export interface SpawnRunOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly shell: false;
  readonly stdio?: "inherit" | "ignore";
  readonly timeoutMs: number;
  readonly spawnProcess?: typeof spawn;
  readonly terminateTree?: (processId: number) => Promise<void>;
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
}

export function parseGrammarVersion(value: string | undefined): GrammarVersion {
  if (value === undefined) return "1.95.0";
  if (value === "1.95.0" || value === "stable") return value;
  throw new Error("invalid VSCODE_TEST_VERSION");
}

/** Maps the host to the same platform id @vscode/test-electron uses for archives. */
export function vscodeTestPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  switch (platform) {
    case "darwin":
      return arch === "arm64" ? "darwin-arm64" : "darwin";
    case "win32":
      return arch === "arm64" ? "win32-arm64-archive" : "win32-x64-archive";
    default:
      return arch === "arm64" ? "linux-arm64" : arch === "arm" ? "linux-armhf" : "linux-x64";
  }
}

/** Resolves the executable the same way @vscode/test-electron does for a cache entry. */
export async function vscodeExecutablePath(downloadDir: string, platform: string): Promise<string> {
  if (platform === "darwin" || platform === "darwin-arm64") {
    return resolveDarwinAppExecutable(path.join(downloadDir, "Visual Studio Code.app"));
  }
  if (platform === "win32-x64-archive" || platform === "win32-arm64-archive") {
    return path.join(downloadDir, "Code.exe");
  }
  return path.join(downloadDir, "code");
}

async function resolveDarwinAppExecutable(appPath: string): Promise<string> {
  const macosDir = path.resolve(appPath, "Contents", "MacOS");
  const infoPlistPath = path.resolve(appPath, "Contents", "Info.plist");
  try {
    const plist = await fs.readFile(infoPlistPath, "utf8");
    const match = plist.match(/<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/);
    if (match !== null) {
      const candidate = path.resolve(macosDir, match[1] ?? "Electron");
      if (candidate.startsWith(`${macosDir}${path.sep}`) && (await fileExists(candidate))) {
        return candidate;
      }
    }
  } catch {
    // Fall through to the legacy Electron name.
  }
  return path.resolve(macosDir, "Electron");
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function fetchLatestStableVersion(): Promise<string> {
  const response = await fetch(VSCODE_STABLE_RELEASES_API, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`VS Code stable release API returned HTTP ${response.status}`);
  const releases = (await response.json()) as readonly unknown[];
  const latest = releases[0];
  if (typeof latest !== "string" || latest.length === 0) {
    throw new Error("VS Code stable release API returned no versions");
  }
  return latest;
}

/**
 * Downloads and unzips VS Code into the shared `.vscode-test` cache with the
 * resume-capable curl instead of the library's flaky streaming downloader.
 * Windows keeps the library downloader (zip format, unaffected in CI).
 */
export async function downloadVSCodeRobustly(version: GrammarVersion): Promise<string> {
  const platform = vscodeTestPlatform();
  if (platform === "win32-x64-archive" || platform === "win32-arm64-archive") {
    return downloadAndUnzipVSCode({ version, extractSync: true });
  }
  const resolvedVersion = version === "stable" ? await fetchLatestStableVersion() : version;
  const downloadDir = path.join(
    process.cwd(),
    ".vscode-test",
    `vscode-${platform}-${resolvedVersion}`,
  );
  const marker = path.join(downloadDir, "is-complete");
  if (await fileExists(marker)) return vscodeExecutablePath(downloadDir, platform);
  const archiveUrl = `https://update.code.visualstudio.com/${resolvedVersion}/${platform}/stable?released=true`;
  let lastError: unknown;
  for (let attempt = 1; attempt <= VSCODE_DOWNLOAD_RETRIES; attempt += 1) {
    try {
      await fs.rm(downloadDir, { recursive: true, force: true });
      await fs.mkdir(downloadDir, { recursive: true });
      const archiveParent = await fs.mkdtemp(path.join(os.tmpdir(), "vscode-archive-"));
      const archivePath = path.join(archiveParent, `vscode-${platform}-${resolvedVersion}.archive`);
      try {
        await spawnAndRequireZero(
          "curl",
          [
            "-fsSL",
            "--retry",
            "10",
            "--retry-all-errors",
            "--retry-delay",
            "2",
            "-C",
            "-",
            "--output",
            archivePath,
            archiveUrl,
          ],
          {
            shell: false,
            stdio: "inherit",
            timeoutMs: VSCODE_DOWNLOAD_TIMEOUT_MS,
          },
        );
        // macOS archives are zips (VSCode.app at the root, no strip); Linux
        // archives are tar.gz with a single top-level directory to strip.
        const isDarwin = platform.startsWith("darwin");
        await spawnAndRequireZero(
          isDarwin ? "unzip" : "tar",
          isDarwin
            ? ["-q", archivePath, "-d", downloadDir]
            : ["-xzf", archivePath, "--strip-components=1", "-C", downloadDir],
          {
            shell: false,
            stdio: "inherit",
            timeoutMs: VSCODE_DOWNLOAD_TIMEOUT_MS,
          },
        );
      } finally {
        await fs.rm(archiveParent, { recursive: true, force: true });
      }
      await fs.writeFile(marker, "", { encoding: "utf8" });
      return await vscodeExecutablePath(downloadDir, platform);
    } catch (error) {
      lastError = error;
      if (attempt < VSCODE_DOWNLOAD_RETRIES) {
        process.stderr.write(
          `VS Code ${resolvedVersion} download failed (attempt ${attempt} of ${VSCODE_DOWNLOAD_RETRIES}), retrying\n`,
        );
      }
    }
  }
  throw new Error(`Failed to download and unzip VS Code ${resolvedVersion}`, { cause: lastError });
}

function isWindowsAbsolute(value: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(value);
}

export function isAbsoluteExecutablePath(value: string): boolean {
  return path.isAbsolute(value) || isWindowsAbsolute(value);
}

export async function buildIntegrationRunner(root: string): Promise<void> {
  const outfile = path.join(root, "dist-test", "integration", "run.js");
  const integrationDir = path.dirname(outfile);
  await fs.mkdir(integrationDir, { recursive: true });
  // The repository is ESM, while VS Code's Extension Host loads the test
  // entrypoint with require(). Scope this generated directory as CommonJS
  // without changing the product package's module mode.
  await fs.writeFile(
    path.join(integrationDir, "package.json"),
    JSON.stringify({ type: "commonjs" }),
    { encoding: "utf8" },
  );
  await build({
    entryPoints: [path.join(root, "test", "integration", "run.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["vscode"],
    sourcemap: false,
    legalComments: "none",
  });
}

export async function writeScenarioUserSettings(
  scenario: IntegrationScenario,
  userDataDir: string,
): Promise<void> {
  const userDir = path.join(userDataDir, "User");
  await fs.mkdir(userDir, { recursive: false });
  const settings =
    scenario === "untrusted"
      ? {
          "security.workspace.trust.enabled": true,
          "security.workspace.trust.startupPrompt": "never",
        }
      : {};
  await fs.writeFile(path.join(userDir, "settings.json"), JSON.stringify(settings), {
    encoding: "utf8",
    flag: "wx",
  });
}

function assertBelow(root: string, target: string, label: string): void {
  const rootResolved = path.resolve(root);
  const targetResolved = path.resolve(target);
  const relative = path.relative(rootResolved, targetResolved);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`${label} escaped its root`);
  }
}

export async function copyScenarioWorkspace(
  scenario: IntegrationScenario,
  destination: string,
  root: string,
): Promise<void> {
  const fixture = scenario === "untrusted" ? "untrusted" : "trusted";
  const source = path.join(root, "test", "fixtures", "workspaces", fixture);
  await fs.cp(source, destination, { recursive: true, errorOnExist: true });
  assertBelow(path.dirname(destination), destination, "workspace");
  await fs.copyFile(
    path.join(root, "test", "fixtures", "notebooks", "jupyter.ipynb"),
    path.join(destination, "jupyter.ipynb"),
  );
  await fs.copyFile(
    path.join(root, "test", "fixtures", "notebooks", "marimo.py"),
    path.join(destination, "marimo.py"),
  );
}

const fixtureExtensions = [["marimo-language", "inline-sql-tests.marimo-language-0.0.1"]] as const;

export async function findInstalledExtensionRoot(
  extensionsDir: string,
  extensionId: string,
): Promise<string> {
  const prefix = `${extensionId}-`;
  const matches = (await fs.readdir(extensionsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => path.join(extensionsDir, entry.name));
  if (matches.length !== 1) throw new Error(`expected one installed ${extensionId}`);
  const match = matches[0];
  if (match === undefined) throw new Error(`expected one installed ${extensionId}`);
  const root = path.resolve(match);
  assertBelow(extensionsDir, root, "installed extension");
  return root;
}

export async function installCompatibilityExtensions(
  executable: string,
  extensionsDir: string,
  extensionIds: readonly string[],
): Promise<void> {
  const appRoot =
    process.platform === "darwin"
      ? path.resolve(executable, "../../Resources/app")
      : path.resolve(path.dirname(executable), "resources/app");
  const cliScript = path.join(appRoot, "out", "cli.js");
  for (const extensionId of extensionIds) {
    await spawnAndRequireZero(
      executable,
      [cliScript, "--extensions-dir", extensionsDir, "--install-extension", extensionId, "--force"],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        shell: false,
        timeoutMs: 120_000,
      },
    );
  }
}

export async function installFixtureExtensions(
  scenario: IntegrationScenario,
  extensionsDir: string,
  executable: string,
  root: string,
  vscodeVersion: GrammarVersion = "stable",
): Promise<string | undefined> {
  if (scenario === "compatibility") {
    if (vscodeVersion !== "stable") {
      throw new Error("official compatibility extensions are supported on VS Code stable only");
    }
    await installCompatibilityExtensions(executable, extensionsDir, [
      "ms-python.python",
      "ms-toolsai.jupyter",
      "marimo-team.vscode-marimo",
    ]);
    return findInstalledExtensionRoot(extensionsDir, "marimo-team.vscode-marimo");
  }
  for (const [sourceName, installedName] of fixtureExtensions) {
    const destination = path.join(extensionsDir, installedName);
    assertBelow(extensionsDir, destination, "fixture extension");
    await fs.cp(path.join(root, "test", "fixtures", "extensions", sourceName), destination, {
      recursive: true,
      errorOnExist: true,
    });
  }
  return undefined;
}

export function buildLaunchCommand(input: LaunchInput): LaunchCommand {
  const launchArgs = [
    input.workspacePath,
    `--extensionDevelopmentPath=${input.repositoryRoot}`,
    `--extensionTestsPath=${input.testsPath}`,
    "--user-data-dir",
    input.userDataDir,
    "--extensions-dir",
    input.extensionsDir,
    "--disable-updates",
    "--skip-welcome",
    "--skip-release-notes",
  ];
  if (input.scenario !== "untrusted") launchArgs.push("--disable-workspace-trust");
  if (process.platform === "linux") {
    return {
      command: "xvfb-run",
      args: ["-a", input.executable, "--no-sandbox", "--disable-gpu", ...launchArgs],
    };
  }
  return { command: input.executable, args: launchArgs };
}

export async function terminateProcessTree(processId: number): Promise<void> {
  if (process.platform !== "win32") {
    try {
      process.kill(-processId, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    return;
  }
  await new Promise<void>((resolve) => {
    let killer: ChildProcess;
    try {
      killer = spawn("taskkill.exe", ["/pid", String(processId), "/T", "/F"], {
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      resolve();
      return;
    }
    let settled = false;
    const timerState: { value?: NodeJS.Timeout } = {};
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (timerState.value !== undefined) clearTimeout(timerState.value);
      killer.removeAllListeners();
      resolve();
    };
    killer.once("error", finish);
    killer.once("exit", finish);
    timerState.value = setTimeout(() => {
      killer.kill();
      finish();
    }, 10_000);
  });
}

export async function spawnAndRequireZero(
  command: string,
  args: readonly string[],
  options: SpawnRunOptions,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const schedule = options.setTimeout ?? setTimeout;
    const cancel = options.clearTimeout ?? clearTimeout;
    let child: ChildProcess;
    try {
      child = (options.spawnProcess ?? spawn)(command, [...args], {
        detached: process.platform !== "win32",
        env: options.env ?? process.env,
        shell: false,
        stdio: options.stdio ?? "inherit",
        windowsHide: true,
      });
    } catch {
      reject(new Error("VS Code process spawn failed"));
      return;
    }
    let settled = false;
    let timingOut = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) cancel(timer);
      child.removeAllListeners();
      // Keep a sink for a late Electron error after the promise has settled.
      child.on("error", () => {});
      if (error === undefined) resolve();
      else reject(error);
    };
    const beginTimeout = (): void => {
      if (settled || timingOut) return;
      timingOut = true;
      if (timer !== undefined) {
        cancel(timer);
        timer = undefined;
      }
      const timeoutError = new Error("VS Code process timed out");
      child.removeAllListeners();
      // Keep a sink installed while the tree-kill command is in flight. The
      // Electron child may report an error before termination resolves.
      child.on("error", () => {});
      if (child.pid === undefined) {
        finish(timeoutError);
        return;
      }
      void (options.terminateTree ?? terminateProcessTree)(child.pid).then(
        () => {
          finish(timeoutError);
        },
        () => {
          finish(timeoutError);
        },
      );
    };
    child.once("error", () => {
      finish(new Error("VS Code process failed"));
    });
    child.once("exit", (code, signal) => {
      if (timingOut) return;
      if (code === 0 && signal === null) finish();
      else finish(new Error("VS Code process exited unsuccessfully"));
    });
    timer = schedule(beginTimeout, options.timeoutMs);
  });
}

export interface LaunchDependencies {
  readonly download?: (version: GrammarVersion) => Promise<string>;
  readonly spawn?: typeof spawnAndRequireZero;
}

interface GrammarContributionManifest {
  readonly contributes?: {
    readonly grammars?: readonly {
      readonly scopeName?: unknown;
      readonly path?: unknown;
      readonly injectTo?: unknown;
      readonly embeddedLanguages?: unknown;
    }[];
    readonly notebooks?: readonly { readonly type?: unknown }[];
  };
}

async function verifyProductGrammarManifest(root: string): Promise<void> {
  const manifest = JSON.parse(
    await fs.readFile(path.join(root, "package.json"), "utf8"),
  ) as GrammarContributionManifest;
  const grammars = manifest.contributes?.grammars ?? [];
  const expected = new Map([["inline-sql.injection", { embedded: "sql" }]]);
  const seen = new Set<string>();
  for (const grammar of grammars) {
    if (typeof grammar.scopeName === "string") {
      if (seen.has(grammar.scopeName))
        throw new Error(`duplicate grammar scope ${grammar.scopeName}`);
      seen.add(grammar.scopeName);
    }
  }
  for (const [scope, requirement] of expected) {
    const matches = grammars.filter((grammar) => grammar.scopeName === scope);
    if (matches.length !== 1) throw new Error(`missing or duplicate grammar contribution ${scope}`);
    const grammar = matches[0];
    if (grammar === undefined) throw new Error(`missing grammar contribution ${scope}`);
    const targets = grammar.injectTo;
    if (
      !Array.isArray(targets) ||
      targets.length !== 2 ||
      !targets.every((target) => target === "source.python" || target === "source.mo-python")
    ) {
      throw new Error(`grammar ${scope} has an unexpected injection target`);
    }
    const embedded = grammar.embeddedLanguages;
    if (
      typeof embedded !== "object" ||
      embedded === null ||
      (embedded as Record<string, unknown>)[`meta.embedded.${requirement.embedded}`] !==
        requirement.embedded
    ) {
      throw new Error(`grammar ${scope} has an unexpected embedded language`);
    }
  }
  if ((manifest.contributes?.notebooks?.length ?? 0) !== 0) {
    throw new Error("production manifest must not contribute notebook types");
  }
}

async function verifyMarimoManifest(root: string): Promise<void> {
  const manifest = JSON.parse(
    await fs.readFile(path.join(root, "package.json"), "utf8"),
  ) as GrammarContributionManifest & {
    readonly contributes?: GrammarContributionManifest["contributes"] & {
      readonly languages?: readonly { readonly id?: unknown }[];
    };
  };
  const languages = manifest.contributes?.languages?.filter(({ id }) => id === "mo-python") ?? [];
  const grammars =
    manifest.contributes?.grammars?.filter(({ scopeName }) => scopeName === "source.mo-python") ??
    [];
  const notebooks =
    manifest.contributes?.notebooks?.filter(({ type }) => type === "marimo-notebook") ?? [];
  if (languages.length !== 1 || grammars.length !== 1 || notebooks.length !== 1) {
    throw new Error("marimo test extension contributions are incomplete");
  }
}

export async function verifyIntegrationGrammarScopes(
  version: GrammarVersion,
  officialMarimoExtensionRoot?: string,
): Promise<void> {
  await verifyProductGrammarManifest(repositoryRoot);
  await verifyMarimoManifest(
    officialMarimoExtensionRoot ??
      path.join(repositoryRoot, "test", "fixtures", "extensions", "marimo-language"),
  );
  void version;
  void officialMarimoExtensionRoot;
}

export async function launchScenario(
  options: ScenarioOptions,
  dependencies: LaunchDependencies = {},
): Promise<void> {
  if (options.scenario === "compatibility" && options.vscodeVersion !== "stable") {
    throw new Error("official compatibility extensions are supported on VS Code stable only");
  }
  const scenarioRoot = await fs.mkdtemp(path.join(os.tmpdir(), `inline-sql-${options.scenario}-`));
  const expectedParent = path.resolve(os.tmpdir());
  const rootParent = path.dirname(path.resolve(scenarioRoot));
  if (
    rootParent !== expectedParent ||
    !path.basename(scenarioRoot).startsWith(`inline-sql-${options.scenario}-`)
  ) {
    throw new Error("mkdtemp returned an unexpected scenario root");
  }
  try {
    const userDataDir = path.join(scenarioRoot, "user-data");
    const extensionsDir = path.join(scenarioRoot, "extensions");
    const workspacePath = path.join(scenarioRoot, "workspace");
    await Promise.all([
      fs.mkdir(userDataDir),
      fs.mkdir(extensionsDir),
      copyScenarioWorkspace(options.scenario, workspacePath, options.repositoryRoot),
    ]);
    await writeScenarioUserSettings(options.scenario, userDataDir);
    const executable = await (
      dependencies.download ??
      (async (version) => downloadAndUnzipVSCode({ version, extractSync: true }))
    )(options.vscodeVersion);
    const officialMarimoExtensionRoot = await installFixtureExtensions(
      options.scenario,
      extensionsDir,
      executable,
      options.repositoryRoot,
      options.vscodeVersion,
    );
    await verifyIntegrationGrammarScopes(options.vscodeVersion, officialMarimoExtensionRoot);
    const testsPath = path.join(options.repositoryRoot, "dist-test", "integration", "run.js");
    const { command, args } = buildLaunchCommand({
      executable,
      repositoryRoot: options.repositoryRoot,
      testsPath,
      workspacePath,
      userDataDir,
      extensionsDir,
      scenario: options.scenario,
    });
    await (dependencies.spawn ?? spawnAndRequireZero)(command, args, {
      env: {
        ...process.env,
        INLINE_SQL_TEST_SCENARIO: options.scenario,
      },
      shell: false,
      stdio: "inherit",
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
  } finally {
    await fs.rm(scenarioRoot, { recursive: true, force: true });
  }
}

export interface MainDependencies {
  readonly buildExtension?: () => Promise<unknown>;
  readonly buildIntegrationRunner?: (root: string) => Promise<void>;
  readonly launchScenario?: (options: ScenarioOptions) => Promise<void>;
}

async function withWorkingDirectory<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(root);
  try {
    return await operation();
  } finally {
    process.chdir(previous);
  }
}

export async function main(
  argv: readonly string[] = process.argv,
  dependencies: MainDependencies = {},
): Promise<void> {
  const scenario = parseScenario(argv[2]);
  const vscodeVersion = parseGrammarVersion(process.env.VSCODE_TEST_VERSION);
  const root = repositoryRoot;
  await (dependencies.buildExtension ?? (() => withWorkingDirectory(root, buildExtension)))();
  await (dependencies.buildIntegrationRunner ?? buildIntegrationRunner)(root);
  if (dependencies.launchScenario !== undefined) {
    await dependencies.launchScenario({ scenario, vscodeVersion, repositoryRoot: root });
  } else {
    await launchScenario(
      { scenario, vscodeVersion, repositoryRoot: root },
      { download: downloadVSCodeRobustly },
    );
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
