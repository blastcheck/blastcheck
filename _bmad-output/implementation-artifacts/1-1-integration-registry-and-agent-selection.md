---
baseline_commit: 64866f6ad22e005bb297149b4b5ca77ff2d9f1d8
source_epics: /Users/v.talecky/Desktop/blastcheck/_bmad-output/planning-artifacts/epics.md
source_architecture: /Users/v.talecky/Desktop/blastcheck/_bmad-output/planning-artifacts/architecture.md
---

# Story 1.1: Integration Registry and Agent Selection

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a blastcheck user,
I want `blastcheck init --agent <agent>` to resolve supported integrations consistently,
so that I can choose the agent setup path without relying on agent-specific commands.

## Acceptance Criteria

**AC1 - Shared integration contract and registry**
**Given** the project supports `claude-code`, `codex`, `opencode`, and `github`
**When** the integration registry is queried
**Then** each supported agent is exposed through a shared `AgentIntegration` contract
**And** agent-specific code remains outside core checks, verdict, runner, scorecard, and `runAudit()`.

**AC2 - CLI routes selected agents through the registry**
**Given** a user runs `blastcheck init --agent claude-code`, `blastcheck init --agent codex`, `blastcheck init --agent opencode`, or `blastcheck init --agent github`
**When** the CLI parses the selected agent
**Then** it resolves the corresponding registry entry
**And** routes installation through the shared integration interface.

**AC3 - Unknown agent is a tool error with supported values**
**Given** a user runs `blastcheck init --agent unknown`
**When** the agent is not registered
**Then** the command exits with code `2`
**And** the user-facing output lists supported agent values on stderr.

**AC4 - Default init behavior is preserved**
**Given** a user runs `blastcheck init` without `--agent`
**When** the CLI applies existing default behavior
**Then** it preserves Claude Code install behavior
**And** does not require current users to learn a new command.

## Tasks / Subtasks

- [x] **Task 1 - Add integration type surface** (AC: 1)
  - [x] Create `src/integrations/types.ts`.
  - [x] Define `AgentId = "claude-code" | "codex" | "opencode" | "github"`.
  - [x] Define `AgentIntegration` with stable fields: `id`, `displayName`, `install(opts)`.
  - [x] Keep the type small; do not add status, manifest, uninstall, or doctor contracts in this story unless needed to route `init`.
- [x] **Task 2 - Add registry and supported-agent helpers** (AC: 1,2,3)
  - [x] Create `src/integrations/registry.ts`.
  - [x] Export ordered `SUPPORTED_AGENT_IDS`, `isAgentId(value)`, `getIntegration(id)`, and `supportedAgentsForMessage()`.
  - [x] Ensure unknown input is handled by the registry/CLI layer, not by throwing from an integration module.
  - [x] Add `src/integrations/registry.test.ts`: all four ids resolve; unknown id does not; supported list is deterministic.
- [x] **Task 3 - Move Claude Code init behind an integration module without changing behavior** (AC: 1,2,4)
  - [x] Create `src/integrations/claude-code.ts` that delegates to existing `runInit({ cwd })`.
  - [x] Keep `src/hooks/init.ts` as the implementation of the Claude Code config merge for now; do not rewrite its internals in this story.
  - [x] `blastcheck init` and `blastcheck init --agent claude-code` must both call the same Claude integration path and preserve current stderr/stdout behavior.
- [x] **Task 4 - Register planned integrations without fake successful installs** (AC: 1,2,3)
  - [x] Create minimal modules for `src/integrations/codex.ts`, `src/integrations/opencode.ts`, and `src/integrations/github.ts`.
  - [x] These entries must be resolvable by the registry so CLI routing is real.
  - [x] Until their dedicated stories implement installation, their `install()` should return/throw an explicit tool-error result with a concise stderr message such as `codex installer is not implemented yet; planned in Story 2.1`.
  - [x] Do not create `.codex/hooks.json`, `.opencode/plugins/blastcheck.ts`, GitHub config, or `.blastcheck/install.json` in Story 1.1.
