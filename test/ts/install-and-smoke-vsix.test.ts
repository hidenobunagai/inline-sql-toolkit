import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildInstallCommand,
  buildInstallInvocation,
  buildSmokeCommand,
  resolveCliScript,
} from "../../tools/install_and_smoke_vsix.js";

const input = {
  executable: "/tmp/code",
  vsix: "/tmp/inline.vsix",
  driver: "/tmp/driver",
  workspace: "/tmp/workspace",
  userData: "/tmp/user-data",
  extensions: "/tmp/extensions",
} as const;

const tempRoots: string[] = [];

async function makeVscodeRoot(): Promise<{ root: string; executable: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "inline-sql-vsix-test-"));
  tempRoots.push(root);
  if (process.platform === "darwin") {
    const app = path.join(root, "Visual Studio Code.app", "Contents");
    const executable = path.join(app, "MacOS", "Code");
    await mkdir(path.dirname(executable), { recursive: true });
    const cli = path.join(app, "Resources", "app", "out");
    await mkdir(cli, { recursive: true });
    await writeFile(path.join(cli, "cli.js"), "module.exports = {};\n");
    return { root, executable };
  }
  const executable = path.join(root, "Code.exe");
  await mkdir(path.dirname(executable), { recursive: true });
  const cli = path.join(root, "resources", "app", "out");
  await mkdir(cli, { recursive: true });
  await writeFile(path.join(cli, "cli.js"), "module.exports = {};\n");
  return { root, executable };
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

describe("offline VSIX install smoke command", () => {
  it("installs only the supplied VSIX into isolated directories", () => {
    expect(buildInstallCommand(input)).toEqual([
      "/tmp/code",
      "--extensions-dir",
      "/tmp/extensions",
      "--user-data-dir",
      "/tmp/user-data",
      "--install-extension",
      "/tmp/inline.vsix",
      "--force",
    ]);
  });

  it("uses the fixture driver as the only extension development path", () => {
    const args = buildSmokeCommand(input);
    expect(args).toContain("--extensionDevelopmentPath=/tmp/driver");
    expect(args).toContain("--disable-workspace-trust");
    expect(args).not.toContain(
      "--extensionDevelopmentPath=/Users/hidenobunagai/Projects/inline-sql-toolkit",
    );
  });

  it("resolves the VS Code CLI without using a shell", async () => {
    const { executable } = await makeVscodeRoot();
    const script = await resolveCliScript(executable);
    expect(script).toMatch(/[\\/]app[\\/]out[\\/]cli\.js$/);
  });

  it.skipIf(process.platform === "darwin")(
    "resolves the hashed VS Code layout used by recent archives",
    async () => {
      const { root, executable } = await makeVscodeRoot();
      const hashed = path.join(root, "e4c7e7b1d6", "resources", "app", "out");
      await mkdir(hashed, { recursive: true });
      await writeFile(path.join(hashed, "cli.js"), "module.exports = {};\n");
      const script = await resolveCliScript(executable);
      expect(script).toContain("e4c7e7b1d6");
    },
  );

  it("passes the non-executable CLI script as an Electron argv", async () => {
    const { executable } = await makeVscodeRoot();
    const resolved = { ...input, executable };
    const invocation = await buildInstallInvocation(resolved);
    expect(invocation.command).toBe(executable);
    expect(invocation.args[0]).toBe(await resolveCliScript(executable));
    expect(invocation.args).toContain("--install-extension");
  });
});
