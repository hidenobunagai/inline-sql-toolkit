import type { ChildProcessWithoutNullStreams } from "node:child_process";

import * as vscode from "vscode";

import type {
  ErrorResponse,
  FormatOptions,
  FormatResponse,
  FormatTarget,
  HelperRequest,
  LocateResponse,
  ProtocolOperation,
  ReasonCode,
} from "../protocol.js";
import { parseProtocolValue, serializeRequest } from "../protocol.js";
import type { SupportedDocument } from "./document-target.js";
import type { PythonResolver, ResolvedPython } from "./python-resolver.js";

export const MAX_STDIN_BYTES = 32 * 1024 * 1024;
export const MAX_STDOUT_BYTES = 64 * 1024 * 1024;
export const MAX_STDERR_BYTES = 64 * 1024;
export const HELPER_TIMEOUT_MS = 5_000;

export interface DocumentSnapshot {
  readonly uri: vscode.Uri;
  readonly version: number;
  readonly text: string;
}

export interface HelperClient {
  locate(
    snapshot: DocumentSnapshot,
    target: FormatTarget,
    configuration: FormatOptions,
    resource: SupportedDocument,
    token: vscode.CancellationToken,
  ): Promise<LocateResponse>;

  format(
    snapshot: DocumentSnapshot,
    target: FormatTarget,
    configuration: FormatOptions,
    resource: SupportedDocument,
    token: vscode.CancellationToken,
  ): Promise<FormatResponse>;
}

export interface HelperClientDependencies {
  readonly extensionUri: vscode.Uri;
  readonly resolver: PythonResolver;
  readonly isWorkspaceTrusted: () => boolean;
  readonly processWillSpawn?: (kind: "helper") => void;
  readonly spawn: typeof import("node:child_process").spawn;
}

/** A byte collector that does not retain a chunk which would cross its limit. */
export class BoundedBytes {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  private active = true;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): boolean {
    if (!this.active || this.size + chunk.byteLength > this.limit) return false;
    this.chunks.push(chunk);
    this.size += chunk.byteLength;
    return true;
  }

  seal(): void {
    this.active = false;
  }

  get length(): number {
    return this.size;
  }

  concat(): Buffer {
    return Buffer.concat(this.chunks, this.size);
  }
}

type ProcessResult<T> =
  { readonly ok: true; readonly response: T } | { readonly ok: false; readonly code: ReasonCode };

function requestError(operation: ProtocolOperation, code: ReasonCode): ErrorResponse {
  return {
    protocolVersion: 1,
    operation,
    ok: false,
    error: { code },
  };
}

function helperRequest(
  operation: ProtocolOperation,
  snapshot: DocumentSnapshot,
  target: FormatTarget,
  options: FormatOptions,
): HelperRequest {
  return {
    protocolVersion: 1,
    operation,
    source: snapshot.text,
    target,
    options,
  };
}