- [x] **Task 5 - Add `--agent` CLI option for `init`** (AC: 2,3,4)
  - [x] Update `src/cli.ts` `init` command description from "Install Claude Code hooks" to installer-first language.
  - [x] Add `.option("--agent <agent>", ...)`.
  - [x] Default no-arg `blastcheck init` to `claude-code` to preserve existing behavior.
  - [x] Unknown agent: write a single clear error to stderr via `log("error", ...)` or Commander error handling, set exit code `EXIT.TOOL_ERROR`, and write nothing to stdout.
  - [x] Known-but-not-yet-implemented agents: route through the registry entry and exit `2` without creating files.
- [x] **Task 6 - Extend tests around CLI routing** (AC: 2,3,4)
  - [x] Update `src/cli.test.ts` mocks to mock the registry/integration path rather than only `runInit`.
  - [x] Add assertions for:
    - `blastcheck init` routes to `claude-code`.
    - `blastcheck init --agent claude-code` routes to `claude-code`.
    - `blastcheck init --agent unknown` exits `2`, calls no installer, and writes nothing to stdout.
    - `blastcheck init --agent codex` resolves a registry entry and exits `2` until Story 2.1 implements the installer.
  - [x] Keep existing `run`, `adapt`, and `hook` CLI tests green.
- [x] **Task 7 - Green verification** (AC: 1,2,3,4)
  - [x] Run `npm run typecheck`.
  - [x] Run `npm run lint`.
  - [x] Run `npm test`.
  - [x] Run `npm run build`.

### Review Findings

- [x] [Review][Patch] README documents the wrong Codex init shape [README.md:89]

## Dev Notes

### Current State

`blastcheck init` currently lives in `src/cli.ts` and calls `runInit()` from `src/hooks/init.ts` directly. `runInit()` only installs Claude Code hooks into `.claude/settings.json` and ensures `.blastcheck/` is gitignored. There is no `src/integrations/` directory, no `--agent` CLI option, and no `.blastcheck/install.json` manifest yet.

Do not treat the existing hook installer as disposable. It has working idempotency, config-preservation tests, and review fixes. Story 1.1 should wrap it behind the new integration seam; Story 1.3 will perform deeper Claude Code registry-backed installer work.

### Architecture Guardrails

- Keep `runAudit()` in `src/index.ts` untouched. This story is installer selection only; checks, verdicts, scorecard serialization, trajectory loading, and audit exit semantics remain agent-agnostic.
- Keep stdout clean. `init` diagnostics and errors go to stderr. `stdout` remains reserved for scorecard JSON except Commander help/version.
- Keep the dependency posture unchanged. Add no runtime dependency; current runtime deps are `commander`, `ignore`, `zod`, `yaml`.
- Use TypeScript strict patterns already in the repo: ESM imports with `.js`, `type` imports where applicable, no unchecked indexed access assumptions.
- Use external ids in kebab-case (`claude-code`, `opencode`) and internal TS names in camelCase/PascalCase.

### Recommended API Shape

Use a minimal contract that can grow later:

```ts
export type AgentId = "claude-code" | "codex" | "opencode" | "github";

export interface InstallOptions {
  cwd: string;
}

export interface InstallResult {
  agent: AgentId;
}

export interface AgentIntegration {
  id: AgentId;
  displayName: string;
  install(options: InstallOptions): Promise<InstallResult>;
}
```

`InstallResult` can stay intentionally small in Story 1.1. Manifest fields, evidence paths, trust state, config files touched, and status reporting belong to Story 1.2 / Story 1.4.

### Planned Integration Behavior

`claude-code` is the only integration that should perform a real install in this story. It delegates to `runInit()` and returns a successful result when the existing installer succeeds.

`codex`, `opencode`, and `github` must be registered so the CLI can route selected agents through the same interface, but they must not pretend to install anything yet. Return a controlled tool error for those ids until their implementation stories land:

