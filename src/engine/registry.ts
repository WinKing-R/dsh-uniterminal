import type { ProtocolKind, TransportAdapter } from "./types.js";

export class TransportRegistry {
  readonly #adapters = new Map<ProtocolKind, TransportAdapter>();

  register(adapter: TransportAdapter): void {
    if (this.#adapters.has(adapter.kind)) {
      throw new Error("uniterminal: transport '" + adapter.kind + "' already registered");
    }
    this.#adapters.set(adapter.kind, adapter);
  }

  get(kind: ProtocolKind): TransportAdapter | undefined {
    return this.#adapters.get(kind);
  }

  require(kind: ProtocolKind): TransportAdapter {
    const adapter = this.#adapters.get(kind);
    if (adapter === undefined) {
      throw new Error("uniterminal: transport '" + kind + "' is not available");
    }
    return adapter;
  }

  kinds(): ProtocolKind[] {
    return [...this.#adapters.keys()];
  }
}
