# blastcheck

Audit AI coding-agent changes against a contract — git-only and trajectory checks.

`blastcheck` inspects what an AI coding agent actually changed (the git diff and,
later, its execution trajectory) and grades it against a declared contract: which
files may be touched, how much churn is acceptable, whether required checks ran,
and more. The verdict is a machine-readable scorecard plus a process exit code,
so it slots into pre-commit hooks and CI gates.

> **Status: early.** This is the foundation (Story 1.1) — scaffold, canonical
> types, path normalization, `ignore`-based matching, and the git adapter. The
> six checks and the audit runner land in subsequent stories, so `blastcheck`
> does not yet produce a real verdict (`runAudit` is a stub).

## Planned checks

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
blastcheck --contract <path>
```

`stdout` is reserved for the `scorecard.json`; all diagnostics go to `stderr`.

### Exit codes

| Code | Meaning                                            |
| ---- | -------------------------------------------------- |
| `0`  | Audit passed                                       |
| `1`  | Verdict / gate failed                              |
| `2`  | Tool error (e.g. no git repo, unreadable baseline) — **not** an audit failure |

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