- Codex install config: Story 2.1.
- OpenCode plugin install: Story 3.1.
- GitHub Action init/story work: deferred beyond this milestone; docs/status work later.

This prevents a user-visible lie where `blastcheck init --agent codex` exits `0` before `.codex/hooks.json` exists.

### Existing Files To Read Before Editing

- `src/cli.ts`: direct `runInit()` import and `init` command wiring. Preserve `Outcome` exit-code pattern and Commander's `exitOverride()` handling.
- `src/hooks/init.ts`: current Claude Code installer. Preserve JSON parsing, marker-based dedup, no-op no-rewrite behavior, and `.gitignore` idempotency.
- `src/hooks/init.test.ts`: existing installer coverage; these tests should remain meaningful.
- `src/cli.test.ts`: CLI output/exit-code contract. Extend it, do not weaken existing stdout assertions.
- `src/types.ts`: canonical `EXIT` values. Use `EXIT.TOOL_ERROR` for unsupported or not-yet-implemented install attempts.

### Test Expectations

Add focused tests; do not rely only on TypeScript compile-time guarantees.

- Registry unit tests should prove the exact supported ids and deterministic list order.
- CLI tests should assert stdout remains empty for `init`, unknown agent, and planned-but-unimplemented agents.
- Existing Claude Code init tests must still prove:
  - fresh install creates three hooks and `.gitignore`;
  - repeat install adds no duplicates and does not rewrite settings;
  - unrelated `.claude/settings.json` hooks and keys are preserved;
  - corrupt settings JSON degrades to fresh settings with warning.

### Previous Story Intelligence

- Story 3.1 created the current Claude Code hook installer and review fixed a no-op rewrite bug in `src/hooks/init.ts`. Do not regress no-op idempotency by moving code into `src/integrations/claude-code.ts`.
- Story 4.1 added `blastcheck adapt` and cross-agent trajectory adapters. Do not confuse manual `adapt --from codex` with the future Codex lifecycle installer; Story 1.1 is only registry/selection, not lifecycle hook capture.
- Recent commits show the established style: ESM `.js` imports, co-located Vitest tests, no new runtime dependencies, and explicit stderr/stdout separation.

### Latest Technical Information

- Local `package.json` currently pins `commander ^14.0.2`, `typescript ^5.9.3`, `vitest ^3.2.4`, `tsup ^8.5.0`, and Node `>=20`. Keep those versions for this story.
- npm registry check on 2026-06-18 shows `typescript` latest as `6.0.3`, but upgrading compiler/runtime tooling is out of scope for Story 1.1 and would add unrelated migration risk. Source: https://registry.npmjs.org/typescript/latest

### Project Structure Notes

Expected file changes:

```text
src/
  cli.ts                         # UPDATE: init --agent routing through registry
  cli.test.ts                    # UPDATE: init routing and error cases
  integrations/
    types.ts                     # NEW
    registry.ts                  # NEW
    registry.test.ts             # NEW
    claude-code.ts               # NEW: delegates to hooks/init.ts
    codex.ts                     # NEW: registered planned integration, controlled tool error
    opencode.ts                  # NEW: registered planned integration, controlled tool error
    github.ts                    # NEW: registered planned integration, controlled tool error
```

Avoid modifying:

```text
src/index.ts
src/runner.ts
src/checks/*
src/scorecard/*
src/trajectory/*
```

### References

