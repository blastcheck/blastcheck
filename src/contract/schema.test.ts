import { describe, expect, it } from "vitest";
import { blastcheckYmlSchema, taskMdSchema } from "./schema.js";

describe("taskMdSchema", () => {
  it("reads goal and allow from frontmatter", () => {
    const parsed = taskMdSchema.parse({ goal: "do x", allow: ["src/**", "tests/**"] });
    expect(parsed.goal).toBe("do x");
    expect(parsed.allow).toEqual(["src/**", "tests/**"]);
  });

  it("degrades an absent allow to [] and absent goal to null (no throw)", () => {
    const parsed = taskMdSchema.parse({});
    expect(parsed.allow).toEqual([]);
    expect(parsed.goal).toBeNull();
  });

  it("ignores unknown frontmatter keys", () => {
    const parsed = taskMdSchema.parse({ goal: "g", priority: "high" });
    expect(parsed.goal).toBe("g");
  });

  it("rejects a wrongly-typed allow via safeParse (caller degrades)", () => {
    const result = taskMdSchema.safeParse({ allow: "src/**" });
    expect(result.success).toBe(false);
  });
});

describe("blastcheckYmlSchema", () => {
  it("maps snake_case external keys to camelCase budget fields", () => {
    const parsed = blastcheckYmlSchema.parse({
      budget: { max_tool_calls: 40, max_files_changed: 6, max_churn_pct: 8 },
    });
    expect(parsed.budget).toEqual({ maxToolCalls: 40, maxFilesChanged: 6, maxChurnPct: 8 });
  });

  it("maps snake_case threshold score keys to camelCase", () => {
    const parsed = blastcheckYmlSchema.parse({
      thresholds: { scope_adherence: 0.85, churn_discipline: 0.4 },
    });
    expect(parsed.thresholds).toEqual({ scopeAdherence: 0.85, churnDiscipline: 0.4 });
  });

  it("passes required_checks through as a string list", () => {
    const parsed = blastcheckYmlSchema.parse({ required_checks: ["npm test", "make lint"] });
    expect(parsed.requiredChecks).toEqual(["npm test", "make lint"]);
  });

  it("leaves every field undefined for an empty file", () => {
    const parsed = blastcheckYmlSchema.parse({});
    expect(parsed.deny).toBeUndefined();
    expect(parsed.budget).toBeUndefined();
    expect(parsed.thresholds).toBeUndefined();
    expect(parsed.requiredChecks).toBeUndefined();
  });

  it("rejects a wrongly-typed budget via safeParse", () => {
    const result = blastcheckYmlSchema.safeParse({ budget: { max_tool_calls: "lots" } });
    expect(result.success).toBe(false);
  });

  it("rejects an out-of-range (negative / zero) budget", () => {
    expect(blastcheckYmlSchema.safeParse({ budget: { max_tool_calls: -1 } }).success).toBe(false);
    expect(blastcheckYmlSchema.safeParse({ budget: { max_files_changed: 0 } }).success).toBe(false);
    expect(blastcheckYmlSchema.safeParse({ budget: { max_tool_calls: 1.5 } }).success).toBe(false);
  });

  it("rejects a threshold value outside [0, 1]", () => {
    expect(blastcheckYmlSchema.safeParse({ thresholds: { scope_adherence: 5 } }).success).toBe(
      false,
    );
    expect(blastcheckYmlSchema.safeParse({ thresholds: { scope_adherence: -1 } }).success).toBe(
      false,
    );
  });

  it("drops empty / whitespace-only required_checks entries", () => {
    const parsed = blastcheckYmlSchema.parse({
      required_checks: ["npm test", "", "  ", " make lint "],
    });
    expect(parsed.requiredChecks).toEqual(["npm test", "make lint"]);
  });
});
