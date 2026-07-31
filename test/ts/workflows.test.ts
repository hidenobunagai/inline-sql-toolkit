import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

const root = path.resolve(import.meta.dirname, "../..");
const workflowRoot = path.join(root, ".github", "workflows");
const workflowNames = [
  "ci.yml",
  "compatibility.yml",
  "osv-scanner-pr.yml",
  "osv-scanner-scheduled.yml",
] as const;

type Workflow = {
  readonly name?: string;
  readonly on?: unknown;
  readonly permissions?: Record<string, unknown>;
  readonly concurrency?: { readonly ["cancel-in-progress"]?: unknown };
  readonly jobs?: Record<string, Job>;
};

type Job = {
  readonly needs?: string | readonly string[];
  readonly permissions?: Record<string, unknown>;
  readonly uses?: string;
  readonly with?: Record<string, unknown>;
  readonly strategy?: { readonly matrix?: Record<string, unknown> };
  readonly steps?: readonly Step[];
};

type Step = {
  readonly uses?: string;
  readonly run?: string;
  readonly with?: Record<string, unknown>;
  readonly name?: string;
};

async function loadWorkflow(name: (typeof workflowNames)[number]): Promise<Workflow> {
  const source = await readFile(path.join(workflowRoot, name), "utf8");
  const document = parseDocument(source);
  expect(document.errors).toEqual([]);
  return document.toJS() as Workflow;
}

function jobsOf(workflow: Workflow): Record<string, Job> {
  return workflow.jobs ?? {};
}

