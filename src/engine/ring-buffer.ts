export class RingBuffer {
  readonly #limit: number;
  readonly #bytes: Uint8Array;
  #start = 0;
  #end = 0;

  constructor(limitBytes: number) {
    if (!Number.isInteger(limitBytes) || limitBytes <= 0) {
      throw new RangeError("uniterminal: ring buffer limit must be a positive integer");
    }
    this.#limit = limitBytes;
    this.#bytes = new Uint8Array(limitBytes);
  }

  get cursor(): number {
    return this.#end;
  }

  get droppedBytes(): number {
    return this.#start;
  }

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    const newEnd = this.#end + chunk.length;
    if (chunk.length >= this.#limit) {
      const keepFrom = newEnd - this.#limit;
      for (let offset = keepFrom; offset < newEnd; offset += 1) {
        this.#bytes[offset % this.#limit] = chunk[offset - this.#end]!;
      }
      this.#start = keepFrom;
      this.#end = newEnd;
      return;
    }
    for (let index = 0; index < chunk.length; index += 1) {
      this.#bytes[(this.#end + index) % this.#limit] = chunk[index]!;
    }
    this.#end = newEnd;
    if (this.#end - this.#start > this.#limit) this.#start = this.#end - this.#limit;
  }

  since(cursor: number): { data: Uint8Array; cursor: number } {
    const from = Math.max(cursor, this.#start);
    const length = this.#end - from;
    const data = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      data[index] = this.#bytes[(from + index) % this.#limit]!;
    }
    return { data, cursor: this.#end };
  }
}
