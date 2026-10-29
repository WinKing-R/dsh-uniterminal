# UniTerminal M0 骨架 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) for tracking.

**Goal:** 让 UniTerminal 作为 DSH 双面插件跑起来：右栏能开出一个可交互的 SSH 终端，且任何一步失败都不影响 web shell 启动。

**Architecture:** 宿主半边用 `TransportAdapter` 抽象隔离协议，`SessionManager` 持有会话与有界输出缓冲，`/api/uniterminal/*` 暴露 REST 与 WebSocket；浏览器半边用 `detectRightPane` 探测两套右栏注册表并注册 tab，xterm 只认 WS 协议。

**Tech Stack:** TypeScript 5 / ESM / ssh2 / ws / vitest / tsdown / @xterm/xterm / React 18

**Spec:** `docs/PRD.md`（M0 对应 M0-1 ~ M0-11，见 `docs/superpowers/plans/2026-10-25-uniterminal-m0-m4-taskbook.md`）

## Global Constraints

- Node ≥ 20；本机 node `C:\Users\<you>\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`，pnpm `C:\Users\<you>\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs`
- `strict` + `noUncheckedIndexedAccess`；纯 ESM；公共接口禁用 `any`
- 对外标识一律 `uniterminal` 命名空间：路由 `/api/uniterminal/*`、tab id `uniterminal`、配置目录 `~/.dsh/uniterminal/`
- 所有注册（`webServer.register` / `tools.register` / `slots`）必须包 `try/catch`；`apply` 永不抛错
- **绝不** import `electron`
- 密码 / 口令 / 私钥明文绝不进入：入参、返回值、日志、审计、错误消息
- 宿主半边依赖上限：`ssh2`、`ws`、`@deepseek-ai/schemastery`；**不得**引入 `node-pty`
- 每个任务先写失败测试；UI 组件（Task 10）为例外，由 Task 11 人工验收覆盖
- 每任务一次 conventional commit，提交信息引用 PRD 任务 ID

---

### Task 1: 仓库脚手架

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `README.md`
- Test: 无（由 `pnpm typecheck` 与 `pnpm test` 空跑验证）

**Interfaces:**
- Consumes: 无
- Produces: `pnpm build` / `pnpm test` / `pnpm typecheck` 三个脚本；`package.json` 的 `dsh` 清单字段

- [ ] **Step 1: 初始化仓库**

```bash
cd E:/DeepSeekWS/codingWork/dsh-Uniterminal
git init -b main
```

- [ ] **Step 2: 写 `package.json`**

```json
{
  "name": "@winking-r/dsh-uniterminal",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "files": ["lib", "cordis.patch.yml", "README.md"],
  "engines": { "node": ">=20" },
  "dsh": {
    "engines": { "dsh": ">=0.2.1-rc.2" },
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "inject": [
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-slots",
        "@deepseek-ai/dsh-client-ui-sidebar-right",
        "@deepseek-ai/dsh-client-modules"
      ],
      "platform": "web"
    }
  },
  "scripts": {
    "build": "tsdown",
    "test": "vitest run --passWithNoTests",
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 3: 安装依赖（版本由 pnpm 解析，不要手写版本号）**

```bash
pnpm add ssh2 ws @deepseek-ai/schemastery @xterm/xterm @xterm/addon-fit
pnpm add -D typescript vitest tsdown @types/node @types/ws
```

Expected: `package.json` 出现 `dependencies` / `devDependencies` 两节且含上述包

- [ ] **Step 4: 写 `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM"],
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "declaration": true,
    "outDir": "lib",
    "skipLibCheck": true,
    "types": ["node"],
    "verbatimModuleSyntax": true
  },
  "include": ["src", "test"]
}
```

注：单个 tsconfig 同时含 DOM 与 node 类型，是 M0 的务实取舍；M1 起可拆为 `tsconfig.host.json` / `tsconfig.client.json`。

- [ ] **Step 5: 写 `vitest.config.ts` 与 `.gitignore`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});
```

```
node_modules/
lib/
*.log
```

- [ ] **Step 6: 验证**

Run: `pnpm typecheck`
Expected: 退出码 0，无输出

Run: `pnpm test`
Expected: `No test files found`，退出码 0（`--passWithNoTests` 让空仓库阶段也成立）

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "chore: scaffold uniterminal plugin (M0-1)"
```

---

### Task 2: RingBuffer（有界输出缓冲）

**Files:**
- Create: `src/engine/ring-buffer.ts`
- Test: `test/engine/ring-buffer.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `new RingBuffer(limitBytes: number)`；`push(chunk: Uint8Array): void`；`since(cursor: number): { data: Uint8Array; cursor: number }`；`get cursor(): number`；`get droppedBytes(): number`

**游标语义（Task 5、Task 6 都依赖它）：** `cursor` 是**绝对字节偏移**，永不回退；缓冲满后最旧字节被丢弃，`since(cursor)` 自动把过小的 cursor 提到 `droppedBytes`。

- [ ] **Step 1: 写失败测试**

```ts
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
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run test/engine/ring-buffer.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/engine/ring-buffer.js"`

- [ ] **Step 3: 实现**

```ts
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
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run test/engine/ring-buffer.test.ts`
Expected: 4 passed

- [ ] **Step 5: 提交**

```bash
git add src/engine/ring-buffer.ts test/engine/ring-buffer.test.ts
git commit -m "feat: bounded ring buffer for session output (M0-2)"
```

---

### Task 3: TransportAdapter 契约与注册表

**Files:**
- Create: `src/engine/types.ts`, `src/engine/registry.ts`
- Test: `test/engine/registry.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `type ProtocolKind = "ssh" | "local" | "telnet" | "serial"`
  - `interface Capabilities { exec: boolean; sftp: boolean; tunnel: boolean; resize: boolean }`
  - `interface ResolvedProfile { id: string; kind: ProtocolKind; host?: string; port?: number; user?: string; credentialRef?: string; shell?: string; cwd?: string; keepaliveMs?: number; connectTimeoutMs?: number }`
  - `interface SessionHandle { readonly id: string; readonly kind: ProtocolKind; readonly capabilities: Capabilities; write(chunk: Uint8Array): void; resize(cols: number, rows: number): void; onData(cb: (chunk: Uint8Array) => void): () => void; onClose(cb: (reason: string) => void): () => void; close(): Promise<void> }`
  - `interface TransportAdapter { readonly kind: ProtocolKind; readonly capabilities: Capabilities; open(profile: ResolvedProfile, signal: AbortSignal): Promise<SessionHandle> }`
  - `class TransportRegistry { register(a: TransportAdapter): void; get(kind): TransportAdapter | undefined; require(kind): TransportAdapter; kinds(): ProtocolKind[] }`

- [ ] **Step 1: 写失败测试**

```ts
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
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run test/engine/registry.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 写 `src/engine/types.ts`**

