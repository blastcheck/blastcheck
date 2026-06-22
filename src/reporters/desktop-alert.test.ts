import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnSyncMock } = vi.hoisted(() => ({ spawnSyncMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawnSync: spawnSyncMock }));

import { desktopAlert } from "./desktop-alert.js";

/** Run `fn` with `process.platform` forced to `value`, then restore it. */
function withPlatform(value: NodeJS.Platform, fn: () => void): void {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value, configurable: true });
  try {
    fn();
  } finally {
    if (original) Object.defineProperty(process, "platform", original);
  }
}

describe("desktopAlert", () => {
  afterEach(() => {
    spawnSyncMock.mockReset();
  });

  it("darwin: shells out to osascript with the headline and a blastcheck title", () => {
    withPlatform("darwin", () => desktopAlert("blastcheck: ✗ FAIL — denied-files failed"));
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    const [bin, args] = spawnSyncMock.mock.calls[0] as [string, string[]];
    expect(bin).toBe("osascript");
    expect(args[0]).toBe("-e");
    expect(args[1]).toContain('with title "blastcheck"');
    expect(args[1]).toContain("blastcheck: ✗ FAIL — denied-files failed");
  });

  it("escapes embedded quotes/backslashes in the AppleScript literal", () => {
    withPlatform("darwin", () => desktopAlert('a "quote" and a \\ slash'));
    const [, args] = spawnSyncMock.mock.calls[0] as [string, string[]];
    expect(args[1]).toContain('\\"quote\\"');
    expect(args[1]).toContain("\\\\ slash");
  });

  it("linux: shells out to notify-send", () => {
    withPlatform("linux", () => desktopAlert("hi"));
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "notify-send",
      ["blastcheck", "hi"],
      expect.anything(),
    );
  });

  it("other platforms: no-op (no spawn)", () => {
    withPlatform("win32", () => desktopAlert("hi"));
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("never throws when the spawn fails (degrades quietly)", () => {
    spawnSyncMock.mockImplementation(() => {
      throw new Error("ENOENT: osascript not found");
    });
    expect(() => withPlatform("darwin", () => desktopAlert("hi"))).not.toThrow();
  });
});
