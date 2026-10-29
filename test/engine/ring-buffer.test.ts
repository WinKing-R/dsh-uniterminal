import { describe, expect, it } from "vitest";
import { RingBuffer } from "../../src/engine/ring-buffer.js";

describe("RingBuffer", () => {
  it("returns pushed bytes since cursor", () => {
    const buffer = new RingBuffer(1024);
    buffer.push(new Uint8Array([1, 2, 3]));
    const result = buffer.since(0);
    expect([...result.data]).toEqual([1, 2, 3]);
    expect(result.cursor).toBe(3);
  });

  it("drops the oldest bytes at the limit and reports them", () => {
    const buffer = new RingBuffer(4);
    buffer.push(new Uint8Array([1, 2, 3, 4]));
    buffer.push(new Uint8Array([5, 6]));
    expect([...buffer.since(0).data]).toEqual([3, 4, 5, 6]);
    expect(buffer.droppedBytes).toBe(2);
  });

  it("keeps the cursor monotonic after a drop", () => {
    const buffer = new RingBuffer(2);
    buffer.push(new Uint8Array([1, 2, 3]));
    expect(buffer.cursor).toBe(3);
    expect([...buffer.since(2).data]).toEqual([3]);
  });

  it("rejects a non-positive limit", () => {
    expect(() => new RingBuffer(0)).toThrow(RangeError);
  });
});