```ts
export type ProtocolKind = "ssh" | "local" | "telnet" | "serial";

export interface Capabilities {
  exec: boolean;
  sftp: boolean;
  tunnel: boolean;
  resize: boolean;
}

export interface ResolvedProfile {
  id: string;
  kind: ProtocolKind;
  host?: string;
  port?: number;
  user?: string;
  credentialRef?: string;
  shell?: string;
  cwd?: string;
  keepaliveMs?: number;
  connectTimeoutMs?: number;
}

export interface SessionHandle {
  readonly id: string;
  readonly kind: ProtocolKind;
  readonly capabilities: Capabilities;
  write(chunk: Uint8Array): void;
  resize(cols: number, rows: number): void;
  onData(cb: (chunk: Uint8Array) => void): () => void;
  onClose(cb: (reason: string) => void): () => void;
  close(): Promise<void>;
}

export interface TransportAdapter {
  readonly kind: ProtocolKind;
  readonly capabilities: Capabilities;
  open(profile: ResolvedProfile, signal: AbortSignal): Promise<SessionHandle>;
}
```

- [ ] **Step 4: 写 `src/engine/registry.ts`**

```ts
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
```

- [ ] **Step 5: 运行确认通过**

Run: `pnpm vitest run test/engine/registry.test.ts`
Expected: 3 passed

- [ ] **Step 6: 提交**

```bash
git add src/engine/types.ts src/engine/registry.ts test/engine/registry.test.ts
git commit -m "feat: transport adapter contract and registry (M0-3)"
```

---

### Task 4: SSH 传输适配器（可注入 client 工厂）

**Files:**
- Create: `src/engine/ssh-transport.ts`
- Test: `test/engine/ssh-transport.test.ts`

**Interfaces:**
- Consumes: `TransportAdapter`、`ResolvedProfile`、`SessionHandle`（Task 3）
- Produces:
  - `interface SshStreamLike { write(data: Uint8Array): boolean; setWindow(rows: number, cols: number, height: number, width: number): void; on(event: "data", cb: (chunk: Buffer) => void): void; on(event: "close", cb: () => void): void; close(): void }`
  - `interface SshClientLike { on(event: "ready" | "error" | "close", cb: (...args: never[]) => void): void; connect(config: Record<string, unknown>): void; shell(options: { term: string; cols: number; rows: number }, cb: (err: Error | undefined, stream: SshStreamLike) => void): void; end(): void; destroy(): void }`
  - `createSshTransport(factory: SshClientFactory, defaults?: { term?: string; connectTimeoutMs?: number }): TransportAdapter`
  - `loadSshClientFactory(): Promise<SshClientFactory>`（懒 `import("ssh2")`）

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest";
import { createSshTransport, type SshClientLike, type SshStreamLike } from "../../src/engine/ssh-transport.js";

function makeFake() {
  const writes: Uint8Array[] = [];
  const windows: [number, number][] = [];
  const dataCallbacks: ((chunk: Buffer) => void)[] = [];
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>();

  const stream: SshStreamLike = {
    write: (data) => { writes.push(data); return true; },
    setWindow: (rows, cols) => { windows.push([rows, cols]); },
    on: (event: string, cb: never) => { if (event === "data") dataCallbacks.push(cb); },
    close: () => {},
  };

  const client: SshClientLike = {
    on: (event: string, cb: never) => {
      const list = handlers.get(event) ?? [];
      list.push(cb);
      handlers.set(event, list);
    },
    connect: () => {},
    shell: (_options, cb) => cb(undefined, stream),
    end: () => {},
    destroy: () => {},
  };

  const emit = (event: string, ...args: unknown[]) => {
    for (const cb of handlers.get(event) ?? []) cb(...args);
  };

  return { client, writes, windows, dataCallbacks, emit };
}

