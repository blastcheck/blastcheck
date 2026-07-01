# blastcheck

Audit AI coding-agent changes against a contract — git-only and trajectory checks.

`blastcheck` inspects what an AI coding agent actually changed (the git diff and,
optionally, its execution trajectory) and grades it against a declared contract:
which files may be touched, how much churn is acceptable, whether required checks
ran, and more. The verdict is a machine-readable scorecard plus a process exit
code, so it slots into hooks and CI gates.

> **Status: v1 implemented for local use and CI.** The git-only checks, trajectory
> checks, audit runner, `scorecard.json` output, one-command agent installers
> (Claude Code, Codex, OpenCode), cross-agent trajectory adapters, and composite
> GitHub Action are implemented. Setup is installer-first — see **Quick start**
> below.

## Quick start

Setup is **installer-first**: you install blastcheck into your agent once, then
work normally inside that agent. The installed hooks/plugin capture the
trajectory and run the audit automatically at the end of each session — there is
no per-change audit command to remember.

**1. Choose your agent and install once.**

```bash
blastcheck init --agent claude-code   # writes .claude/settings.json hooks
blastcheck init --agent codex         # writes .codex/hooks.json
blastcheck init --agent opencode      # writes .opencode/plugins/blastcheck.ts
```

Each command installs that agent's hooks/plugin; the Claude Code installer also
adds `.blastcheck/` to your `.gitignore`. Bare `blastcheck init` (no `--agent`)
keeps the Claude Code default. Codex additionally asks you to trust the installed
hooks via its `/hooks` review before they run.

