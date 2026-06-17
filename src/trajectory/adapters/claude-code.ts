type ExternalTrajectoryEvent = {
  tool: string;
  args: Record<string, unknown>;
  step: number;
  ts?: string;
  exit_code?: number;
  stdout_tail?: string;
  stderr_tail?: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function tail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const lines = value.split(/\r?\n/);
  return lines.slice(-20).join("\n");
}

function externalArgs(rawArgs: Record<string, unknown>): Record<string, unknown> {
  const args: Record<string, unknown> = { ...rawArgs };
  for (const key of ["file_path", "filePath", "command"]) delete args[key];
  return args;
}

function adaptOne(input: unknown, step: number): ExternalTrajectoryEvent | undefined {
  const record = asRecord(input);
  const tool = firstString(record, ["tool", "tool_name", "name"]);
  if (tool === undefined) return undefined;

  const rawArgs = asRecord(record.args ?? record.input ?? record.tool_input);
  const path = firstString(rawArgs, ["path", "file_path", "filePath"]);
  const cmd = firstString(rawArgs, ["cmd", "command"]);
  // The real Claude Code `PostToolUse` payload carries the tool result under
  // `tool_response` (e.g. Bash → `{stdout, stderr, interrupted}`); older/internal
  // shapes used `result`. Read both so the same adapter serves the live hook and
  // the in-tree fixtures. Note: Bash `tool_response` has no exit code — that part
  // simply degrades (no `exit_code` emitted), it is never fabricated (NFR4).
  const result = asRecord(record.result);
  const response = asRecord(record.tool_response);
  const exitCode =
    firstNumber(record, ["exit_code", "exitCode"]) ??
    firstNumber(result, ["exit_code", "exitCode"]) ??
    firstNumber(response, ["exit_code", "exitCode"]);
  const stdoutTail = tail(
    record.stdout_tail ??
      record.stdout ??
      result.stdout_tail ??
      result.stdout ??
      response.stdout_tail ??
      response.stdout,
  );
  const stderrTail = tail(
    record.stderr_tail ??
      record.stderr ??
      result.stderr_tail ??
      result.stderr ??
      response.stderr_tail ??
      response.stderr,
  );
  const ts = firstString(record, ["ts", "timestamp"]);

  const args = externalArgs(rawArgs);
  if (path !== undefined) args.path = path;
  if (cmd !== undefined) args.cmd = cmd;

  return {
    tool,
    args,
    step: firstNumber(record, ["step"]) ?? step,
    ...(ts !== undefined ? { ts } : {}),
    ...(exitCode !== undefined ? { exit_code: exitCode } : {}),
    ...(stdoutTail !== undefined ? { stdout_tail: stdoutTail } : {}),
    ...(stderrTail !== undefined ? { stderr_tail: stderrTail } : {}),
  };
}

export function adaptClaudeCodePostToolUse(input: unknown): ExternalTrajectoryEvent[] {
  const inputs = Array.isArray(input) ? input : [input];
  return inputs.flatMap((item, index) => {
    const event = adaptOne(item, index + 1);
    return event === undefined ? [] : [event];
  });
}
