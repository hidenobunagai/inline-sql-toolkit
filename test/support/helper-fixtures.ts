import { readFileSync } from "node:fs";

export interface ProtocolFixtureCase {
  readonly name: string;
  readonly kind: "request" | "locateResponse" | "formatResponse" | "preDispatchError";
  readonly value: unknown;
}

const fixtureKinds = new Set(["request", "locateResponse", "formatResponse", "preDispatchError"]);

function requireFixtureRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid protocol fixture object");
  }
  const record = value as Record<string, unknown>;
  const actualKeys = Object.keys(record).sort();
  const expectedKeys = [...keys].sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error("invalid protocol fixture keys");
  }
  return record;
}

export function loadProtocolCases(section: "valid" | "invalid"): readonly ProtocolFixtureCase[] {
  const decoded: unknown = JSON.parse(
    readFileSync("test/fixtures/helper/protocol-cases.json", "utf8"),
  );
  const root = requireFixtureRecord(decoded, ["valid", "invalid"]);
  const values = root[section];
  if (!Array.isArray(values)) {
    throw new Error("invalid protocol fixture section");
  }
  const names = new Set<string>();
  return values.map((value) => {
    const item = requireFixtureRecord(value, ["name", "kind", "value"]);
    if (
      typeof item.name !== "string" ||
      typeof item.kind !== "string" ||
      !fixtureKinds.has(item.kind) ||
      names.has(item.name)
    ) {
      throw new Error("invalid protocol fixture case");
    }
    names.add(item.name);
    return {
      name: item.name,
      kind: item.kind as ProtocolFixtureCase["kind"],
      value: item.value,
    };
  });
}