**2. Work normally in your agent.** Make changes through Claude Code, Codex, or
OpenCode as you usually would. The installed hooks/plugin capture the trajectory
and run the audit at session end — you don't invoke an audit command per change.
At the end of each turn the verdict is **pushed to you natively**: a brief line
(or toast) on every result, quiet on `pass`, plus a desktop alert on `warn`/`fail`
(exact gating varies per agent). You no longer have to remember to check — see
[Verdict surfacing](#verdict-surfacing).

**3. Check readiness any time.** (The pull signal, still here alongside the push
signal above.)

```bash
blastcheck status
```

`status` reports the installed integrations, captured evidence, and readiness on
**stderr** (stdout stays reserved for scorecard JSON). It is read-only and always
exits `0`.

To read the **last verdict itself** (instead of `cat`-ing the JSON), use:

```bash
blastcheck show
```

`show` renders the latest `.blastcheck/scorecard.json` in the same human-readable
form as the end-of-turn summary, but to **stdout** — it is a *pull* command, so its
render is the payload. With no scorecard yet (or an unreadable one) it prints a
short notice to stderr and still exits `0`; it never crashes.

When an agent session ends, the `Stop`/idle hook runs the audit and emits a
**scorecard**. The latest scorecard is persisted at **`.blastcheck/scorecard.json`**
— the on-disk evidence of the most recent run, and the same file
`blastcheck status` and `blastcheck show` surface.

## Checks

| Check                   | Class      |
| ----------------------- | ---------- |
| `denied-files`          | git-only (gate) |
| `scope-adhesion`        | git-only   |
| `churn`                 | git-only   |
| `extraneous-tool-calls` | trajectory |
| `required-checks`       | trajectory |
| `loop-detection`        | trajectory |

## Requirements

- Node.js >= 20 (developed on Node 22 LTS)
- A system `git` on `PATH`
- A POSIX-like shell (bash/zsh) for the git shell-outs.

## Install & build

```bash
npm install
npm run build      # tsup → dist/cli.js + dist/index.js (ESM + CJS + .d.ts)
```

## Usage

```bash
node dist/cli.js --help
node dist/cli.js --version
```

Once installed (`npm i -g` / via the `blastcheck` bin), the CLI is invoked as:

```bash
# Audit the working tree against a pre-run baseline commit (git-only).
blastcheck run --baseline <sha>

# Also mirror the scorecard to a file and render the PR-comment markdown.
blastcheck run --baseline <sha> --out scorecard.json --comment comment.md

# Include an agent trajectory (enables the trajectory checks).
blastcheck run --baseline <sha> --trajectory trace.jsonl

# Install blastcheck into your agent (installer-first setup — see Quick start).
# Bare `init` defaults to Claude Code; use `--agent codex|opencode` for others.
blastcheck init

# Render the last scorecard in human-readable form (to stdout — a pull command).
blastcheck show
```

`stdout` is reserved for the `scorecard.json`; all diagnostics (and the
human-readable summary) go to `stderr`. `--out` and `--comment` are optional side
channels — a write failure on either is logged but never changes the exit code.

## Contract

The audit compares the change against a **contract** assembled from three trust
sources, each owning different fields. Every source is optional — missing or
invalid input degrades to safe defaults (with a warning), never an error.

| Source | Owns | Trust model |
| ------ | ---- | ----------- |
| `task.md` (read from the **baseline** commit) | `allow` (in-scope paths) and `goal` | Pinned to the baseline via `git show <baseline>:task.md`. HEAD is never consulted, so the agent cannot rewrite its own promise after the fact. |
| `.blastcheck.yml` (working tree, optional) | `deny`, `budget`, `thresholds`, `required_checks`, `surfacing` | The human's optional override layer. |
| Repo manifests (`package.json`, `pyproject.toml`, `Makefile`) | autodetected `required_checks` | Auto-detected QA scripts (`test`/`lint`/`typecheck`) become **soft** gates; a `.blastcheck.yml` entry upgrades a check to a **hard** gate. |

**Scope lives in `task.md`, not `.blastcheck.yml`.** Declare it as YAML
frontmatter, committed *before* the agent runs (the resolver reads it from the
baseline commit):

```markdown
---
goal: Add a --quiet flag to the run command
allow:
  - "src/**"
  - "README.md"
---

# Task

Free-form task description below the frontmatter.
```

With no `task.md` frontmatter, `allow` is empty — every changed file is reported
as out-of-scope (a penalized-but-valid "no pre-commitment" state, not a failure).

The optional override file (note the **leading dot**):

```yaml
# .blastcheck.yml
deny:
  - "**/*.env"
budget:
  max_files_changed: 20
  max_churn_pct: 15
required_checks:
  - "npm test"
surfacing:
  feedback: false # inject the verdict back to the agent on warn/fail (opt-in)
  block: false    # hard-block a fail — Codex only, opt-in (no-op on Claude Code/OpenCode)
```

Both `surfacing` flags default `false`; they tune the end-of-turn egress layer,
never the verdict itself. See
[Feedback and blocking (opt-in)](#feedback-and-blocking-opt-in) for what they do,
the env-var overrides, and the OpenCode no-op caveat.

## Verdict surfacing

At the end of every turn the audit doesn't just write a file — it **pushes the
verdict to you in your agent's own idiom**. The picture:

- **`pass` is quiet:** one brief confirmation line — no desktop alert, no feedback.
- **`warn` shows a visible line** (a toast in OpenCode); on Claude Code and Codex
  it's paired with a desktop alert too (see the render-gap note below) — OpenCode
  stays visible-line-only on `warn`.
- **`fail` is impossible to miss:** the visible line **plus** a desktop alert (on
  macOS/Linux; on other platforms the alert degrades quietly and the visible line
  still shows).

**Render-gap note (2026-07-01):** on Claude Code, whether the visible line
actually renders in the chat turned out to depend on the *client*
(`claude-desktop` vs the `cli` terminal), not just the installed version — the
`systemMessage`/`terminalSequence` hook-JSON fields are consumed by Claude Code's
engine reliably, but `entrypoint: claude-desktop` was empirically observed to render
neither one visibly ([`hook_system_message` renders as nothing in the Desktop chat
UI](https://github.com/anthropics/claude-code/issues/50542)). Codex has the same
class of gap on its own Desktop client
([openai/codex#23319](https://github.com/openai/codex/issues/23319)). Because of
that, both agents now fire the same OS-level `desktopAlert` (`osascript`/
`notify-send`) on **every non-`pass` verdict** — `warn` included, not gated to a
gate-fail/fail the way `terminalSequence`/the old Codex `notify` gating were —
since it's the one channel that doesn't depend on either agent's own chat-UI
rendering at all. OpenCode has not (yet) had this specific render-gap
investigation run against it, so it keeps its original `fail`-only gating. See
`_bmad-output/implementation-artifacts/1-1-spike-systemmessage-stop-contract.md`
for the full evidence chain.

This is the **push** signal — you no longer have to remember to run `blastcheck
status` or open the scorecard. The **pull** signals still exist for when you want
to inspect a run: `status` (readiness, stderr, exits `0`), `show` (the last
verdict rendered to stdout), and the persisted `.blastcheck/scorecard.json` itself.

**The scorecard stays the source of truth.** It is written to
`.blastcheck/scorecard.json` **before** any surfacing happens — surfacing is a
presentation layer on top of that file, never a replacement for it. No history
database is introduced; each run overwrites the one scorecard, and every channel
degrades quietly if it isn't available.

The visible line is one of five deterministic forms, built only from safe
enum/number scorecard fields — never raw finding text (the glyph signals the
verdict; `fail-gate` is upper-cased for scannability, everything else stays
calm/lower-case):

```text
blastcheck: ✓ pass — 3 files changed, scope ok   (clean)
blastcheck: ✓ pass — no changes this session      (empty)
blastcheck: ‼ warn — 2 findings                   (warn)
blastcheck: ✗ FAIL — scope-adhesion failed; 1 finding
run `blastcheck show` for details                  (fail-gate: a hard gate failed)
blastcheck: fail — scope_adherence below floor    (fail-floor: score-driven, calm)
```

Claude Code's `systemMessage` gains that second `run \`blastcheck show\` for
details` line only on a **fail-gate** verdict, pointing at the detail `show`
already surfaces — Codex/OpenCode stay single-line.

### Per-agent behavior

The verdict is the same everywhere; only the **channel** differs per agent (these
mechanism names match the installed hooks/plugin — cross-reference the
[Agent integration status](#agent-integration-status) matrix for setup):

| Channel | Claude Code | Codex | OpenCode |
| ------- | ----------- | ----- | -------- |
| Visible line on **every** verdict (brief on `pass`) | `systemMessage` (render not guaranteed on every client — see render-gap note above) | `systemMessage` (same render-not-guaranteed caveat — Codex Desktop has its own open bug, [openai/codex#23319](https://github.com/openai/codex/issues/23319)) | TUI toast (`client.tui.showToast`) |
| Desktop alert on **non-`pass`** (`warn` and `fail`) | `terminalSequence` (OSC 9 + terminal bell, gate-fail only) **plus** `osascript`/`notify-send` (`desktopAlert`, every `warn`/`fail`) | `notify-send`/`osascript`, **`warn` and `fail`** (widened 2026-07-01 for the same reason as Claude Code), via user-level `notify` → `blastcheck notify codex` — note `notify` itself has documented reliability gaps on Windows/WSL2 ([openai/codex#8929](https://github.com/openai/codex/issues/8929)) | `osascript`/`notify-send`, **`fail` only**, fired CLI-side |
| Opt-in **feedback** (`warn`/`fail` only, never `pass`) | `hookSpecificOutput.additionalContext` | `hookSpecificOutput.additionalContext` | `client.session.prompt` |
| Opt-in hard **block** (`fail` only) | **not implemented (no-op — removed, single-channel design)** | `decision: "block"` | **not implemented (no-op in v1)** |

The visible line and feedback travel in the hook's stdout JSON on a clean exit
`0` (Claude Code / Codex) — the exit code is never used to carry the verdict.
Hard block only exists on Codex today; Claude Code surfaces a `fail` via the
visible line + desktop alert only, never a model-mediated block/continuation.
The Codex `fail` alert is the one exception that rides a separate channel; see
[Codex](#codex) for why and how to set it up.

### Feedback and blocking (opt-in)

Two optional behaviors widen surfacing beyond the visible line. **Both are opt-in
and default OFF**, and both only ever fire on `warn`/`fail` — **never on `pass`**:

| Flag | `.blastcheck.yml` | Env override (wins over the file) |
| ---- | ----------------- | --------------------------------- |
| `feedback` | `surfacing: { feedback: true }` | `BLASTCHECK_FEEDBACK` |
| `block` | `surfacing: { block: true }` | `BLASTCHECK_BLOCK` |

The env var wins over the file, so a one-off run can override the persistent
choice. Truthy tokens are `1` / `true` / `yes` / `on`; falsy tokens are `0` /
`false` / `no` / `off`.

- **Feedback** injects the verdict detail back into the agent's own context
  (Claude Code / Codex `additionalContext`; OpenCode a follow-up
  `session.prompt`) so the agent can act on it. **Caveat — the feedback loop:** an
  injected prompt can start a new turn → which re-runs the audit → which can feed
  the still-failing verdict back again. This is exactly why feedback is
  opt-in/default-OFF; it converges naturally once the agent fixes the issue.
- **Block** turns a `fail` into a hard stop (Codex `decision: "block"` + a
  reason). It is meant for CI-style gating and is off by default so a normal
  local session is never blocked. **Claude Code and OpenCode do not implement
  the hard block — `block` is a no-op on both** (Claude Code removed it in
  favor of a single always-visible `systemMessage` channel; no parity across
  agents is implied).

## Agent integration status

This matrix shows, per integration, **how you set it up** (setup maturity) and
**what evidence the audit can capture** (evidence level). Evidence values use the
same vocabulary as `blastcheck status`, so a row maps directly to live output —
see [Evidence levels](#evidence-levels) below.

| Integration | Setup (maturity) | Evidence level | Caveat / next action |
| ----------- | ---------------- | -------------- | -------------------- |
| **Claude Code** | `blastcheck init` (or `--agent claude-code`) → `.claude/settings.json` hooks (`SessionStart`/`PostToolUse`/`Stop`); trust auto-`trusted`. | **`full`** (trajectory-rich) once a session runs. | `—` — run a session to capture a trajectory (`pending` until then). |
| **Codex** | `blastcheck init --agent codex` → `.codex/hooks.json` (same three lifecycle events); trust `needs-review`. | **`pending`** → trajectory-rich once trusted + run. | **review hooks in Codex `/hooks`** — installed ≠ ready: the hooks don't run until you complete Codex's one-time `/hooks` trust review (see [Codex](#codex)). |
| **OpenCode** | `blastcheck init --agent opencode` → `.opencode/plugins/blastcheck.ts` (auto-loaded; trust `trusted`). | **`pending`** → trajectory-rich once the runtime is verified + a session runs. | install/run OpenCode so its runtime resolves on `PATH` — `status` shows `runtime: verified` / `not verified`. |
| **GitHub** | Composite **Action** in a PR workflow (see [GitHub Action](#github-action)). **Not** `init --agent github` — that command is unimplemented and errors. | **`git-only`** — diff only, no trajectory captured. | trajectory checks are reported `skipped`, never fabricated; branch-protect the check to block merge. |
| **Cursor / Aider** | **Adapter-only — no installer.** Import a log with `blastcheck adapt --from cursor\|aider <log>`, then `run`. | **`full`** (trajectory-rich) **only after** importing a log; `absent` otherwise. | one-off / import path — there is no Cursor or Aider installer. |

### Evidence levels

`blastcheck status` reports each integration's evidence using four states. The
**git-only vs trajectory-rich** distinction maps directly onto the
[Checks](#checks) `Class` column — git-only checks need only the diff, while
trajectory checks need a captured execution trajectory.

- **`full` (trajectory-rich)** — the diff **and** a captured trajectory are present, so all six checks run (the three git-only checks *and* the three trajectory checks).
- **`git-only`** — only the diff is available, so the three git-only checks (`denied-files`, `scope-adhesion`, `churn`) run and the three trajectory checks (`extraneous-tool-calls`, `required-checks`, `loop-detection`) are reported **`skipped`** — honestly marked, never fabricated (the scorecard records `evidence_level.trajectory: absent`). This is what the GitHub Action produces.
- **`pending`** — installed, but no evidence captured yet (Codex before its `/hooks` trust review and first session; OpenCode before its runtime is verified and a session runs).
- **`absent`** — nothing installed or captured.

### Codex

Codex is installer-first — the same install-once-then-work-normally model as
Claude Code. Install the lifecycle hooks once:

```bash
blastcheck init --agent codex   # writes .codex/hooks.json
```

This writes project-local `.codex/hooks.json` with three lifecycle commands —
`SessionStart`, `PostToolUse`, and `Stop` — that capture the trajectory as you
work and run the audit at session end, mirroring the latest scorecard to
`.blastcheck/scorecard.json`. You then work normally in Codex; there is no
per-change audit command to remember.

Codex requires you to review and trust the installed command hooks via its
`/hooks` review before they run — `blastcheck status` surfaces this as a pending
**review hooks in Codex `/hooks`** action until you do.

#### Desktop alert (user-level `notify`)

The Codex visible verdict line rides the hooks above, but the **desktop alert**
travels a different channel: a project-local `.codex/config.toml` **ignores**
Codex's `notify` setting, so blastcheck writes the **user-level**
`~/.codex/config.toml` instead. As part of `init --agent codex` it adds, idempotently:

```toml
notify = ["blastcheck", "notify", "codex"]
```

This points Codex's turn-complete `notify` program at `blastcheck notify codex`,
which raises a desktop notification on a `warn` or `fail` verdict (silent no-op on
`pass`). Widened from `fail`-only on 2026-07-01: Codex's own `systemMessage`
inherits the same "engine accepts it, some client silently drops it" risk profile
as Claude Code's (Codex Desktop has its own open bug,
[openai/codex#23319](https://github.com/openai/codex/issues/23319)), so `warn`
needs the same OS-level fallback `fail` already had.

- **If a different user-level `notify` already exists**, blastcheck **leaves it
  untouched** and prints a manual step instead — point `notify` at
  `["blastcheck", "notify", "codex"]` yourself. Codex's `notify` is a single
  program, so to keep your existing one you'd wrap both behind a small script that
  calls each in turn. Single-command install is
  preserved where it can be, with an explicit fallback where it can't.
- **Migration:** existing Codex installs from before the surfacing layer must
  **re-run `blastcheck init --agent codex`** once to pick up this user-level
  `notify` line. This does **not** require a Codex `/hooks` re-trust — the hook
  *definitions* are unchanged; only the user-level config file gains a line.
  (Changing a hook *definition* would force a re-trust; the reporter touched none.)

#### Importing an existing Codex log (fallback)

If you already have a Codex rollout/log — for a one-off audit, or for CI where the
hooks aren't installed — convert it to the common trajectory with `adapt`. This is
**not** the main path; the lifecycle-hooks installer above is the recommended Codex
setup.

```bash
blastcheck adapt --from codex codex-rollout.jsonl > trajectory.jsonl
blastcheck run --baseline <sha> --trajectory trajectory.jsonl
```

`adapt` writes the common trajectory JSONL to **stdout** (diagnostics go to
stderr). Cursor and Aider logs are imported the same way
(`adapt --from cursor|aider`).

### Exit codes

| Code | Meaning                                            |
| ---- | -------------------------------------------------- |
| `0`  | Audit passed                                       |
| `1`  | Verdict / gate failed                              |
| `2`  | Tool error (e.g. no git repo, unreadable baseline) — **not** an audit failure |

## GitHub Action

`blastcheck` ships a composite Action that gates pull requests: it audits the PR
in git-only mode, posts the scorecard as a PR comment, and fails the check on a
`fail` verdict (or tool error). With branch protection on the check, a failed
audit blocks merge.

The Action runs the **same shared audit core** as the local installers — it
shells out to the single public `blastcheck` audit path (the built CLI), so a PR
is graded by the identical engine, not a separate CI implementation. The only
difference is the evidence level: the Action runs **git-only**, so the three
trajectory checks are reported `skipped` (see [Evidence levels](#evidence-levels)).

Consumer workflow:

```yaml
name: blastcheck
on: pull_request
permissions:
  contents: read         # checkout
  pull-requests: write   # upsert the scorecard comment
jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # REQUIRED: merge-base + `git show <baseline>:task.md`
          ref: ${{ github.event.pull_request.head.sha }}
      - uses: <owner>/blastcheck@<ref>
        # with:               # all inputs are optional
        #   baseline: ""             # default: git merge-base <base> <head>
        #   working-directory: "."   # where to run the audit
        #   comment: "true"          # upsert the scorecard PR comment
        #   fail-on-verdict: "true"  # exit 1/2 fails the check (block merge)
```

### Inputs

| Input               | Default | Meaning                                                              |
| ------------------- | ------- | ------------------------------------------------------------------- |
| `baseline`          | `""`    | Commit to audit against. Empty → `git merge-base <base> <head>`.    |
| `working-directory` | `"."`   | Directory to run the audit in (the checked-out PR head).            |
| `comment`           | `"true"`| Upsert the scorecard as a single PR comment.                        |
| `fail-on-verdict`   | `"true"`| Propagate the binary's exit code (1/2) as a failed check.           |

### Behavior

- **Exit codes / merge blocking.** The Action posts the comment *before* gating,
  then exits with the binary's code: `0` for `pass`/`warn` (warn never blocks),
  `1` for `fail`, `2` for a tool error. Add the check to branch protection to
  block merge on a red result. Set `fail-on-verdict: false` for report-only runs.
- **Idempotent comment.** The scorecard comment carries a hidden marker
  (`<!-- blastcheck-scorecard -->`); repeated runs edit that one comment instead
  of piling up new ones.
- **Baseline = merge-base.** The diff far-baseline and the `task.md`/`allow`
  pinning point. If `task.md` isn't present on the merge-base, the contract
  resolver degrades to `allow: []` honestly — the Action does not fail for that.
  Override with the `baseline` input if your repo pins the contract elsewhere.
- **Fork PRs.** `GITHUB_TOKEN` is read-only on PRs from forks, so the comment
  upsert can't write — the Action logs a warning and continues (it does **not**
  switch to `pull_request_target`, which would be unsafe with untrusted code).
- **`fetch-depth: 0` is required.** A shallow clone makes `merge-base` and
  `git show <baseline>:task.md` fail, surfacing as exit `2` (a red check from
  infrastructure, not the verdict).

### Deferred

CI `init`/story-bootstrap is **deferred beyond this milestone** — *planned, not
abandoned*. There is **no working `blastcheck init --agent github`**: the `github` agent
id is registered (it appears in `init --help`), but its installer is unimplemented
and errors with `github installer is not implemented yet; planned after this
milestone`. Consume the Action as a composite Action in a workflow (above), not
via `init`.

Manual **`adapt` remains available, but is not the primary setup path.**
`blastcheck adapt --from <agent> <log>` is the import/fallback for agents without
a native installer — the Codex fallback (see [Codex](#codex)) and Cursor/Aider
(see the [integration matrix](#agent-integration-status)). Installer-first `init`
is the main product path.

## Non-goals (this milestone)

What the installer-first milestone deliberately does **not** ship. These are
*this-milestone* boundaries, not permanent bans:

- **No daemon / long-running service.** `blastcheck` is a one-shot CLI invoked by
  hooks/CI; it opens no socket and runs no background service (NFR10, enforced by
  `src/contracts.test.ts`).
- **No database / persistent history store.** The tool is stateless: it audits
  from a supplied trajectory + baseline and writes a single
  `.blastcheck/scorecard.json`, keeping no historical database (NFR3, NFR11).
- **No MCP-first enforcement.** Enforcement is hook/CLI/CI-driven; MCP is not the
  primary enforcement path for this milestone (NFR12).
- **No rollout-log scraping as the primary Codex UX.** Codex is lifecycle-hooks
  first (`init --agent codex`); `adapt --from codex` on a rollout log is the
  fallback, not the main path (NFR13; see [Codex](#codex)).
- **No VS Code / Cursor extension packaging.** There is no editor-extension
  distribution this milestone; Cursor/Aider are reached via `adapt` import only
  (NFR14; see the [integration matrix](#agent-integration-status)).

## Development

```bash
npm test        # vitest (co-located *.test.ts)
npm run typecheck
npm run lint     # biome check
npm run lint:fix # biome check --write
```

## Architecture notes

- **Runtime dependencies are exactly four** — `commander`, `ignore`, `zod`,
  `yaml` — and that is a hard invariant.
- Glob matching uses the `ignore` library (gitignore spec) only; no hand-rolled
  regex matcher.
- The single public API is `runAudit(input)` from `src/index.ts`; the CLI is a
  thin wrapper over it.