function asBuffer(chunk: Buffer | string | Uint8Array): Buffer {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

/** Keep an error sink attached after settlement so late stream events cannot throw. */
function ignoreError(): void {
  // Deliberately ignore errors after the request has already settled.
}

function killProcess(child: ChildProcessWithoutNullStreams): void {
  try {
    child.kill();
  } catch {
    // The process may have exited between the failure and kill request.
  }
}

function runHelperProcess<T extends LocateResponse | FormatResponse>(
  operation: ProtocolOperation,
  requestBytes: Uint8Array,
  resolvedPython: ResolvedPython,
  responseKind: "locateResponse" | "formatResponse",
  dependencies: HelperClientDependencies,
  token: vscode.CancellationToken,
): Promise<ProcessResult<T>> {
  if (requestBytes.byteLength > MAX_STDIN_BYTES) {
    return Promise.resolve({ ok: false, code: "RESOURCE_LIMIT_EXCEEDED" });
  }
  if (token.isCancellationRequested) {
    return Promise.resolve({ ok: false, code: "PROCESS_CANCELLED" });
  }
  if (!dependencies.isWorkspaceTrusted()) {
    return Promise.resolve({ ok: false, code: "WORKSPACE_UNTRUSTED" });
  }

  // Keep this sentinel directly adjacent to the final trust check and spawn.
  // It is intentionally the only integration-visible process signal.
  dependencies.processWillSpawn?.("helper");
  const extensionRoot = dependencies.extensionUri.fsPath;
  const bootstrapPath = vscode.Uri.joinPath(
    dependencies.extensionUri,
    "python",
    "bootstrap.py",
  ).fsPath;
  let child: ChildProcessWithoutNullStreams;
  try {
    child = dependencies.spawn(
      resolvedPython.executable,
      ["-I", "-S", "-B", "-X", "utf8", bootstrapPath],
      {
        cwd: extensionRoot,
        env: process.env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
  } catch {
    return Promise.resolve({ ok: false, code: "PROCESS_FAILED" });
  }

  return new Promise<ProcessResult<T>>((resolve) => {
    const stdout = new BoundedBytes(MAX_STDOUT_BYTES);
    const stderr = new BoundedBytes(MAX_STDERR_BYTES);
    let settled = false;
    let killIssued = false;
    const timerState: { timeout?: NodeJS.Timeout; cancellation?: vscode.Disposable } = {};

    const finish = (result: ProcessResult<T>): void => {
      if (settled) return;
      settled = true;
      stdout.seal();
      stderr.seal();
      if (timerState.timeout !== undefined) clearTimeout(timerState.timeout);
      timerState.cancellation?.dispose();
      child.removeAllListeners();
      child.on("error", ignoreError);
      child.stdin.removeAllListeners();
      child.stdin.on("error", ignoreError);
      child.stdout.removeAllListeners();
      child.stdout.on("error", ignoreError);
      child.stderr.removeAllListeners();
      child.stderr.on("error", ignoreError);
      resolve(result);
    };

    const terminate = (code: ReasonCode): void => {
      if (settled) return;
      // Settle and remove listeners before kill: a process double may emit close
      // synchronously from kill(), and that close must not replace the reason.
      finish({ ok: false, code });
      if (!killIssued) {
        killIssued = true;
        killProcess(child);
      }
    };

    const failForStreamError = (): void => {
      terminate("PROCESS_FAILED");
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      if (!stdout.push(asBuffer(chunk))) {
        terminate("RESOURCE_LIMIT_EXCEEDED");
      }
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      if (!stderr.push(asBuffer(chunk))) {
        terminate("RESOURCE_LIMIT_EXCEEDED");
      }
    });
    child.stdout.on("error", failForStreamError);
    child.stderr.on("error", failForStreamError);
    child.stdin.on("error", failForStreamError);
    child.on("error", failForStreamError);
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      if (exitCode !== 0 || signal !== null || stderr.length !== 0) {
        finish({ ok: false, code: "PROCESS_FAILED" });
        return;
      }
      try {
        const jsonText = new TextDecoder("utf-8", { fatal: true }).decode(stdout.concat());
        const response = parseProtocolValue(responseKind, JSON.parse(jsonText)) as T;
        if (response.operation !== operation) {
          finish({ ok: false, code: "PROTOCOL_ERROR" });
          return;
        }
        finish({ ok: true, response });
      } catch {
        finish({ ok: false, code: "PROTOCOL_ERROR" });
      }
    });

    timerState.timeout = setTimeout(() => {
      terminate("PROCESS_TIMEOUT");
    }, HELPER_TIMEOUT_MS);
    timerState.cancellation = token.onCancellationRequested(() => {
      terminate("PROCESS_CANCELLED");
    });

    if (token.isCancellationRequested) {
      terminate("PROCESS_CANCELLED");
      return;
    }
    try {
      child.stdin.end(Buffer.from(requestBytes));
    } catch {
      terminate("PROCESS_FAILED");
    }
  });
}

export class DefaultHelperClient implements HelperClient {
  constructor(private readonly dependencies: HelperClientDependencies) {}

  private async invoke(
    operation: ProtocolOperation,
    snapshot: DocumentSnapshot,
    target: FormatTarget,
    configuration: FormatOptions,
    resource: SupportedDocument,
    token: vscode.CancellationToken,
  ): Promise<LocateResponse | FormatResponse> {
    let resolution: Awaited<ReturnType<PythonResolver["resolve"]>>;
    try {
      resolution = await this.dependencies.resolver.resolve(resource, token);
    } catch {
      return requestError(operation, "PROCESS_FAILED");
    }
    if (!resolution.ok) return requestError(operation, resolution.reason);
    if (token.isCancellationRequested) return requestError(operation, "PROCESS_CANCELLED");
    if (!this.dependencies.isWorkspaceTrusted())
      return requestError(operation, "WORKSPACE_UNTRUSTED");

    let requestBytes: Uint8Array;
    try {
      requestBytes = serializeRequest(helperRequest(operation, snapshot, target, configuration));
    } catch {
      return requestError(operation, "PROTOCOL_ERROR");
    }
    const result = await runHelperProcess(
      operation,
      requestBytes,
      resolution.python,
      operation === "locate" ? "locateResponse" : "formatResponse",
      this.dependencies,
      token,
    );
    return result.ok ? result.response : requestError(operation, result.code);
  }

  locate(
    snapshot: DocumentSnapshot,
    target: FormatTarget,
    configuration: FormatOptions,
    resource: SupportedDocument,
    token: vscode.CancellationToken,
  ): Promise<LocateResponse> {
    return this.invoke(
      "locate",
      snapshot,
      target,
      configuration,
      resource,
      token,
    ) as Promise<LocateResponse>;
  }

  format(
    snapshot: DocumentSnapshot,
    target: FormatTarget,
    configuration: FormatOptions,
    resource: SupportedDocument,
    token: vscode.CancellationToken,
  ): Promise<FormatResponse> {
    return this.invoke(
      "format",
      snapshot,
      target,
      configuration,
      resource,
      token,
    ) as Promise<FormatResponse>;
  }
}