describe("createSshTransport", () => {
  it("opens a shell then forwards write, resize and data", async () => {
    const fake = makeFake();
    const adapter = createSshTransport(() => fake.client);
    const opening = adapter.open({ id: "h1", kind: "ssh", host: "example.com" }, new AbortController().signal);
    fake.emit("ready");
    const handle = await opening;

    handle.write(new Uint8Array([65]));
    expect(fake.writes).toEqual([new Uint8Array([65])]);

    handle.resize(120, 40);
    expect(fake.windows).toEqual([[40, 120]]);

    const received: number[] = [];
    handle.onData((chunk) => received.push(chunk[0]!));
    for (const cb of fake.dataCallbacks) cb(Buffer.from([7]));
    expect(received).toEqual([7]);
  });

  it("rejects when the client reports an error before the shell opens", async () => {
    const fake = makeFake();
    const adapter = createSshTransport(() => fake.client);
    const opening = adapter.open({ id: "h2", kind: "ssh", host: "example.com" }, new AbortController().signal);
    fake.emit("error", new Error("boom"));
    await expect(opening).rejects.toThrow("boom");
  });

  it("rejects when the signal aborts before ready", async () => {
    const fake = makeFake();
    const adapter = createSshTransport(() => fake.client);
    const controller = new AbortController();
    const opening = adapter.open({ id: "h3", kind: "ssh", host: "example.com" }, controller.signal);
    controller.abort();
    await expect(opening).rejects.toThrow(/aborted/);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run test/engine/ssh-transport.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

```ts
import type { Capabilities, ResolvedProfile, SessionHandle, TransportAdapter } from "./types.js";

export interface SshStreamLike {
  write(data: Uint8Array): boolean;
  setWindow(rows: number, cols: number, height: number, width: number): void;
  on(event: "data", cb: (chunk: Buffer) => void): void;
  on(event: "close", cb: () => void): void;
  close(): void;
}

export interface SshClientLike {
  on(event: "ready", cb: () => void): void;
  on(event: "error", cb: (error: Error) => void): void;
  on(event: "close", cb: () => void): void;
  connect(config: Record<string, unknown>): void;
  shell(
    options: { term: string; cols: number; rows: number },
    cb: (error: Error | undefined, stream: SshStreamLike) => void,
  ): void;
  end(): void;
  destroy(): void;
}

export type SshClientFactory = (profile: ResolvedProfile) => SshClientLike;

const SSH_CAPABILITIES: Capabilities = { exec: true, sftp: true, tunnel: true, resize: true };

export function createSshTransport(
  factory: SshClientFactory,
  defaults: { term?: string; connectTimeoutMs?: number } = {},
): TransportAdapter {
  const term = defaults.term ?? "xterm-256color";

  return {
    kind: "ssh",
    capabilities: SSH_CAPABILITIES,
    open(profile, signal) {
      return new Promise<SessionHandle>((resolve, reject) => {
        const client = factory(profile);
        const dataListeners = new Set<(chunk: Uint8Array) => void>();
        const closeListeners = new Set<(reason: string) => void>();
        let settled = false;

        const fail = (error: Error) => {
          if (settled) return;
          settled = true;
          client.destroy();
          reject(error);
        };

        signal.addEventListener(
          "abort",
          () => fail(new Error("uniterminal: connection aborted")),
          { once: true },
        );

        client.on("error", fail);

        client.on("ready", () => {
          client.shell({ term, cols: 80, rows: 24 }, (error, stream) => {
            if (error !== undefined) {
              fail(error);
              return;
            }
            stream.on("data", (chunk) => {
              const bytes = new Uint8Array(chunk);
              for (const listener of dataListeners) listener(bytes);
            });
            stream.on("close", () => {
              for (const listener of closeListeners) listener("stream closed");
            });
            settled = true;
            resolve({
              id: profile.id,
              kind: "ssh",
              capabilities: SSH_CAPABILITIES,
              write: (chunk) => void stream.write(chunk),
              resize: (cols, rows) => stream.setWindow(rows, cols, 0, 0),
              onData: (cb) => {
                dataListeners.add(cb);
                return () => void dataListeners.delete(cb);
              },
              onClose: (cb) => {
                closeListeners.add(cb);
                return () => void closeListeners.delete(cb);
              },
              close: async () => {
                stream.close();
                client.end();
              },
            });
          });
        });

        client.connect({
          host: profile.host,
          port: profile.port ?? 22,
          username: profile.user,
          keepaliveInterval: profile.keepaliveMs,
          readyTimeout: profile.connectTimeoutMs ?? defaults.connectTimeoutMs ?? 20000,
        });
      });
    },
  };
}

export async function loadSshClientFactory(): Promise<SshClientFactory> {
  // 懒加载：ssh2 是可选依赖，加载失败只禁用该协议
  const { Client } = await import("ssh2");
  return () => new Client() as unknown as SshClientLike;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run test/engine/ssh-transport.test.ts`
Expected: 3 passed

- [ ] **Step 5: 提交**

```bash
git add src/engine/ssh-transport.ts test/engine/ssh-transport.test.ts
git commit -m "feat: ssh transport with injectable client factory (M0-4)"
```

---

### Task 5: SessionManager

**Files:**
- Create: `src/engine/session-manager.ts`
- Test: `test/engine/session-manager.test.ts`

**Interfaces:**
- Consumes: `TransportRegistry`（Task 3）、`RingBuffer`（Task 2）
- Produces:
  - `interface SessionInfo { id: string; kind: ProtocolKind; capabilities: Capabilities; createdAt: number; status: "open" | "closed" }`
  - `new SessionManager(registry, options?: { bufferBytes?: number; now?: () => number })`
  - `open(profile: ResolvedProfile): Promise<SessionInfo>`
  - `list(): SessionInfo[]` / `write(id, chunk): void` / `resize(id, cols, rows): void`
  - `read(id, cursor): { data: Uint8Array; cursor: number }` / `subscribe(id, cb): () => void` / `close(id): Promise<void>`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest";
import { TransportRegistry } from "../../src/engine/registry.js";
import { SessionManager } from "../../src/engine/session-manager.js";
import type { SessionHandle, TransportAdapter } from "../../src/engine/types.js";

function stubAdapter() {
  const dataCallbacks = new Set<(chunk: Uint8Array) => void>();
  const writes: Uint8Array[] = [];
  const handle: SessionHandle = {
    id: "handle",
    kind: "ssh",
    capabilities: { exec: true, sftp: true, tunnel: true, resize: true },
    write: (chunk) => void writes.push(chunk),
    resize: () => {},
    onData: (cb) => {
      dataCallbacks.add(cb);
      return () => void dataCallbacks.delete(cb);
    },
    onClose: () => () => {},
    close: async () => {},
  };
  const adapter: TransportAdapter = {
    kind: "ssh",
    capabilities: handle.capabilities,
    open: async () => handle,
  };
  return {
    adapter,
    writes,
    push: (chunk: Uint8Array) => {
      for (const cb of dataCallbacks) cb(chunk);
    },
  };
}

describe("SessionManager", () => {
  it("buffers output and replays it from a cursor", async () => {
    const registry = new TransportRegistry();
    const fake = stubAdapter();
    registry.register(fake.adapter);
    const manager = new SessionManager(registry, { bufferBytes: 64 });

    const info = await manager.open({ id: "p1", kind: "ssh", host: "h" });
    fake.push(new Uint8Array([1, 2, 3]));

    expect([...manager.read(info.id, 0).data]).toEqual([1, 2, 3]);
    expect([...manager.read(info.id, 2).data]).toEqual([3]);
    expect(manager.read(info.id, 0).cursor).toBe(3);
  });

  it("routes writes to the underlying handle", async () => {
    const registry = new TransportRegistry();
    const fake = stubAdapter();
    registry.register(fake.adapter);
    const manager = new SessionManager(registry);
    const info = await manager.open({ id: "p1", kind: "ssh", host: "h" });

    manager.write(info.id, new Uint8Array([9]));
    expect(fake.writes).toEqual([new Uint8Array([9])]);
  });

  it("throws on an unknown session id", () => {
    const manager = new SessionManager(new TransportRegistry());
    expect(() => manager.read("nope", 0)).toThrow(/unknown session/);
  });

  it("closes and drops the session", async () => {
    const registry = new TransportRegistry();
    registry.register(stubAdapter().adapter);
    const manager = new SessionManager(registry);
    const info = await manager.open({ id: "p1", kind: "ssh", host: "h" });

    await manager.close(info.id);
    expect(manager.list()).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run test/engine/session-manager.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

```ts
import { RingBuffer } from "./ring-buffer.js";
import type { TransportRegistry } from "./registry.js";
import type { Capabilities, ProtocolKind, ResolvedProfile, SessionHandle } from "./types.js";

export interface SessionInfo {
  id: string;
  kind: ProtocolKind;
  capabilities: Capabilities;
  createdAt: number;
  status: "open" | "closed";
}

interface SessionEntry {
  info: SessionInfo;
  buffer: RingBuffer;
  handle: SessionHandle;
  listeners: Set<(chunk: Uint8Array) => void>;
  detachers: (() => void)[];
}

export interface SessionManagerOptions {
  bufferBytes?: number;
  now?: () => number;
}

export class SessionManager {
  readonly #registry: TransportRegistry;
  readonly #sessions = new Map<string, SessionEntry>();
  readonly #bufferBytes: number;
  readonly #now: () => number;
  #sequence = 0;

  constructor(registry: TransportRegistry, options: SessionManagerOptions = {}) {
    this.#registry = registry;
    this.#bufferBytes = options.bufferBytes ?? 1 << 20;
    this.#now = options.now ?? Date.now;
  }

  async open(profile: ResolvedProfile): Promise<SessionInfo> {
    const adapter = this.#registry.require(profile.kind);
    const handle = await adapter.open(profile, new AbortController().signal);
    const id = "s" + String(++this.#sequence);
    const info: SessionInfo = {
      id,
      kind: profile.kind,
      capabilities: adapter.capabilities,
      createdAt: this.#now(),
      status: "open",
    };
    const entry: SessionEntry = {
      info,
      buffer: new RingBuffer(this.#bufferBytes),
      handle,
      listeners: new Set(),
      detachers: [],
    };
    entry.detachers.push(
      handle.onData((chunk) => {
        entry.buffer.push(chunk);
        for (const listener of entry.listeners) listener(chunk);
      }),
    );
    entry.detachers.push(handle.onClose(() => { entry.info.status = "closed"; }));
    this.#sessions.set(id, entry);
    return info;
  }

  list(): SessionInfo[] {
    return [...this.#sessions.values()].map((entry) => entry.info);
  }

  write(id: string, chunk: Uint8Array): void {
    this.#entry(id).handle.write(chunk);
  }

  resize(id: string, cols: number, rows: number): void {
    this.#entry(id).handle.resize(cols, rows);
  }

  read(id: string, cursor: number): { data: Uint8Array; cursor: number } {
    return this.#entry(id).buffer.since(cursor);
  }

  subscribe(id: string, listener: (chunk: Uint8Array) => void): () => void {
    const entry = this.#entry(id);
    entry.listeners.add(listener);
    return () => void entry.listeners.delete(listener);
  }

  async close(id: string): Promise<void> {
    const entry = this.#sessions.get(id);
    if (entry === undefined) return;
    for (const detach of entry.detachers) detach();
    await entry.handle.close();
    entry.info.status = "closed";
    this.#sessions.delete(id);
  }

  #entry(id: string): SessionEntry {
    const entry = this.#sessions.get(id);
    if (entry === undefined) throw new Error("uniterminal: unknown session '" + id + "'");
    return entry;
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run test/engine/session-manager.test.ts`
Expected: 4 passed

- [ ] **Step 5: 提交**

```bash
git add src/engine/session-manager.ts test/engine/session-manager.test.ts
git commit -m "feat: session manager with buffered replay (M0-5)"
```

---

### Task 6: HTTP 路由与 loopback 围栏

**Files:**
- Create: `src/routes.ts`
- Test: `test/routes.test.ts`

**Interfaces:**
- Consumes: `SessionManager`（Task 5）
- Produces:
  - `interface WebRouteLike { kind: "exact" | "prefix"; path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void }`
  - `isLoopback(address: string | undefined): boolean`
  - `UNITERMINAL_ROUTES: { health: string; sessions: string; wsPrefix: string }`
  - `createRoutes(manager: SessionManager): WebRouteLike[]`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest";
import { TransportRegistry } from "../src/engine/registry.js";
import { SessionManager } from "../src/engine/session-manager.js";
import { UNITERMINAL_ROUTES, createRoutes, isLoopback } from "../src/routes.js";
import type { TransportAdapter } from "../src/engine/types.js";

const adapter: TransportAdapter = {
  kind: "ssh",
  capabilities: { exec: true, sftp: true, tunnel: true, resize: true },
  open: async (profile) => ({
    id: profile.id,
    kind: "ssh",
    capabilities: { exec: true, sftp: true, tunnel: true, resize: true },
    write: () => {},
    resize: () => {},
    onData: () => () => {},
    onClose: () => () => {},
    close: async () => {},
  }),
};

function makeManager(): SessionManager {
  const registry = new TransportRegistry();
  registry.register(adapter);
  return new SessionManager(registry, { bufferBytes: 16 });
}

function fakeRequest(address: string, method = "GET", body?: unknown): any {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  return {
    method,
    socket: { remoteAddress: address },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

function fakeResponse() {
  const captured: { status: number; body: unknown } = { status: 0, body: undefined };
  const res: any = {
    writeHead(status: number) { captured.status = status; },
    end(payload: string) { captured.body = JSON.parse(payload); },
  };
  return { res, captured };
}

function routeFor(path: string) {
  const routes = createRoutes(makeManager());
  const found = routes.find((route) => route.path === path);
  if (found === undefined) throw new Error("route missing: " + path);
  return found;
}

describe("isLoopback", () => {
  it("accepts loopback forms and rejects everything else", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopback("10.0.0.5")).toBe(false);
    expect(isLoopback(undefined)).toBe(false);
  });
});

describe("routes", () => {
  it("serves health on loopback only", async () => {
    const route = routeFor(UNITERMINAL_ROUTES.health);
    const ok = fakeResponse();
    await route.handler(fakeRequest("127.0.0.1"), ok.res);
    expect(ok.captured.status).toBe(200);

    const denied = fakeResponse();
    await route.handler(fakeRequest("10.0.0.5"), denied.res);
    expect(denied.captured.status).toBe(403);
  });

  it("creates and lists sessions", async () => {
    const manager = makeManager();
    const route = createRoutes(manager).find((item) => item.path === UNITERMINAL_ROUTES.sessions)!;

    const created = fakeResponse();
    await route.handler(
      fakeRequest("127.0.0.1", "POST", { profile: { id: "p1", kind: "ssh", host: "h" } }),
      created.res,
    );
    expect(created.captured.status).toBe(201);

    const listed = fakeResponse();
    await route.handler(fakeRequest("127.0.0.1", "GET"), listed.res);
    expect(listed.captured.status).toBe(200);
    expect((listed.captured.body as { sessions: unknown[] }).sessions).toHaveLength(1);
  });

  it("rejects an invalid profile body", async () => {
    const route = routeFor(UNITERMINAL_ROUTES.sessions);
    const response = fakeResponse();
    await route.handler(fakeRequest("127.0.0.1", "POST", { profile: { id: 1 } }), response.res);
    expect(response.captured.status).toBe(400);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run test/routes.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

```ts
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionManager } from "./engine/session-manager.js";
import type { ProtocolKind, ResolvedProfile } from "./engine/types.js";

export interface WebRouteLike {
  kind: "exact" | "prefix";
  path: string;
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;
}

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const PROTOCOLS = new Set<ProtocolKind>(["ssh", "local", "telnet", "serial"]);

export const UNITERMINAL_ROUTES = {
  health: "/api/uniterminal/health",
  sessions: "/api/uniterminal/sessions",
  wsPrefix: "/api/uniterminal/ws",
} as const;

export function isLoopback(address: string | undefined): boolean {
  return address !== undefined && LOOPBACK_ADDRESSES.has(address);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function parseProfile(input: unknown): ResolvedProfile {
  const profile = (input as { profile?: unknown } | null)?.profile as Record<string, unknown> | undefined;
  if (profile === null || typeof profile !== "object") throw new TypeError("profile is required");
  const { id, kind } = profile;
  if (typeof id !== "string" || id.length === 0) throw new TypeError("profile.id must be a non-empty string");
  if (typeof kind !== "string" || !PROTOCOLS.has(kind as ProtocolKind)) {
    throw new TypeError("profile.kind must be one of ssh|local|telnet|serial");
  }
  return profile as unknown as ResolvedProfile;
}

export function createRoutes(manager: SessionManager): WebRouteLike[] {
  return [
    {
      kind: "exact",
      path: UNITERMINAL_ROUTES.health,
      handler: (req, res) => {
        if (!isLoopback(req.socket.remoteAddress)) {
          sendJson(res, 403, { error: "forbidden" });
          return;
        }
        sendJson(res, 200, { ok: true });
      },
    },
    {
      kind: "exact",
      path: UNITERMINAL_ROUTES.sessions,
      handler: async (req, res) => {
        if (!isLoopback(req.socket.remoteAddress)) {
          sendJson(res, 403, { error: "forbidden" });
          return;
        }
        if (req.method === "GET") {
          sendJson(res, 200, { sessions: manager.list() });
          return;
        }
        if (req.method !== "POST") {
          sendJson(res, 405, { error: "method not allowed" });
          return;
        }
        let profile: ResolvedProfile;
        try {
          profile = parseProfile(await readJson(req));
        } catch (error) {
          sendJson(res, 400, { error: String(error) });
          return;
        }
        try {
          sendJson(res, 201, { session: await manager.open(profile) });
        } catch (error) {
          sendJson(res, 500, { error: String(error) });
        }
      },
    },
  ];
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run test/routes.test.ts`
Expected: 4 passed

- [ ] **Step 5: 提交**

```bash
git add src/routes.ts test/routes.test.ts
git commit -m "feat: loopback-fenced http routes (M0-6)"
```

---

### Task 7: 宿主插件入口

**Files:**
- Create: `src/config.ts`, `src/index.ts`
- Test: `test/index.test.ts`

**Interfaces:**
- Consumes: `TransportRegistry`、`SessionManager`、`createSshTransport`、`loadSshClientFactory`、`createRoutes`
- Produces: cordis 三件套 `export const name = "uniterminal"`、`export const inject = ["webServer"]`、`export function apply(ctx, config): void`、`export const Config`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest";
import { apply, inject, name } from "../src/index.js";

function fakeContext(options: { throwOnRegister?: boolean } = {}) {
  const registered: string[] = [];
  const ctx: any = {
    logger: { warn: () => {} },
    webServer: {
      register(route: { path: string }) {
        if (options.throwOnRegister === true) throw new Error("route clash");
        registered.push(route.path);
        return () => {};
      },
    },
    effect(run: () => (() => void) | void) {
      run();
    },
  };
  return { ctx, registered };
}

const config = { bufferBytes: 1024, term: "xterm-256color", connectTimeoutMs: 1000 };

describe("uniterminal plugin", () => {
  it("declares its cordis identity", () => {
    expect(name).toBe("uniterminal");
    expect(inject).toContain("webServer");
  });

  it("registers its routes", async () => {
    const { ctx, registered } = fakeContext();
    apply(ctx, config);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(registered).toContain("/api/uniterminal/health");
  });

  it("never throws when the host refuses a route", async () => {
    const { ctx } = fakeContext({ throwOnRegister: true });
    expect(() => apply(ctx, config)).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run test/index.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 写 `src/config.ts`**

```ts
import { Schema } from "@deepseek-ai/schemastery";

export interface Config {
  bufferBytes: number;
  term: string;
  connectTimeoutMs: number;
}

export const Config: Schema<Config> = Schema.object({
  bufferBytes: Schema.number().default(1 << 20).description("每个会话保留的输出字节数"),
  term: Schema.string().default("xterm-256color").description("SSH 终端类型"),
  connectTimeoutMs: Schema.number().default(20000).description("连接超时（毫秒）"),
});
```

若 `@deepseek-ai/schemastery` 的实际导出名不是 `Schema`，以 `node_modules/@deepseek-ai/schemastery/lib/index.d.ts` 为准调整——不要猜。

- [ ] **Step 4: 写 `src/index.ts`**

```ts
import type { Context } from "@deepseek-ai/cordis";
import type { Config } from "./config.js";
import { TransportRegistry } from "./engine/registry.js";
import { SessionManager } from "./engine/session-manager.js";
import { createSshTransport, loadSshClientFactory } from "./engine/ssh-transport.js";
import { createRoutes } from "./routes.js";

export { Config } from "./config.js";
export const name = "uniterminal";
export const inject = ["webServer"];

export function apply(ctx: Context, config: Config): void {
  const registry = new TransportRegistry();
  const manager = new SessionManager(registry, { bufferBytes: config.bufferBytes });

  ctx.effect(() => {
    let disposed = false;
    const disposers: (() => void)[] = [];

    void (async () => {
      try {
        const factory = await loadSshClientFactory();
        if (disposed) return;
        registry.register(
          createSshTransport(factory, { term: config.term, connectTimeoutMs: config.connectTimeoutMs }),
        );
      } catch (error) {
        ctx.logger?.warn?.("uniterminal: ssh transport unavailable: %s", String(error));
      }

      for (const route of createRoutes(manager)) {
        try {
          if (disposed) return;
          disposers.push(ctx.webServer.register(route as never));
        } catch (error) {
          ctx.logger?.warn?.("uniterminal: route %s not registered: %s", route.path, String(error));
        }
      }
    })();

    return () => {
      disposed = true;
      for (const dispose of disposers.splice(0)) dispose();
    };
  });
}
```

- [ ] **Step 5: 运行确认通过**

Run: `pnpm vitest run test/index.test.ts`
Expected: 3 passed

- [ ] **Step 6: 提交**

```bash
git add src/config.ts src/index.ts test/index.test.ts
git commit -m "feat: host-side cordis plugin entry (M0-7)"
```

---

### Task 8: 双面包打包

**Files:**
- Create: `cordis.patch.yml`, `tsdown.config.ts`
- Modify: `package.json`（已含 `dsh` 字段，此步只校验）

**Interfaces:**
- Consumes: `src/index.ts`（Task 7）、`src/client/index.ts`（Task 9/10 产出，先建占位）
- Produces: `lib/index.js`（宿主半边）、`lib/client.js`（浏览器半边，`__ModuleLoader__` 包裹）

- [ ] **Step 1: 写 `cordis.patch.yml`**

```yaml
- insert:
    - id: uniterminal
      name: "@winking-r/dsh-uniterminal"
```

- [ ] **Step 2: 抄一份客户端包裹格式（不要自创）**

Run: `head -5 "C:/Users/<you>/.dsh/profiles/desktop/node_modules/@linxin666/dsh-ssh/lib/client.js"`
Expected: 看到 `window.__ModuleLoader__.load({ ... , factory: ... })` 形式的首行

把该首行/末行的包裹写法逐字记下来——tsdown 的 `outputOptions.banner` / `footer` 必须产出**同一个形状**，否则 `dsh-client-modules` 不认。

- [ ] **Step 3: 写 `tsdown.config.ts`**

```ts
import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: "esm",
    platform: "node",
    outDir: "lib",
    external: ["ssh2", "ws", "@deepseek-ai/cordis", "@deepseek-ai/schemastery"],
  },
  {
    entry: { client: "src/client/index.ts" },
    format: "iife",
    platform: "browser",
    outDir: "lib",
    external: ["react", "react/jsx-runtime", "@deepseek-ai/dsh-client-ui-primitives"],
    outputOptions: {
      // 形状必须与 Step 2 抄下来的完全一致
      banner: "window.__ModuleLoader__.load({ id: \"uniterminal\", factory: () => {",
      footer: "return module.exports; } });",
    },
  },
]);
```

- [ ] **Step 4: 建客户端占位入口**

```ts
export function apply(): void {
  // Task 9 / Task 10 填充
}
```

- [ ] **Step 5: 构建并验证两个产物**

Run: `pnpm build`
Expected: 生成 `lib/index.js` 与 `lib/client.js`

Run: `node -e "const m=require('./lib/index.js');console.log(m.name,typeof m.apply)"`
Expected: `uniterminal function`

Run: `head -1 lib/client.js`
Expected: 以 `window.__ModuleLoader__.load({` 开头

- [ ] **Step 6: 提交**

```bash
git add cordis.patch.yml tsdown.config.ts src/client/index.ts package.json
git commit -m "build: dual-face bundle with module-loader wrapper (M0-8)"
```

---

### Task 9: 右栏双注册表探测

**Files:**
- Create: `src/client/right-pane.ts`
- Test: `test/client/right-pane.test.ts`

**Interfaces:**
- Consumes: 无（纯函数，不 import React，因此可在 node 环境测）
- Produces:
  - `type RightPaneTarget = "betterSidebar" | "sidebarRightTabs" | "none"`
  - `detectRightPane(ctx: Record<string, unknown>): RightPaneTarget`
  - `interface TabDescriptor { id: string; title: () => string; component: unknown }`
  - `registerTab(ctx, tab: TabDescriptor): { ok: boolean; target: RightPaneTarget; error?: string }`

- [ ] **Step 1: 写失败测试**

```ts
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
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run test/client/right-pane.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

```ts
export type RightPaneTarget = "betterSidebar" | "sidebarRightTabs" | "none";

export interface TabDescriptor {
  id: string;
  title: () => string;
  component: unknown;
}

export interface RegistrationResult {
  ok: boolean;
  target: RightPaneTarget;
  error?: string;
}

export function detectRightPane(ctx: Record<string, unknown>): RightPaneTarget {
  const better = ctx["betterSidebar"] as { registerTab?: unknown } | undefined;
  if (typeof better?.registerTab === "function") return "betterSidebar";
  const official = ctx["sidebarRightTabs"] as { register?: unknown } | undefined;
  if (typeof official?.register === "function") return "sidebarRightTabs";
  return "none";
}

export function registerTab(ctx: Record<string, unknown>, tab: TabDescriptor): RegistrationResult {
  const target = detectRightPane(ctx);
  try {
    if (target === "betterSidebar") {
      const better = ctx["betterSidebar"] as { registerTab(input: unknown): void };
      better.registerTab({ id: tab.id, title: tab.title, component: tab.component });
      return { ok: true, target };
    }
    if (target === "sidebarRightTabs") {
      const official = ctx["sidebarRightTabs"] as { register(input: unknown): void };
      official.register({ id: tab.id, kind: "terminal", multiple: true, title: tab.title });
      return { ok: true, target };
    }
    return { ok: false, target, error: "no right-pane registry available" };
  } catch (error) {
    return { ok: false, target, error: String(error) };
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run test/client/right-pane.test.ts`
Expected: 6 passed

- [ ] **Step 5: 提交**

```bash
git add src/client/right-pane.ts test/client/right-pane.test.ts
git commit -m "feat: dual right-pane registry probe with degradation (M0-9)"
```

---

### Task 10: 终端视图与右栏 Tab

**Files:**
- Create: `src/client/TerminalView.tsx`, `src/client/UniterminalTab.tsx`, `src/client/tab.module.css`
- Modify: `src/client/index.ts`

**Interfaces:**
- Consumes: `registerTab`（Task 9）、`/api/uniterminal/*`（Task 6）
- Produces: `export function apply(ctx: Record<string, unknown>): void`（浏览器半边入口，永不抛错）

**测试说明（对本计划 TDD 规则的显式例外）：** M0 不引入 jsdom 与组件测试框架，`TerminalView` / `UniterminalTab` 的验收由 Task 11 的端到端人工验收覆盖。理由：xterm 需要真实渲染上下文，M0 阶段用组件单测的收益低于成本。M1 起为 UI 引入 `@testing-library/react` + jsdom。

- [ ] **Step 1: 写 `TerminalView.tsx`**

```tsx
import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

export interface TerminalViewProps {
  sessionId: string;
  onNotice: (message: string) => void;
}

export function TerminalView({ sessionId, onNotice }: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    const terminal = new Terminal({ convertEol: true, scrollback: 5000, fontFamily: "monospace" });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    fit.fit();
    terminal.focus();

    const socket = new WebSocket(
      "ws://127.0.0.1:" + String(location.port || "0") + "/api/uniterminal/ws/" + sessionId,
    );

    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as { type: string; data?: string };
      if (message.type === "data" && message.data !== undefined) {
        terminal.write(Uint8Array.from(atob(message.data), (char) => char.charCodeAt(0)));
      }
    };
    socket.onerror = () => onNotice("终端连接失败");
    socket.onclose = () => onNotice("终端连接已断开");

    const dataSubscription = terminal.onData((chunk) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "input", data: chunk }));
      }
    });
    const resizeSubscription = terminal.onResize(({ cols, rows }) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "resize", cols, rows }));
      }
    });
    const onWindowResize = () => fit.fit();
    window.addEventListener("resize", onWindowResize);

    return () => {
      window.removeEventListener("resize", onWindowResize);
      dataSubscription.dispose();
      resizeSubscription.dispose();
      socket.close();
      terminal.dispose();
    };
  }, [sessionId, onNotice]);

  return <div ref={hostRef} className="uniterminal-terminal" />;
}
```

- [ ] **Step 2: 写 `UniterminalTab.tsx`**

```tsx
import { useState } from "react";
import { TerminalView } from "./TerminalView.js";

export function UniterminalTab() {
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [host, setHost] = useState("127.0.0.1");
  const [user, setUser] = useState("root");
  const [port, setPort] = useState("22");

  async function connect() {
    setNotice(undefined);
    const response = await fetch("/api/uniterminal/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: { id: host, kind: "ssh", host, user, port: Number(port) } }),
    });
    if (!response.ok) {
      setNotice("连接失败：" + String((await response.json()).error));
      return;
    }
    const payload = (await response.json()) as { session: { id: string } };
    setSessionId(payload.session.id);
  }

  if (sessionId !== undefined) {
    return (
      <div className="uniterminal-pane">
        {notice !== undefined && <div className="uniterminal-notice">{notice}</div>}
        <TerminalView sessionId={sessionId} onNotice={setNotice} />
      </div>
    );
  }

  return (
    <div className="uniterminal-pane">
      <p className="uniterminal-hint">M0 骨架：直连一台 SSH 主机（凭据在 M2 接入保险库）</p>
      <label>主机<input value={host} onChange={(event) => setHost(event.target.value)} /></label>
      <label>用户<input value={user} onChange={(event) => setUser(event.target.value)} /></label>
      <label>端口<input value={port} onChange={(event) => setPort(event.target.value)} /></label>
      <button onClick={() => void connect()}>连接</button>
      {notice !== undefined && <div className="uniterminal-notice">{notice}</div>}
    </div>
  );
}
```

- [ ] **Step 3: 写 `src/client/index.ts`**

```ts
import { UniterminalTab } from "./UniterminalTab.js";
import { registerTab } from "./right-pane.js";

export const TAB_ID = "uniterminal";

export function apply(ctx: Record<string, unknown>): void {
  try {
    const result = registerTab(ctx, {
      id: TAB_ID,
      title: () => "UniTerminal",
      component: UniterminalTab,
    });
    if (!result.ok) {
      ctx["logger"] = ctx["logger"] ?? console;
      (ctx["logger"] as Console).warn("uniterminal: right pane unavailable (" + result.target + "): " + String(result.error));
    }
  } catch (error) {
    console.warn("uniterminal: apply failed without breaking the shell:", error);
  }
}
```

- [ ] **Step 4: 构建验证**

Run: `pnpm build`
Run: `head -1 lib/client.js`
Expected: 含 `__ModuleLoader__`

Run: `pnpm typecheck`
Expected: 退出码 0

- [ ] **Step 5: 提交**

```bash
git add src/client
git commit -m "feat: right-pane terminal tab with xterm view (M0-10)"
```

---

### Task 11: 端到端手动验收

**Files:**
- Create: `README.md`（安装步骤）
- Modify: 无

**Interfaces:**
- Consumes: Task 8 的 `lib/*`、Task 10 的客户端包
- Produces: 可复现的安装步骤；M0 出口判据

- [ ] **Step 1: 注册进 profile**

```bash
# 1) 把包链进 profile 的 node_modules
cd "C:/Users/<you>/.dsh/profiles/desktop"
pnpm add "file:E:/DeepSeekWS/codingWork/dsh-Uniterminal"
# 2) 在 profile 的 dsh.profile.bundles 末尾追加 "@winking-r/dsh-uniterminal"
```

Expected: `package.json` 的 `dsh.profile.bundles` 出现该包名

- [ ] **Step 2: 重启 DSH Host 并检查插件已挂载**

Run: 重启 Host 后打开 `http://127.0.0.1:57760`
Expected: web shell 正常启动（**没有白屏**——若白屏说明 `apply` 抛错了）

- [ ] **Step 3: 验收右栏 tab**

Expected: 右栏出现 `UniTerminal` tab；若没出现，打开控制台看 `uniterminal: right pane unavailable ...` 告警并记录探测到的 `target`

- [ ] **Step 4: 验收交互**

在一个可 SSH 的测试主机上填 主机/用户/端口 → 连接
Expected: 终端出现提示符；输入 `ls` 有回显；拖动窗口大小后 `stty size` 随之变化

- [ ] **Step 5: 验收失败隔离**

临时把 `package.json` 的 `dsh.bundle.patch` 改成不存在的路径并重启
Expected: 启动失败信息指向该文件，而不是白屏崩溃；恢复后正常

- [ ] **Step 6: 提交**

```bash
git add README.md
git commit -m "docs: install steps and M0 acceptance checklist (M0-11)"
```

---

## Self-Review（已执行）

**1. 规格覆盖**：M0 出口要求"双面包 / cordis 挂载 / 右栏双注册探测 / 一个 SSH 会话可交互"——分别落在 Task 8、Task 7、Task 9、Task 4+5+6+10+11。PRD M0-1~M0-11 全覆盖。

**2. 占位符扫描**：无 TBD / TODO / "实现剩余部分"。Task 8 Step 2 要求"抄一份真实包裹格式"而非写 "`TBD`"，因为该格式无法凭空断言，必须由本机产物决定——这是探明而非遗留。

**3. 类型一致性**：`RingBuffer.since` 的返回形状在 Task 2 定义、Task 5 直接复用；`SessionInfo` 在 Task 5 定义、Task 6 的响应体沿用；`TabDescriptor` 在 Task 9 定义、Task 10 消费。`onData`/`onClose` 在 Task 3 定型后未被改名。

**已知待核**：`@deepseek-ai/cordis` 的 `Context` 类型路径、`schemastery` 导出名、`__ModuleLoader__` 包裹形状——三者均已在计划里指定"读本机产物为准"，实施时必须先读再写。

---

### Task 12: WebSocket 终端桥（M0 计划缺陷补丁）

**为什么有这个任务**：Task 6 只分配了 HTTP 路由，`UNITERMINAL_ROUTES.wsPrefix` 被声明却没有任何升级处理器；而 Task 10 的 `TerminalView` 会连 `/api/uniterminal/ws/:id`。缺这一步，M0 出口判据「可交互终端」不可能达成。这是计划缺陷，不是实现遗漏。

**Files:**
- Create: `src/ws-bridge.ts`, `test/ws-bridge.test.ts`
- Modify: `src/index.ts`（注册升级路由，仍须 try/catch 且 apply 永不抛错）

**Interfaces:**
- Produces: `parseSessionId(url: string): string | undefined`；`toClientMessage(chunk: Uint8Array): string`；`createWsBridge(options: { manager: SessionManager; upgrade: (req, socket, head) => void }): void`；`attachWsServer(options: { manager; server: import("node:http").Server }): { close(): Promise<void> }`
- Consumes: `SessionManager.read/write/resize/subscribe`、`isLoopback`

**协议（与 Task 10 的客户端严格对齐）**
- 服务端 → 客户端：`{"type":"data","data":"<base64>"}`、`{"type":"close","reason":"..."}`
- 客户端 → 服务端：`{"type":"input","data":"<utf8 字符串>"}`、`{"type":"resize","cols":number,"rows":number}`

- [ ] **Step 1: 先写失败测试（含真实 http + ws 的集成用例）**

```ts
// test/ws-bridge.test.ts（要点）
// 1) parseSessionId("/api/uniterminal/ws/s1?x=1") === "s1"；非该前缀 → undefined
// 2) toClientMessage(new Uint8Array([104,105])) 解出的 data 经 atob 还原为 "hi"
// 3) 集成：http.createServer() + attachWsServer({manager})，注册一个 stub TransportAdapter，
//    POST 不必走 HTTP——直接 manager.open() 拿 sessionId；再用 ws 客户端连 ws://127.0.0.1:<port>/api/uniterminal/ws/<sid>，断言：
//    a. 客户端发 input → stub handle.write 收到对应字节
//    b. stub 推一段输出 → 客户端收到 type=data 且 base64 还原一致
//    c. 客户端发 resize(120,40) → handle.resize 收到 (120,40)
//    d. 非回环来源被拒（用 socket 伪造 remoteAddress 或直接单测 isLoopback 分支）
//    e. 客户端断开后，session 仍存活（manager.list() 长度不变）
```

- [ ] **Step 2: 运行确认失败** `pnpm vitest run test/ws-bridge.test.ts` → FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/ws-bridge.ts`**
  - 用 `new WebSocketServer({ noServer: true })`；升级时必须先过 `isLoopback(req.socket.remoteAddress)`，否则 `socket.destroy()`
  - 升级路由的 `kind` 与 path 形状必须**读 `dsh-host-webserver` 的 registerUpgrade（lib/index.js:340-346）后照抄**，不要猜
  - 连接建立后先用 `manager.read(id, 0)` 回放已有缓冲，再 `subscribe` 增量推送
  - 断开只 `unsubscribe`，**不 close session**

- [ ] **Step 4: 运行确认通过**

- [ ] **Step 5: 在 `src/index.ts` 注册升级路由**，沿用既有 try/catch 与 disposer 模式；`registerUpgrade` 不存在或抛错时只告警

- [ ] **Step 6: 提交** `feat: websocket terminal bridge (M0-12)`

**验收**：新增用例全绿；`typecheck` 0；`build` 0；`lib/client.js` 与 `lib/index.js` 均可装载；`apply` 在 `registerUpgrade` 缺失时仍不抛错。