function allSteps(workflow: Workflow): Step[] {
  return Object.values(jobsOf(workflow)).flatMap((job) => [...(job.steps ?? [])]);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function ancestors(jobs: Record<string, Job>, jobName: string): Set<string> {
  const result = new Set<string>();
  const visit = (name: string): void => {
    const needs = jobs[name]?.needs;
    const names = typeof needs === "string" ? [needs] : (needs ?? []);
    for (const dependency of names) {
      if (result.has(dependency)) continue;
      result.add(dependency);
      visit(dependency);
    }
  };
  visit(jobName);
  return result;
}

describe("GitHub workflow contracts", () => {
  it("declares all workflows and pins every third-party action", async () => {
    for (const name of workflowNames) {
      const workflow = await loadWorkflow(name);
      expect(workflow.permissions).toMatchObject({ contents: "read" });
      for (const step of allSteps(workflow)) {
        if (step.uses === undefined) continue;
        expect(step.uses).toMatch(/^[^/]+\/[^@]+@[0-9a-f]{40}$/u);
      }
    }
  });

  it("cancels stale pull-request runs and freezes dependency installs", async () => {
    const workflow = await loadWorkflow("ci.yml");
    expect(workflow.concurrency?.["cancel-in-progress"]).toBe(true);
    const runs = allSteps(workflow)
      .map((step) => step.run ?? "")
      .join("\n");
    expect(runs).toContain("bun install --frozen-lockfile --ignore-scripts");
    expect(runs).toContain("uv sync --frozen");
    expect(runs).toContain("verify_vendor.py --lock-projection-only");
    expect(runs).not.toMatch(/(?:^|\s)VSCODE_TEST_VERSION=[^\s]+\s+bun run/u);
  });

  it("keeps the CI dependency graph and package verification ordering explicit", async () => {
    const workflow = await loadWorkflow("ci.yml");
    const jobs = jobsOf(workflow);
    expect(ancestors(jobs, "package")).toEqual(
      new Set(["quality", "python-test", "grammar-gate", "integration", "performance"]),
    );
    expect(jobs["quality"]?.needs).toBeUndefined();
    expect(jobs["python-test"]?.needs).toBe("quality");
    expect(jobs["grammar-gate"]?.needs).toBe("quality");
    expect(jobs["integration"]?.needs).toEqual(["python-test", "grammar-gate"]);
    expect(jobs["performance"]?.needs).toBe("python-test");
    expect(jobs["package"]?.needs).toEqual(["integration", "performance"]);
    expect(jobs["vsix-install-smoke"]?.needs).toBe("package");
    expect(jobs["offline-smoke"]?.needs).toBe("package");

    const packageSteps = jobs["package"]?.steps ?? [];
    const verifyIndex = packageSteps.findIndex((step) => /verify_vsix/u.test(step.run ?? ""));
    const executeIndex = packageSteps.findIndex((step) =>
      /install_and_smoke|offline_vsix/u.test(step.run ?? ""),
    );
    expect(verifyIndex).toBeGreaterThanOrEqual(0);
    expect(executeIndex).toBe(-1);
    expect(
      jobs["vsix-install-smoke"]?.steps?.some((step) => /install_and_smoke/u.test(step.run ?? "")),
    ).toBe(true);
  });

  it("pins toolchain versions and uses explicit matrix environment", async () => {
    const workflow = await loadWorkflow("ci.yml");
    const jobs = jobsOf(workflow);
    for (const step of allSteps(workflow)) {
      if (step.uses?.startsWith("oven-sh/setup-bun@")) {
        expect(step.with?.["bun-version"]).toBe("1.3.8");
      }
      if (step.uses?.startsWith("astral-sh/setup-uv@")) {
        expect(step.with?.version).toBe("0.9.28");
      }
    }
    expect(jobs["python-test"]?.strategy?.matrix).toMatchObject({
      os: ["ubuntu-latest", "macos-latest", "windows-latest"],
      python: ["3.12", "3.13", "3.14"],
    });
    expect(jobs["grammar-gate"]?.strategy?.matrix?.vscode).toEqual(["1.95.0", "stable"]);
    expect(jobs["integration"]?.strategy?.matrix).toMatchObject({
      os: ["ubuntu-latest", "macos-latest", "windows-latest"],
      vscode: ["1.95.0", "stable"],
      trust: ["trusted", "untrusted"],
    });
  });

  it("prepares a pinned Docker image before the offline smoke", async () => {
    const workflow = await loadWorkflow("ci.yml");
    const steps = jobsOf(workflow)["offline-smoke"]?.steps ?? [];
    const pullIndex = steps.findIndex((step) => /docker\s+pull/u.test(step.run ?? ""));
    const inspectIndex = steps.findIndex((step) =>
      /docker(?:\s+image)?\s+inspect/u.test(step.run ?? ""),
    );
    const smokeIndex = steps.findIndex((step) => /offline_vsix_smoke/u.test(step.run ?? ""));
    expect(pullIndex).toBeGreaterThanOrEqual(0);
    expect(inspectIndex).toBeGreaterThan(pullIndex);
    expect(smokeIndex).toBeGreaterThan(inspectIndex);
    expect(steps[pullIndex]?.run).toContain(
      "python:3.12-slim@sha256:57cd7c3a7a273101a6485ba99423ee568157882804b1124b4dd04266317710de",
    );
    expect(steps[smokeIndex]?.run).toMatch(/python:3\.12-slim@sha256:[0-9a-f]{64}/u);
  });

  it("keeps OSV permissions and scan inputs scoped to reusable jobs", async () => {
    const ci = await loadWorkflow("ci.yml");
    const osv = Object.entries(jobsOf(ci)).filter(([, job]) => job.uses?.includes("osv-scanner"));
    expect(osv).toHaveLength(1);
    const [name, job] = osv[0] ?? [];
    expect(name).toBeDefined();
    expect(job?.permissions).toMatchObject({
      contents: "read",
      actions: "read",
      "security-events": "write",
    });
    expect(job?.with?.["scan-args"]).toBe("--lockfile=osv-scanner:vsix-components.osv.json");
    expect(job?.with?.["upload-sarif"]).toBe(true);
    const sourceWorkflows = await Promise.all([
      loadWorkflow("osv-scanner-pr.yml"),
      loadWorkflow("osv-scanner-scheduled.yml"),
    ]);
    const sourceScanArgs = sourceWorkflows
      .flatMap((sourceWorkflow) => Object.values(jobsOf(sourceWorkflow)))
      .map((candidate) => stringValue(candidate.with?.["scan-args"]))
      .join("\n");
    expect(sourceScanArgs).toContain("--lockfile=bun.lock");
    expect(sourceScanArgs).toContain("--lockfile=uv.lock");
    expect(sourceScanArgs).toContain(
      "--lockfile=requirements.txt:tools/sqlparse-vendor.requirements.txt",
    );
    for (const name of ["osv-scanner-pr.yml", "osv-scanner-scheduled.yml"] as const) {
      const workflow = await loadWorkflow(name);
      expect(Object.values(jobsOf(workflow)).some((job) => job.uses?.includes("osv-scanner"))).toBe(
        true,
      );
    }
  });

  it("declares compatibility as a stable-only scheduled/manual workflow", async () => {
    const workflow = await loadWorkflow("compatibility.yml");
    expect(workflow.on).toBeDefined();
    const jobs = jobsOf(workflow);
    expect(jobs.compatibility?.strategy?.matrix?.vscode).toEqual(["stable"]);
    const runs = allSteps(workflow)
      .map((step) => step.run ?? "")
      .join("\n");
    expect(runs).toContain("test:integration:compatibility");
    const runner = await readFile(path.join(root, "tools", "run_vscode_tests.ts"), "utf8");
    expect(runner).toContain('"ms-python.python"');
    expect(runner).toContain('"ms-toolsai.jupyter"');
    expect(runner).toContain('"marimo-team.vscode-marimo"');
    expect(runner).toContain(
      "official compatibility extensions are supported on VS Code stable only",
    );
  });
});
