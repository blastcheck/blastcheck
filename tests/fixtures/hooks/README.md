# Codex lifecycle hook stdin fixtures (FR31)

These are **Codex lifecycle-hook stdin payloads** — a single JSON object delivered
on stdin to the `.codex/hooks.json` command handlers (`blastcheck hook codex
<name>`), exactly as `src/hooks/*` consume them. They are the contract the
`codex-lifecycle` adapter (`src/trajectory/adapters/codex-lifecycle.ts`) and the
Codex hook handlers are tested against.

| File | Event | Covers |
|------|-------|--------|
| `codex-session-start.sample.json` | `SessionStart` | `source:"startup"` reset semantics |
| `codex-post-tool-use.sample.json` | `PostToolUse` | exec/`shell` tool → canonical `cmd` (argv `["bash","-lc",…]` unwrap) |
| `codex-post-tool-use-apply-patch.sample.json` | `PostToolUse` | `apply_patch` body → canonical `path` |
| `codex-stop.sample.json` | `Stop` | `stop_hook_active`, `last_assistant_message` |

## OpenCode `tool.execute.after` fixtures (Story 3.2, FR33/FR34/FR38)

Unlike the Codex files above, the `opencode-tool-execute-after*.sample.json`
fixtures are the **native OpenCode `tool.execute.after` `(input, output)` shape**
— NOT a ready-to-pipe stdin payload. The generated plugin
(`.opencode/plugins/blastcheck.ts`) maps each native event into the
Claude-compatible `PostToolUse` payload (`{ tool_name: input.tool, tool_input:
output.args, tool_response: { stdout: output.output, ...output.metadata } }`)
before shelling out to `blastcheck hook opencode post-tool-use`. The OpenCode hook
tests (`src/hooks/opencode-*.test.ts`) apply that same mapping, so the fixtures
double as documentation of the assumed native shape AND drive the capture tests.

| File | Native event | Covers |
|------|--------------|--------|
| `opencode-tool-execute-after.sample.json` | `tool.execute.after` (`bash`) | `input.tool="bash"`, `output.args.command` → canonical `args.cmd` (Bash gate) |
| `opencode-tool-execute-after-edit.sample.json` | `tool.execute.after` (`edit`) | `input.tool="edit"`, `output.args.filePath` → canonical `args.path` |

⚠️ **Owed: a live-captured OpenCode sample (FR31, same lesson as Codex).** Story
3.3 re-attempted the live capture: the OpenCode runtime (v1.3.3) IS installed and a
temporary logging plugin loaded successfully (`plugin.init` fired, confirming the
`{ directory }` context shape and that `session.created`/`session.idle`/
`tool.execute.after` are accepted event names), but **no real tool-call round-trip
could be driven** — the only config-enabled provider (`protei`) is a VPN-gated
internal endpoint, and `anthropic` is disabled in the global config and its model
catalog does not resolve offline. So the `(input, output)` payloads + `session.idle`
shape remain **doc-derived** from the June-2026 OpenCode plugin docs
(<https://opencode.ai/docs/plugins/>) — the event names + `(input, output)` field
shapes — not captured from a running OpenCode instance. OpenCode warns plugin
payloads are not a frozen interface. Before relying on field-compatibility in
production, reconcile these against an actually-captured `tool.execute.after`
payload (e.g. a temporary plugin that writes `JSON.stringify({ input, output })`
to a file). Two field-name assumptions to confirm against a live sample: the
result/exit-code keys under `output.metadata` (the default adapter reads
`exit_code`/`exitCode`, while the docs suggest `exit`; the exit code is best-effort
and degrades — the Bash gate keys off `args.cmd`, not the exit code) and that
`edit`/`write` expose `filePath`. See `deferred-work.md`.

## NOT the rollout fixture

Do **not** confuse these with `tests/fixtures/trajectories/codex-rollout.sample.jsonl`
— that is a multi-line `rollout-*.jsonl` **log** consumed by the separate rollout
adapter (`adapt --from codex`). These hook fixtures are single stdin payloads for
the live lifecycle (hook) path. The two paths are independent (AC8).

## Source / provenance

Shapes verified against the OpenAI Codex hooks documentation (June 2026):
- https://developers.openai.com/codex/hooks — lifecycle events + stdin payload fields
- https://developers.openai.com/codex/config-advanced — `hooks.json` command handlers

⚠️ **Owed: a live-captured sample (FR31).** A live Codex session was not reachable
in this dev environment, so these are the closest verifiable real-shape payloads
built from the documented field contract rather than captured from a running
Codex instance. The OpenAI docs explicitly warn the transcript/payload format is
**not a stable interface**, so when a live Codex session is available these should
be replaced/confirmed with an actually-captured `PostToolUse` payload (e.g. via a
temporary logging hook that `cat`s stdin to a file). Until then, the liberal
`common.ts` parsing + these fixtures are the hedge — not a rigid schema.
