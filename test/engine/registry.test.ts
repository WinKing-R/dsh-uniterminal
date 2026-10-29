import { describe, expect, it } from "vitest";
import { TransportRegistry } from "../../src/engine/registry.js";
import type { TransportAdapter } from "../../src/engine/types.js";

const stub = (kind: TransportAdapter["kind"]): TransportAdapter => ({
  kind,
  capabilities: { exec: false, sftp: false, tunnel: false, resize: false },
  open: () => Promise.reject(new Error("not needed")),
});

describe("TransportRegistry", () => {
  it("registers and resolves an adapter by kind", () => {
    const registry = new TransportRegistry();
    registry.register(stub("local"));
    expect(registry.get("local")?.kind).toBe("local");
    expect(registry.kinds()).toEqual(["local"]);
  });

  it("rejects a duplicate kind", () => {
    const registry = new TransportRegistry();
    registry.register(stub("ssh"));
    expect(() => registry.register(stub("ssh"))).toThrow(/already registered/);
  });

  it("require() throws for a missing kind", () => {
    const registry = new TransportRegistry();
    expect(() => registry.require("telnet")).toThrow(/not available/);
  });
});
