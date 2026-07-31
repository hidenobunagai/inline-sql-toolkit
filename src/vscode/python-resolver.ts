import { spawn as nodeSpawn } from "node:child_process";

import type { PythonExtension } from "@vscode/python-extension";
import * as vscode from "vscode";

import type { SupportedDocument } from "./document-target.js";

export interface ResolvedPython {
  readonly executable: string;
  readonly version: { readonly major: number; readonly minor: number; readonly patch: number };
  readonly source: "configuration" | "python-extension" | "path";
}

export type VersionProbeFailureReason =
  | "PYTHON_NOT_FOUND"
  | "PYTHON_VERSION_UNSUPPORTED"
  | "WORKSPACE_UNTRUSTED"
  | "PROCESS_TIMEOUT"
  | "PROCESS_CANCELLED"
  | "PROCESS_FAILED";

export type VersionProbeResult =
  | { readonly ok: true; readonly version: ResolvedPython["version"] }
  | { readonly ok: false; readonly reason: VersionProbeFailureReason };

export type ResolvedPythonResult =
  | { readonly ok: true; readonly python: ResolvedPython }
  | { readonly ok: false; readonly reason: VersionProbeFailureReason | "INVALID_CONFIGURATION" };

export interface PythonResolverDependencies {
  readonly isWorkspaceTrusted: () => boolean;
  readonly processWillSpawn?: (kind: "version") => void;
  readonly getPythonExtension: () => vscode.Extension<unknown> | undefined;
  readonly getPythonApi: typeof PythonExtension.api;
  readonly spawn: typeof import("node:child_process").spawn;
  readonly onDidChangeConfiguration: vscode.Event<vscode.ConfigurationChangeEvent>;
  readonly onDidGrantWorkspaceTrust: vscode.Event<void>;
}

export interface PythonResolver extends vscode.Disposable {
  resolve(
    target: SupportedDocument,
    token: vscode.CancellationToken,
  ): Promise<ResolvedPythonResult>;
  invalidate(): void;
}

export const VERSION_ARGUMENTS = [
  "-I",
  "-S",
  "-B",
  "-X",
  "utf8",
  "-c",
  'import sys;print(".".join(map(str,sys.version_info[:3])))',
] as const;

const VERSION_OUTPUT_LIMIT = 4 * 1024;
const VERSION_TIMEOUT_MS = 5_000;
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)\r?\n?$/;

