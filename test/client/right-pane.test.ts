import { describe, expect, it } from "vitest";
import { detectRightPane, registerTab } from "../../src/client/right-pane.js";

describe("detectRightPane", () => {
  it("prefers betterSidebar when both registries exist", () => {
    expect(
      detectRightPane({ betterSidebar: { registerTab() {} }, sidebarRightTabs: { register() {} } }),
    ).toBe("betterSidebar");
  });

  it("falls back to the official registry", () => {
    expect(detectRightPane({ sidebarRightTabs: { register() {} } })).toBe("sidebarRightTabs");
  });

  it("reports none when neither exists", () => {
    expect(detectRightPane({})).toBe("none");
  });
});

describe("registerTab", () => {
  it("registers into whichever registry exists", () => {
    const calls: unknown[] = [];
    const result = registerTab(
      { betterSidebar: { registerTab: (descriptor: unknown) => void calls.push(descriptor) } },
      { id: "uniterminal", title: () => "UniTerminal", component: () => null },
    );
    expect(result).toEqual({ ok: true, target: "betterSidebar" });
    expect(calls).toHaveLength(1);
  });

  it("returns an error instead of throwing when registration fails", () => {
    const result = registerTab(
      {
        betterSidebar: {
          registerTab() {
            throw new Error("duplicate id");
          },
        },
      },
      { id: "uniterminal", title: () => "UniTerminal", component: () => null },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("duplicate id");
  });

  it("reports a diagnosable failure when no registry exists", () => {
    const result = registerTab({}, { id: "uniterminal", title: () => "UniTerminal", component: () => null });
    expect(result).toEqual({ ok: false, target: "none", error: "no right-pane registry available" });
  });
});
