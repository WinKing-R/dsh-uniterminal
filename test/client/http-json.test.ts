import { describe, expect, it } from "vitest";
import { parseJsonSafe } from "../../src/client/http-json.js";

describe("parseJsonSafe", () => {
  it("returns the parsed JSON object untouched", () => {
    const payload = parseJsonSafe('{"profiles":[{"id":"p1"}],"groups":[]}', 200);
    expect(payload.error).toBeUndefined();
    expect((payload as { profiles?: { id: string }[] }).profiles).toEqual([{ id: "p1" }]);
  });

  it("turns the host plain-text fallback into a readable error instead of throwing", () => {
    // 宿主 404 兜底返回纯文本 not found；无条件 response.json() 会抛 SyntaxError
    const payload = parseJsonSafe("not found", 404);
    expect(payload.error).toBe("HTTP 404 not found");
  });

  it("clips a long non-JSON body to 80 characters", () => {
    const payload = parseJsonSafe("x".repeat(200), 500);
    expect(payload.error).toBe("HTTP 500 " + "x".repeat(80));
  });

  it("reports the status alone when the body is empty", () => {
    expect(parseJsonSafe("", 500).error).toBe("HTTP 500");
  });

  it("rejects JSON that is not an object", () => {
    expect(parseJsonSafe("[1,2]", 200).error).toBe("HTTP 200 [1,2]");
  });
});
