import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectRequiredChecks } from "./detect.js";

describe("detectRequiredChecks", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "blastcheck-detect-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const write = (name: string, content: string) => writeFile(join(dir, name), content);
  const cmds = (checks: { cmd: string }[]) => checks.map((c) => c.cmd).sort();

  it("extracts test/lint/typecheck from package.json scripts", async () => {
    await write(
      "package.json",
      JSON.stringify({
        scripts: { test: "vitest run", lint: "biome check", typecheck: "tsc --noEmit" },
      }),
    );
    const checks = await detectRequiredChecks(dir);
    expect(cmds(checks)).toEqual(["npm run lint", "npm run typecheck", "npm test"]);
    expect(checks.every((c) => c.source === "auto")).toBe(true);
  });

  it("excludes build/dev/start/format scripts", async () => {
    await write(
      "package.json",
      JSON.stringify({
        scripts: {
          build: "tsup",
          dev: "vite",
          start: "node .",
          format: "biome format",
          test: "vitest",
        },
      }),
    );
    const checks = await detectRequiredChecks(dir);
    expect(cmds(checks)).toEqual(["npm test"]);
  });

  it("catches namespaced QA scripts like test:unit and lint:fix", async () => {
    await write(
      "package.json",
      JSON.stringify({ scripts: { "test:unit": "vitest", "lint:fix": "biome check --write" } }),
    );
    const checks = await detectRequiredChecks(dir);
    expect(cmds(checks)).toEqual(["npm run lint:fix", "npm run test:unit"]);
  });

  it("detects the Python toolchain from pyproject.toml", async () => {
    await write(
      "pyproject.toml",
      "[tool.pytest.ini_options]\n[tool.ruff]\n[tool.mypy]\nstrict = true\n",
    );
    const checks = await detectRequiredChecks(dir);
    expect(cmds(checks)).toEqual(["mypy", "pytest", "ruff check"]);
  });

  it("detects QA targets from a Makefile and ignores recipes/.PHONY", async () => {
    await write("Makefile", ".PHONY: test\ntest:\n\tpytest\nbuild:\n\ttsc\nlint:\n\truff check\n");
    const checks = await detectRequiredChecks(dir);
    expect(cmds(checks)).toEqual(["make lint", "make test"]);
  });

  it("deduplicates by cmd across manifests", async () => {
    await write("package.json", JSON.stringify({ scripts: { test: "vitest" } }));
    await write("Makefile", "test:\n\tpytest\n");
    const checks = await detectRequiredChecks(dir);
    // `npm test` and `make test` are distinct commands — both kept.
    expect(cmds(checks)).toEqual(["make test", "npm test"]);
  });

  it("excludes operational watch scripts even under a QA-looking head (tsc:watch)", async () => {
    await write(
      "package.json",
      JSON.stringify({ scripts: { "tsc:watch": "tsc -w", "lint:dev": "biome", typecheck: "tsc" } }),
    );
    const checks = await detectRequiredChecks(dir);
    expect(cmds(checks)).toEqual(["npm run typecheck"]);
  });

  it("detects every target on a multi-target Makefile line (test lint:)", async () => {
    await write("Makefile", "test lint:\n\tpytest && ruff check\nbuild:\n\ttsc\n");
    const checks = await detectRequiredChecks(dir);
    expect(cmds(checks)).toEqual(["make lint", "make test"]);
  });

  it("does not detect flake8 from pyproject.toml (it reads setup.cfg, not pyproject)", async () => {
    await write("pyproject.toml", "[tool.flake8]\nmax-line-length = 100\n");
    expect(await detectRequiredChecks(dir)).toEqual([]);
  });

  it("returns [] when no manifests exist (degrade, no throw)", async () => {
    expect(await detectRequiredChecks(dir)).toEqual([]);
  });

  it("degrades on invalid package.json without throwing", async () => {
    await write("package.json", "{ not valid json");
    expect(await detectRequiredChecks(dir)).toEqual([]);
  });
});