function asBuffer(chunk: Buffer | string): Buffer {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

function isCancelled(token: vscode.CancellationToken): boolean {
  return token.isCancellationRequested;
}

export function probeVersion(
  executable: string,
  token: vscode.CancellationToken,
  dependencies: PythonResolverDependencies,
): Promise<VersionProbeResult> {
  if (isCancelled(token)) return Promise.resolve({ ok: false, reason: "PROCESS_CANCELLED" });
  if (!dependencies.isWorkspaceTrusted())
    return Promise.resolve({ ok: false, reason: "WORKSPACE_UNTRUSTED" });

  return new Promise((resolve) => {
    if (isCancelled(token)) {
      resolve({ ok: false, reason: "PROCESS_CANCELLED" });
      return;
    }
    if (!dependencies.isWorkspaceTrusted()) {
      resolve({ ok: false, reason: "WORKSPACE_UNTRUSTED" });
      return;
    }

    // This is the final check/sentinel pair before the process is created. A
    // cache hit and every rejected/cancelled path return above without a signal.
    dependencies.processWillSpawn?.("version");
    let child: import("node:child_process").ChildProcessWithoutNullStreams;
    try {
      child = dependencies.spawn(executable, [...VERSION_ARGUMENTS], {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      resolve({ ok: false, reason: "PROCESS_FAILED" });
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const timerState: { timeout?: NodeJS.Timeout; cancellation?: vscode.Disposable } = {};

    const finish = (result: VersionProbeResult): void => {
      if (settled) return;
      settled = true;
      if (timerState.timeout !== undefined) clearTimeout(timerState.timeout);
      timerState.cancellation?.dispose();
      child.removeAllListeners();
      child.stdin.removeAllListeners();
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      resolve(result);
    };
    const terminate = (reason: VersionProbeFailureReason): void => {
      if (settled) return;
      finish({ ok: false, reason });
      try {
        child.kill();
      } catch {
        /* process is already gone */
      }
    };
    timerState.timeout = setTimeout(() => {
      terminate("PROCESS_TIMEOUT");
    }, VERSION_TIMEOUT_MS);
    timerState.cancellation = token.onCancellationRequested(() => {
      terminate("PROCESS_CANCELLED");
    });

    child.stdout.on("data", (chunk: Buffer | string) => {
      const value = asBuffer(chunk);
      stdoutBytes += value.byteLength;
      if (stdoutBytes > VERSION_OUTPUT_LIMIT) terminate("PROCESS_FAILED");
      else stdout.push(value);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      const value = asBuffer(chunk);
      stderrBytes += value.byteLength;
      if (stderrBytes > VERSION_OUTPUT_LIMIT) terminate("PROCESS_FAILED");
      else stderr.push(value);
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      finish({
        ok: false,
        reason: error.code === "ENOENT" ? "PYTHON_NOT_FOUND" : "PROCESS_FAILED",
      });
    });
    child.stdin.once("error", () => {
      terminate("PROCESS_FAILED");
    });
    child.once("close", (code, signal) => {
      if (code !== 0 || signal !== null || stderrBytes !== 0) {
        finish({ ok: false, reason: "PROCESS_FAILED" });
        return;
      }
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(stdout));
        const match = VERSION_PATTERN.exec(text);
        if (match === null) {
          finish({ ok: false, reason: "PROCESS_FAILED" });
          return;
        }
        const version = {
          major: Number(match[1]),
          minor: Number(match[2]),
          patch: Number(match[3]),
        };
        if (!Object.values(version).every(Number.isSafeInteger)) {
          finish({ ok: false, reason: "PROCESS_FAILED" });
          return;
        }
        finish(
          version.major > 3 || (version.major === 3 && version.minor >= 12)
            ? { ok: true, version }
            : { ok: false, reason: "PYTHON_VERSION_UNSUPPORTED" },
        );
      } catch {
        finish({ ok: false, reason: "PROCESS_FAILED" });
      }
    });

    if (isCancelled(token)) {
      terminate("PROCESS_CANCELLED");
      return;
    }
    try {
      child.stdin.end();
    } catch {
      terminate("PROCESS_FAILED");
    }
  });
}

async function resolveExecutable(
  executable: string,
  source: ResolvedPython["source"],
  token: vscode.CancellationToken,
  dependencies: PythonResolverDependencies,
): Promise<ResolvedPythonResult> {
  const probe = await probeVersion(executable, token, dependencies);
  return probe.ok ? { ok: true, python: { executable, version: probe.version, source } } : probe;
}

async function resolveUncached(
  target: SupportedDocument,
  configured: string | undefined,
  token: vscode.CancellationToken,
  dependencies: PythonResolverDependencies,
  onApi: (api: Awaited<ReturnType<typeof PythonExtension.api>>) => void,
): Promise<ResolvedPythonResult> {
  if (configured !== undefined)
    return resolveExecutable(configured, "configuration", token, dependencies);
  if (dependencies.getPythonExtension() !== undefined) {
    try {
      const api = await dependencies.getPythonApi();
      onApi(api);
      await api.ready;
      const active = api.environments.getActiveEnvironmentPath(target.resourceUri);
      const environment = await api.environments.resolveEnvironment(active);
      const executable = environment?.executable.uri?.fsPath;
      if (executable === undefined) return { ok: false, reason: "PROCESS_FAILED" };
      return await resolveExecutable(executable, "python-extension", token, dependencies);
    } catch {
      return { ok: false, reason: "PROCESS_FAILED" };
    }
  }
  const python3 = await resolveExecutable("python3", "path", token, dependencies);
  return !python3.ok && python3.reason === "PYTHON_NOT_FOUND"
    ? resolveExecutable("python", "path", token, dependencies)
    : python3;
}

function readConfiguredPythonPath(resourceUri: vscode.Uri): string | undefined | null {
  const value = vscode.workspace
    .getConfiguration("inlineSql", resourceUri)
    .get<unknown>("pythonPath");
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || value.trim() === "") return null;
  return value;
}

export class DefaultPythonResolver implements PythonResolver {
  private readonly cache = new Map<string, ResolvedPython>();
  private readonly disposables: vscode.Disposable[] = [];
  private generation = 0;
  private disposed = false;
  private apiEventsAttached = false;

  constructor(private readonly dependencies: PythonResolverDependencies) {
    this.disposables.push(
      dependencies.onDidChangeConfiguration(() => {
        this.invalidate();
      }),
    );
    this.disposables.push(
      dependencies.onDidGrantWorkspaceTrust(() => {
        this.invalidate();
      }),
    );
  }

  private attachApiEvents(api: Awaited<ReturnType<typeof PythonExtension.api>>): void {
    if (this.apiEventsAttached) return;
    this.apiEventsAttached = true;
    this.disposables.push(
      api.environments.onDidChangeActiveEnvironmentPath(() => {
        this.invalidate();
      }),
    );
  }

  async resolve(
    target: SupportedDocument,
    token: vscode.CancellationToken,
  ): Promise<ResolvedPythonResult> {
    if (this.disposed || !this.dependencies.isWorkspaceTrusted())
      return { ok: false, reason: "WORKSPACE_UNTRUSTED" };
    if (isCancelled(token)) return { ok: false, reason: "PROCESS_CANCELLED" };
    const configured = readConfiguredPythonPath(target.resourceUri);
    if (configured === null) return { ok: false, reason: "INVALID_CONFIGURATION" };
    const key = `${target.resourceUri.toString()}\0${configured ?? ""}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      if (!this.dependencies.isWorkspaceTrusted())
        return { ok: false, reason: "WORKSPACE_UNTRUSTED" };
      if (isCancelled(token)) return { ok: false, reason: "PROCESS_CANCELLED" };
      return { ok: true, python: cached };
    }
    const generation = this.generation;
    const result = await resolveUncached(target, configured, token, this.dependencies, (api) => {
      this.attachApiEvents(api);
    });
    if (!this.dependencies.isWorkspaceTrusted())
      return { ok: false, reason: "WORKSPACE_UNTRUSTED" };
    if (isCancelled(token)) return { ok: false, reason: "PROCESS_CANCELLED" };
    if (result.ok && generation === this.generation) this.cache.set(key, result.python);
    return result;
  }

  invalidate(): void {
    this.generation += 1;
    this.cache.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.invalidate();
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }
}

const defaultDependencies: PythonResolverDependencies = {
  isWorkspaceTrusted: () => vscode.workspace.isTrusted,
  getPythonExtension: () => vscode.extensions.getExtension("ms-python.python"),
  getPythonApi: async () => (await import("@vscode/python-extension")).PythonExtension.api(),
  spawn: nodeSpawn,
  onDidChangeConfiguration: vscode.workspace.onDidChangeConfiguration,
  onDidGrantWorkspaceTrust: vscode.workspace.onDidGrantWorkspaceTrust,
};

export function createPythonResolver(
  dependencies: PythonResolverDependencies = defaultDependencies,
): PythonResolver {
  return new DefaultPythonResolver(dependencies);
}
