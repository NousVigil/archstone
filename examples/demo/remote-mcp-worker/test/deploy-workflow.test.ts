// AC-3.9: the deploy workflow runs only for the Worker, the Showcase and the packages in the
// Worker's closure, runs the Showcase suite first, and cannot deploy if that fails.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(resolve(here, "../../../../.github/workflows/deploy-demo-worker.yml"), "utf8");

interface Step {
  name?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
}
interface Job {
  name?: string;
  needs?: string | string[];
  if?: string;
  steps: Step[];
}
const wf = parse(raw) as {
  on: { push: { branches: string[]; paths: string[] }; pull_request: { paths: string[] } };
  jobs: Record<string, Job>;
};

describe("deploy workflow", () => {
  it("path filters include the Showcase and the Worker, and no longer the tourism example", () => {
    const paths = wf.on.push.paths;
    expect(paths).toContain("examples/showcase/**");
    expect(paths).toContain("examples/demo/remote-mcp-worker/**");
    expect(paths).not.toContain("examples/manifests/tourism/**");
  });

  it("keeps the package closure, and never widens it to every package or provider", () => {
    const paths = wf.on.push.paths;
    for (const p of ["packages/compiler/**", "packages/emitter-support/**", "packages/runtime/**", "packages/schema/**", "providers/rest/**"]) {
      expect(paths).toContain(p);
    }
    expect(paths).not.toContain("packages/**");
    expect(paths).not.toContain("providers/**");
    expect(paths.every((p) => !p.startsWith("examples/manifests/"))).toBe(true);
  });

  it("the pull-request trigger uses the same filters, so unrelated changes run nothing", () => {
    expect(wf.on.pull_request.paths).toEqual(wf.on.push.paths);
  });

  it("has a deploy-gate job running the Showcase suite, and deploy needs it", () => {
    const gate = wf.jobs["deploy-gate"];
    expect(gate.name).toBe("deploy-gate");
    expect(gate.steps.some((s) => (s.run ?? "").includes("vitest run examples/showcase"))).toBe(true);
    expect(gate.steps.some((s) => (s.run ?? "").includes("test:workerd"))).toBe(true);
    expect([wf.jobs.deploy.needs].flat()).toContain("deploy-gate");
    expect(wf.jobs.deploy.if ?? "").toContain("pull_request");
  });

  it("deploys only after the gate, and runs the live battery after the deploy", () => {
    const names = wf.jobs.deploy.steps.map((s) => s.name ?? "");
    const deploy = names.findIndex((n) => n === "Deploy");
    const battery = names.findIndex((n) => /live battery/i.test(n));
    expect(deploy).toBeGreaterThan(-1);
    expect(battery).toBeGreaterThan(deploy);
    expect(wf.jobs.deploy.steps[battery].run).toContain("live-battery");
  });

  it("waits for the rollout to be consistent (10 consecutive answers, bounded) and retries the battery once", () => {
    const steps = wf.jobs.deploy.steps;
    const wait = steps.find((s) => /wait for the new version/i.test(s.name ?? ""));
    const battery = steps.find((s) => /live battery/i.test(s.name ?? ""));
    expect(wait?.run).toMatch(/-ge 10/);
    expect(wait?.run).toMatch(/ok=0/); // a stale answer resets the streak
    expect(wait?.run).toMatch(/seq 1 90/);
    expect(wait?.run).not.toMatch(/\[ "\$code" = "405" \] && exit 0/);
    expect((battery?.run ?? "").match(/live-battery/g)).toHaveLength(2);
    expect(battery?.run).toMatch(/sleep 45/);
  });

  it("uses the existing repository secrets, and holds no secret value or local path", () => {
    expect(raw).toContain("secrets.CLOUDFLARE_API_TOKEN");
    expect(raw).toContain("secrets.CLOUDFLARE_ACCOUNT_ID");
    const secrets = [...raw.matchAll(/secrets\.(\w+)/g)].map((m) => m[1]);
    expect(new Set(secrets)).toEqual(new Set(["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]));
    expect(raw).not.toMatch(/\/Users\/|\/home\/|\.env/);
  });
});
