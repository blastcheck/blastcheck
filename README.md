# blastcheck

Audit AI coding-agent changes against a contract — git-only and trajectory checks.

`blastcheck` inspects what an AI coding agent actually changed (the git diff and,
optionally, its execution trajectory) and grades it against a declared contract:
which files may be touched, how much churn is acceptable, whether required checks
ran, and more. The verdict is a machine-readable scorecard plus a process exit
code, so it slots into hooks and CI gates.

> **Status: v1 implemented for local use and CI.** The git-only checks, trajectory
> checks, audit runner, `scorecard.json` output, Claude Code hooks installer,
> cross-agent trajectory adapters, and composite GitHub Action are implemented.
> The main remaining integration gap is a one-command Codex installer: Codex logs
> can be adapted and audited today, but `blastcheck init` does not yet install
> Codex-specific hooks or automatically discover Codex rollout files.

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

# Install the Claude Code hooks (trajectory capture + audit on Stop).
blastcheck init
```

`stdout` is reserved for the `scorecard.json`; all diagnostics (and the
human-readable summary) go to `stderr`. `--out` and `--comment` are optional side
channels — a write failure on either is logged but never changes the exit code.

## Agent integration status

| Agent / surface | Status | How to use it |
| --------------- | ------ | ------------- |
| Claude Code | Plug-and-play local hooks | `blastcheck init` installs `SessionStart`, `PostToolUse`, and `Stop` hooks for trajectory capture and audit. |
| GitHub Actions | Plug-and-play CI gate | Use the composite Action from this repository in a PR workflow. |
| Codex | Adapter ready, installer missing | Convert a Codex rollout/log with `blastcheck adapt --from codex <log>`, then pass the output to `blastcheck run --trajectory`. |
| Cursor | Adapter ready, installer missing | Convert a Cursor stream/log with `blastcheck adapt --from cursor <log>`, then audit the generated trajectory. |
| Aider | Adapter ready, installer missing | Convert `.aider.chat.history.md` with `blastcheck adapt --from aider <log>`, then audit the generated trajectory. |

### Codex today

Codex support is available as a log adapter, not as a BMad-style one-command
installation. The current flow is:

```bash
blastcheck adapt --from codex codex-rollout.jsonl > trajectory.jsonl
blastcheck run --baseline <sha> --trajectory trajectory.jsonl
```

That enables the same trajectory checks as other agents once you have the Codex
log file. What is not implemented yet: `blastcheck init --agent codex` or equivalent
setup that wires blastcheck directly into Codex, finds the active rollout file,
captures a baseline, and runs the audit automatically at the end of a Codex
session.

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
