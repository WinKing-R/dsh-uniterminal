import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { diag } from "../src/host-diag.js";

const home = vi.hoisted(() => ({ dir: "" }));

const fsCalls = vi.hoisted(() => ({
  appendFile: vi.fn(),
  mkdir: vi.fn(),
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => home.dir };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  fsCalls.appendFile.mockImplementation((...args: unknown[]) => (actual.appendFile as (...a: unknown[]) => Promise<void>)(...args));
  fsCalls.mkdir.mockImplementation((...args: unknown[]) => (actual.mkdir as (...a: unknown[]) => Promise<unknown>)(...args));
  return { ...actual, appendFile: fsCalls.appendFile, mkdir: fsCalls.mkdir };
});

const REAL_LOG = process.env.USERPROFILE
  ? join(process.env.USERPROFILE, ".dsh", "uniterminal", "diag.log")
  : undefined;

function realLogSize(): number {
  return REAL_LOG !== undefined && existsSync(REAL_LOG) ? statSync(REAL_LOG).size : -1;
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));

describe("host-diag", () => {
  let logPath: string;

  beforeEach(() => {
    home.dir = mkdtempSync(join(tmpdir(), "uniterminal-diag-"));
    logPath = join(home.dir, ".dsh", "uniterminal", "diag.log");
    fsCalls.appendFile.mockClear();
    fsCalls.mkdir.mockClear();
  });

  afterEach(() => {
    rmSync(home.dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("does no file io under the test runner", async () => {
    diag("host-diag.probe", { ok: true });
    await settle();

    expect(fsCalls.mkdir).not.toHaveBeenCalled();
    expect(fsCalls.appendFile).not.toHaveBeenCalled();
    expect(existsSync(logPath)).toBe(false);
    expect(existsSync(join(home.dir, ".dsh"))).toBe(false);
  });

  it("leaves the real diagnostic log untouched", async () => {
    if (REAL_LOG === undefined) return;
    // 真实日志会被**正在运行的 DSH 实例**随时追加，因此不能断言"整个文件没变"
    // （那样会在用户开着 DSH 时偶发失败）。只断言"本测试这条事件没有被写进去"。
    diag("host-diag.leak-check", {});
    await settle();

    const content = existsSync(REAL_LOG) ? readFileSync(REAL_LOG, "utf8") : "";
    expect(content).not.toContain("host-diag.leak-check");
  });

  it("still appends one JSONL line outside a test process", async () => {
    vi.stubEnv("VITEST", "false");
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();
    const fresh = await import("../src/host-diag.js");

    fresh.diag("host-diag.probe", { ok: true });

    await vi.waitFor(() => {
      expect(fsCalls.mkdir).toHaveBeenCalledTimes(1);
      expect(fsCalls.appendFile).toHaveBeenCalledTimes(1);
      expect(readFileSync(logPath, "utf8")).toContain('"event":"host-diag.probe"');
    }, { timeout: 2000 });

    const written = JSON.parse(readFileSync(logPath, "utf8").trim()) as Record<string, unknown>;
    expect(written.event).toBe("host-diag.probe");
    expect(written.ok).toBe(true);
    expect(typeof written.ts).toBe("number");
    expect(fsCalls.appendFile.mock.calls[0]?.[0]).toBe(logPath);
  });
});
