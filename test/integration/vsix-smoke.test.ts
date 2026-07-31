import assert from "node:assert/strict";
import * as fs from "node:fs/promises";

export async function testInstalledVsixSmoke(
  resultPath = process.env.INLINE_SQL_VSIX_SMOKE_RESULT,
): Promise<void> {
  if (typeof resultPath !== "string") throw new Error("missing VSIX smoke result");
  const value = JSON.parse(await fs.readFile(resultPath, "utf8")) as { ok?: unknown };
  assert.equal(value.ok, true);
}