- [Source: /Users/v.talecky/Desktop/blastcheck/_bmad-output/planning-artifacts/epics.md#Story 1.1] - story statement and ACs.
- [Source: /Users/v.talecky/Desktop/blastcheck/_bmad-output/planning-artifacts/epics.md#Requirements Inventory] - FR1, FR2, FR4, FR5, FR10, FR51, FR52, FR54, FR55.
- [Source: /Users/v.talecky/Desktop/blastcheck/_bmad-output/planning-artifacts/installer-first-integration-plan.md#Architecture] - recommended `src/integrations/*` layout and agent-specific boundary.
- [Source: /Users/v.talecky/Desktop/blastcheck/_bmad-output/planning-artifacts/architecture.md#Process Patterns] - stdout/stderr and exit-code rules.
- [Source: /Users/v.talecky/Desktop/blastcheck/src/cli.ts] - current direct init wiring and exit-code pattern.
- [Source: /Users/v.talecky/Desktop/blastcheck/src/hooks/init.ts] - existing Claude Code installer implementation to wrap, not rewrite.
- [Source: /Users/v.talecky/Desktop/blastcheck/_bmad-output/implementation-artifacts/3-1-blastcheck-init-ustanovshchik-claude-code-hukov.md#Review Findings] - idempotency and deferred hook hardening context.

## Decisions / Assumptions

- `blastcheck init` with no `--agent` defaults to `claude-code` in this story to preserve current behavior.
- `codex`, `opencode`, and `github` are registry-supported but installation-pending in this story; they should fail explicitly with exit `2`, not silently succeed.
- `.blastcheck/install.json` is intentionally deferred to Story 1.2.
- `blastcheck status` is intentionally deferred to Story 1.4.
- Sprint status was not updated because the current `/Users/v.talecky/Desktop/blastcheck/_bmad-output/implementation-artifacts/sprint-status.yaml` tracks the previous completed epics and has no key matching `1-1-integration-registry-and-agent-selection`.

## Story Completion Status

Ultimate context engine analysis completed - comprehensive developer guide created. Story is ready for dev.

## Dev Agent Record

### Agent Model Used

GPT-5 Codex (BMad dev-story workflow)

### Debug Log References

- `npm test -- src/integrations/registry.test.ts` -> red first: missing `./registry.js`.
- `npm test -- src/cli.test.ts` -> red first for new init routing tests against direct `runInit()` wiring.
- `npm test -- src/cli.test.ts src/integrations/registry.test.ts` -> 26 passed.
- `npm run typecheck` -> passed.
- `npm test -- src/integrations src/cli.test.ts src/hooks/init.test.ts` -> 35 passed.
- `npm run lint` -> passed; Biome checked 91 files.
- `npm test` -> passed; 38 test files, 278 tests.
- `npm run build` -> passed; ESM/CJS/DTS artifacts generated.

### Completion Notes List

- Added the shared integration contract in `src/integrations/types.ts` with minimal `AgentId`, `InstallOptions`, `InstallResult`, and `AgentIntegration` surface.
- Added a deterministic registry for `claude-code`, `codex`, `opencode`, and `github`, including supported-id helpers and deterministic user-facing supported-agent text.
- Wrapped the existing Claude Code hook installer behind `claudeCodeIntegration`; `src/hooks/init.ts` internals were not modified.
- Registered planned `codex`, `opencode`, and `github` integrations as resolvable entries that fail explicitly instead of pretending to install.
- Updated `blastcheck init` to accept `--agent`, default to `claude-code`, route known agents through the registry, and report unknown agents as tool errors with no stdout.
- Extended CLI and integration tests for registry resolution, default init routing, explicit Claude routing, unknown agents, planned-agent failures, and Claude installer delegation.
- Verified no changes were made to `runAudit()`, checks, runner, scorecard, or trajectory modules.

### File List

- `src/cli.ts`
- `src/cli.test.ts`
- `src/integrations/types.ts`
- `src/integrations/registry.ts`
- `src/integrations/registry.test.ts`
- `src/integrations/claude-code.ts`
- `src/integrations/claude-code.test.ts`
- `src/integrations/codex.ts`
- `src/integrations/opencode.ts`
- `src/integrations/github.ts`
- `src/integrations/planned.test.ts`
- `_bmad-output/implementation-artifacts/1-1-integration-registry-and-agent-selection.md`

### Change Log

- 2026-06-18: Implemented integration registry and agent-selected init routing; status set to review after full verification.
