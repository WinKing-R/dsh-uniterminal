import { describe, expect, it, vi } from "vitest";
import { Config, apply, inject, name } from "../src/index.js";
import type { PluginContext } from "../src/index.js";

const HEALTH_ROUTE = "/api/uniterminal/health";

function fakeContext(options: { throwOnRegister?: boolean } = {}): {
  ctx: PluginContext;
  registered: string[];
  warnings: string[];
} {
  const registered: string[] = [];
  const warnings: string[] = [];
  const ctx: PluginContext = {
    logger: {
      warn: (message, ...args) => {
        warnings.push([message, ...args.map((arg) => String(arg))].join(" "));
      },
    },
    webServer: {
      register(route) {
        if (options.throwOnRegister === true) throw new Error("route clash");
        registered.push(route.path);
        return () => {};
      },
    },
    effect(run) {
      run();
    },
  };
  return { ctx, registered, warnings };
}

const config = { bufferBytes: 1024, term: "xterm-256color", connectTimeoutMs: 1000 };

describe("uniterminal plugin", () => {
  it("declares its cordis identity", () => {
    expect(name).toBe("uniterminal");
    expect(inject).toContain("webServer");
    expect(Config).toBeDefined();
  });

  it("registers its routes", async () => {
    const { ctx, registered } = fakeContext();
    apply(ctx, config);
    await vi.waitFor(() => {
      expect(registered).toContain(HEALTH_ROUTE);
    });
  });

  it("never throws when the host refuses a route", async () => {
    const { ctx, registered, warnings } = fakeContext({ throwOnRegister: true });
    expect(() => apply(ctx, config)).not.toThrow();
    await vi.waitFor(() => {
      expect(warnings.some((line) => line.includes(HEALTH_ROUTE))).toBe(true);
    });
    expect(registered).toEqual([]);
  });
});
