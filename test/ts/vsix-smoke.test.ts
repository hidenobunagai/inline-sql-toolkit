import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { testInstalledVsixSmoke } from "../integration/vsix-smoke.test.js";

const tempRoots: string[] = [];

async function writeResult(value: unknown): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "inline-sql-vsix-result-"));
  tempRoots.push(root);
  const result = path.join(root, "result.json");
  await writeFile(result, JSON.stringify(value), "utf8");
  return result;
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

describe("installed VSIX smoke result", () => {
  it("accepts the result written by the smoke driver", async () => {
    await expect(testInstalledVsixSmoke(await writeResult({ ok: true }))).resolves.toBeUndefined();
  });

  it("rejects a smoke that did not pass", async () => {
    await expect(testInstalledVsixSmoke(await writeResult({ ok: false }))).rejects.toThrow(
      "VSIX smoke did not pass",
    );
  });
});
