/** Scenarios understood by the isolated VS Code integration runner. */
export type IntegrationScenario = "trusted" | "untrusted" | "compatibility";

/** Every document/notebook selector exercised by the synthetic matrix. */
export const integrationTargets = [
  { notebookType: undefined, language: "python" },
  { notebookType: undefined, language: "mo-python" },
  { notebookType: "jupyter-notebook", language: "python" },
  { notebookType: "marimo-notebook", language: "python" },
  { notebookType: "marimo-notebook", language: "mo-python" },
] as const;

/** Parse the fixed scenario enum shared by the outer runner and Extension Host. */
export function parseScenario(value: string | undefined): IntegrationScenario {
  if (value === "trusted" || value === "untrusted" || value === "compatibility") {
    return value;
  }
  throw new Error("invalid integration scenario");
}
