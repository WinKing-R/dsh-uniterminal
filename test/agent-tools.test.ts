import { describe, expect, it, vi } from "vitest";
import {
  createAgentTools,
  createSessionExec,
  registerAgentTools,
  type AgentToolDefinition,
  type AgentToolsContext,
  type ExecMode,
  type ExecOutcome,
  type ExecRequest,
  type ExecRunner,
  type ExecSessionSource,
} from "../src/agent-tools.js";
import type { ExecResult } from "../src/engine/types.js";
import { apply } from "../src/index.js";
import type { PluginContext } from "../src/index.js";

/**
 * 诊断默认静默（见 host-diag 的 SILENT）：这里接管调用记录，
 * 「缺 tools 服务时必须留痕」这条断言才看得见真实入参。
 */
const diagCalls = vi.hoisted(() => [] as { event: string; data?: Record<string, unknown> }[]);

vi.mock("../src/host-diag.js", () => ({
  diag: (event: string, data?: Record<string, unknown>) => {
    diagCalls.push({ event, data });
  },
}));

const events = (): string[] => diagCalls.map((call) => call.event);

const neverRan: ExecRunner = async () => {
  throw new Error("exec must not run in this test");
};

const OK_RESULT: ExecResult = { stdout: "", stderr: "", code: 0, truncated: false, timedOut: false };

function session(id: string, extra: { host?: string; user?: string; port?: number; status?: "open" | "closed" } = {}) {
  return {
    id,
    kind: "ssh" as const,
    capabilities: { exec: true, sftp: true, tunnel: true, resize: true },
    createdAt: 1,
    status: extra.status ?? ("open" as const),
    host: extra.host ?? "192.0.2.10",
    user: extra.user ?? "deploy",
    port: extra.port ?? 22,
  };
}

const toolNamed = (tools: AgentToolDefinition[], name: string): AgentToolDefinition => {
  const found = tools.find((tool) => tool.name === name);
  if (found === undefined) throw new Error("tool missing: " + name);
  return found;
};

/** shell 会怎么解释这一行：`echo "x"` 回 x，其余回 ran:<命令行>。 */
function shellOutputOf(line: string): string {
  const quoted = /^echo "(.*)"$/.exec(line);
  if (quoted !== null) return quoted[1] ?? "";
  const bare = /^echo (.*)$/.exec(line);
  if (bare !== null) return bare[1] ?? "";
  return "ran:" + line;
}

interface TtyOptions {
  /** 提示符（可带 ANSI）；空字符串就是不打提示符的干净终端。 */
  prompt?: string;
  /** 是否回显输入；关掉即 stty -echo：提示符会直接粘在输出前面。 */
  echoInput?: boolean;
  /** false = 只回显不执行：模拟「命令还没跑完」。 */
  execute?: boolean;
  /** 行尾风格；mixed 交替发 CRLF 与单独的 CR。 */
  newline?: "\r\n" | "\n" | "mixed";
  /** 输出行套一层 ANSI 颜色：真实 tty 的输出常带颜色转义。 */
  color?: boolean;
  /** 非 echo 命令行（即被测命令本身）的输出；标记行的输出永远由 shellOutputOf 产出。 */
  output?: (line: string) => string;
  /** 已打开的会话 id；空数组就是「没有会话」。 */
  sessions?: string[];
}

/**
 * 假终端：write 进来的每一行按真实 tty 的样子回显（提示符 + 命令行 + 可能的 ANSI），
 * 再按 shell 的执行结果输出。回显是这里必须演的——不算回显就测不出
 * 「echo \"<标记>\" 自己会不会把标记混进输出」。
 */
function fakeTty(options: TtyOptions = {}) {
  const prompt = options.prompt ?? "";
  const echoInput = options.echoInput ?? true;
  const execute = options.execute ?? true;
  const style = options.newline ?? "\r\n";
  const ids = options.sessions ?? ["s1"];
  // 标记行的输出必须由 shellOutputOf 自己产出：被 output 接管就等于标记从未出现
  const outputOf = (line: string): string =>
    options.output !== undefined && !line.startsWith("echo ") ? options.output(line) : shellOutputOf(line);
  const listeners = new Set<(chunk: Uint8Array) => void>();
  const writes: string[] = [];
  const execs: string[] = [];
  const encoder = new TextEncoder();
  let emitted = 0;
  const newline = (): string => {
    emitted += 1;
    if (style !== "mixed") return style;
    return emitted % 2 === 1 ? "\r\n" : "\r";
  };
  const emit = (text: string): void => {
    for (const listener of [...listeners]) listener(encoder.encode(text));
  };
  const source: ExecSessionSource = {
    list: () => ids.map((id) => session(id)),
    exec: async (_id, command) => {
      execs.push(command);
      return OK_RESULT;
    },
    write: (_id, chunk) => {
      const text = new TextDecoder().decode(chunk);
      writes.push(text);
      for (const line of text.split("\n").filter((item) => item !== "")) {
        if (echoInput) emit(prompt + line + newline());
        if (!execute) continue;
        const output = outputOf(line);
        const painted = options.color === true ? "\u001B[32m" + output + "\u001B[0m" : output;
        emit((echoInput ? "" : prompt) + painted + newline());
      }
    },
    subscribe: (_id, listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  return { source, writes, execs };
}

describe("uniterminal_list_sessions (M5-1)", () => {
  it("lists the non-sensitive fields the model needs to pick a session", async () => {
    const tools = createAgentTools({ sessions: () => [session("s1", { host: "192.0.2.10", user: "deploy", port: 2222 })], exec: neverRan });
    const list = toolNamed(tools, "uniterminal_list_sessions");

    // 无参数工具：Schema 必须显式关掉额外字段，模型才不会先编一个参数出来
    expect(list.parameters).toEqual({ type: "object", additionalProperties: false, properties: {} });
    expect(list.parameters.required).toBeUndefined();

    const value = await list.execute({}, {});
    expect(value).toEqual({
      ok: true,
      count: 1,
      sessions: [
        {
          id: "s1",
          // M9-27：给人看的标签 + 打开时间，模型才有东西问用户"是哪个窗口"
          label: "deploy@192.0.2.10:2222",
          host: "192.0.2.10",
          user: "deploy",
          port: 2222,
          openedAt: "1970-01-01T00:00:00.001Z",
          status: "open",
        },
      ],
    });

    const rendered = list.output.render({}, value);
    expect(rendered).toHaveLength(1);
    expect(rendered[0]?.type).toBe("text");
    // 模型看到的就是这段文本：与返回值逐字节一致，不另做包装
    expect(rendered[0]?.text).toBe(JSON.stringify(value));
    expect(rendered[0]?.text).toContain("192.0.2.10");
  });
});

describe("uniterminal_exec (M5-1)", () => {
  it("auto-selects the only session and returns the command result", async () => {
    const calls: ExecRequest[] = [];
    const exec: ExecRunner = async (request) => {
      calls.push(request);
      return { mode: request.mode, stdout: "Linux host\n", stderr: "", code: 0, truncated: false, timedOut: false, ms: 3 };
    };
    const tools = createAgentTools({ sessions: () => [session("s1")], exec });

    const value = await toolNamed(tools, "uniterminal_exec").execute({ command: "uname -a" }, {});

    expect(calls).toEqual([{ sessionId: "s1", command: "uname -a", mode: "exec", timeoutMs: undefined }]);
    expect(value).toMatchObject({ ok: true, sessionId: "s1", mode: "exec", stdout: "Linux host\n", code: 0 });
  });

  it("passes an explicit sessionId, mode and timeout through", async () => {
    const calls: ExecRequest[] = [];
    const exec: ExecRunner = async (request) => {
      calls.push(request);
      return { mode: request.mode, stdout: "", stderr: "", code: null, truncated: false, timedOut: false, ms: 1 };
    };
    const tools = createAgentTools({ sessions: () => [session("s1"), session("s2")], exec });

    const value = await toolNamed(tools, "uniterminal_exec").execute(
      { command: "whoami", sessionId: "s2", mode: "shell", timeoutMs: 1500 },
      {},
    );

    expect(calls).toEqual([{ sessionId: "s2", command: "whoami", mode: "shell", timeoutMs: 1500 }]);
    expect(value).toMatchObject({ ok: true, sessionId: "s2", mode: "shell", code: null });
  });

  it("answers with the candidate sessions when several are open and none was chosen", async () => {
    const tools = createAgentTools({
      sessions: () => [session("s1", { host: "a.example.com" }), session("s2", { host: "b.example.com" })],
      exec: neverRan,
    });

    const value = (await toolNamed(tools, "uniterminal_exec").execute({ command: "id" }, {})) as Record<string, unknown>;

    expect(value.ok).toBe(false);
    expect(String(value.message)).toContain("sessionId");
    expect(value.sessions).toEqual([
      {
        id: "s1",
        label: "deploy@a.example.com:22",
        host: "a.example.com",
        user: "deploy",
        port: 22,
        openedAt: "1970-01-01T00:00:00.001Z",
        status: "open",
      },
      {
        id: "s2",
        label: "deploy@b.example.com:22",
        host: "b.example.com",
        user: "deploy",
        port: 22,
        openedAt: "1970-01-01T00:00:00.001Z",
        status: "open",
      },
    ]);
    // M9-27：不要让模型去猜，明确要求"问用户哪个窗口"
    expect(String(value.message)).toMatch(/ask|do NOT guess/i);
  });

  it("numbers duplicate endpoints so two windows are told apart (M9-27)", async () => {
    const tools = createAgentTools({
      // 同一台主机开两个会话：除 id 外完全一样，用户实报"模型分不清哪个窗口"
      sessions: () => [session("s2", { host: "same.example.com" }), session("s1", { host: "same.example.com" })],
      exec: neverRan,
    });

    const value = (await toolNamed(tools, "uniterminal_exec").execute({ command: "id" }, {})) as Record<string, unknown>;
    const listed = value.sessions as { id: string; label: string }[];

    // 按打开顺序编号（createdAt 相同则按入参顺序稳定），第二个带 #2
    expect(listed.map((item) => item.id)).toEqual(["s2", "s1"]);
    expect(listed.map((item) => item.label)).toEqual(["deploy@same.example.com:22", "deploy@same.example.com:22 #2"]);
  });

  it("tells the model what to do when no session is open, and rejects an empty command", async () => {
    const none = createAgentTools({ sessions: () => [], exec: neverRan });
    const noSession = (await toolNamed(none, "uniterminal_exec").execute({ command: "id" }, {})) as Record<string, unknown>;
    expect(noSession.ok).toBe(false);
    expect(String(noSession.message)).toContain("session");

    const one = createAgentTools({ sessions: () => [session("s1")], exec: neverRan });
    const blank = (await toolNamed(one, "uniterminal_exec").execute({ command: "   " }, {})) as Record<string, unknown>;
    expect(blank.ok).toBe(false);
    expect(String(blank.message)).toContain("command");
  });
});

describe("uniterminal_exec description (M5-4)", () => {
  const description = toolNamed(
    createAgentTools({ sessions: () => [session("s1")], exec: neverRan }),
    "uniterminal_exec",
  ).description;

  it("tells the model to prefer exec and that shell leaves its markers on the user's screen", () => {
    const lower = description.toLowerCase();
    // ① 优先 exec：默认、无副作用、不碰用户终端
    expect(lower).toContain("prefer mode=exec");
    expect(lower).toContain("never touches the user's terminal");
    // ② shell 只用于延续交互 shell 自己的状态
    expect(lower).toContain("only when the command must continue the interactive shell");
    // ③ shell 的可见副作用，以及「不要为了让用户看见输出而选它」
    expect(lower).toContain("typed into the terminal the user is watching");
    expect(lower).toContain("never pick shell just to make the output visible");
    // ④ M5-4：标记行就留在用户正在看的终端里——工具不再承诺擦屏
    expect(lower).toContain("marker commands");
    expect(lower).toContain("echoed there too");
    expect(lower).toContain("stay on the user's screen");
    expect(lower).not.toContain("erase");
    expect(description).not.toContain("擦除");
  });
});

describe("createSessionExec shell mode (M5-1)", () => {
  it("reads the output back between a random pair of markers, ignoring the echoed commands", async () => {
    const terminal = fakeTty();
    const exec = createSessionExec(terminal.source, { now: () => 1700000000000, random: () => "abc123" });

    const outcome = await exec({ sessionId: "s1", command: "uname -a", mode: "shell" });

    expect(outcome).toMatchObject({ mode: "shell", code: null, stderr: "", truncated: false, timedOut: false });
    // 回显的命令行不是输出：取回内容里只剩命令真正打印的那一行
    expect(outcome.stdout).toBe("ran:uname -a\n");
    // 标记是我们自己的输入：既不能出现在取回的内容里，也必须带时间戳+随机串
    expect(outcome.stdout).not.toContain("__UT_");
    // M8-9：三行合成**一次**写入（避免三次小包各自等 ACK），这里比对整块内容
    expect(terminal.writes).toEqual([
      "echo __UT_BEGIN_1700000000000_abc123__\nuname -a\necho __UT_END_1700000000000_abc123__\n",
    ]);

  });

  it("draws a fresh marker pair for every run", async () => {
    const terminal = fakeTty();
    const exec = createSessionExec(terminal.source);

    await exec({ sessionId: "s1", command: "id", mode: "shell" });
    await exec({ sessionId: "s1", command: "id", mode: "shell" });

    expect(terminal.writes).toHaveLength(2);
    expect(terminal.writes[0]).not.toBe(terminal.writes[1]);
  });

  it("refuses an unknown session with a typed reason", async () => {
    const terminal = fakeTty({ sessions: [] });
    const exec = createSessionExec(terminal.source);

    await expect(exec({ sessionId: "s404", command: "id", mode: "shell" })).rejects.toMatchObject({
      reason: "unknown-session",
    });
    expect(terminal.writes).toEqual([]);
  });
});

describe("createSessionExec shell mode marker parsing (M5-2)", () => {
  const clock = { now: () => 1700000000000, random: () => "abc123" };

  it("parses a prompt-and-ANSI decorated tty stream", async () => {
    // 真机输出：提示符拼在回显行前，输出行还套着颜色转义
    const terminal = fakeTty({ prompt: "\u001B[32mroot@localhost:~# \u001B[0m", color: true, output: () => "/tmp" });
    const exec = createSessionExec(terminal.source, clock);

    const outcome = await exec({ sessionId: "s1", command: "cd /tmp && pwd", mode: "shell", timeoutMs: 200 });

    expect(outcome.timedOut).toBe(false);
    expect(outcome.stdout).toBe("/tmp\n");
  });

  it("never mistakes the echoed echo-marker line for the marker itself", async () => {
    // 只回显不执行：若回显行被当成标记，这次调用会立刻返回；正确行为是等到超时
    const terminal = fakeTty({ prompt: "root@localhost:~# ", execute: false });
    const exec = createSessionExec(terminal.source, clock);

    const outcome = await exec({ sessionId: "s1", command: "sleep 30", mode: "shell", timeoutMs: 60 });

    expect(outcome.timedOut).toBe(true);
    expect(outcome.stdout).toBe("");
  });

  it("normalises CRLF and bare CR before matching", async () => {
    const terminal = fakeTty({ prompt: "root@x:~$ ", newline: "mixed" });
    const exec = createSessionExec(terminal.source, clock);

    const outcome = await exec({ sessionId: "s1", command: "id -u", mode: "shell", timeoutMs: 200 });

    expect(outcome.timedOut).toBe(false);
    expect(outcome.stdout).toBe("ran:id -u\n");
  });

  it("splits the markers when the terminal glues them to the prompt on one line", async () => {
    // stty -echo：输入不回显，提示符直接粘在标记与输出前面
    const terminal = fakeTty({ prompt: "root@x:~# ", echoInput: false, output: () => "/tmp" });
    const exec = createSessionExec(terminal.source, clock);

    const outcome = await exec({ sessionId: "s1", command: "cd /tmp && pwd", mode: "shell", timeoutMs: 200 });

    expect(outcome.timedOut).toBe(false);
    expect(outcome.stdout).toBe("/tmp\n");
  });
});

describe("registerAgentTools (M5-1)", () => {
  const deps = { sessions: () => [session("s1")], exec: neverRan };

  const serviceInto = (registered: string[]): { register: (tool: AgentToolDefinition) => () => void } => ({
    register: (tool) => {
      registered.push(tool.name);
      return () => {};
    },
  });

  /** 老宿主：没有 ctx.get，插件照常加载，只是看不到这两个工具。 */
  it("skips registration when the host exposes no tools service", () => {
    const labels: string[] = [];
    const ctx = {
      effect: (run: () => void, label?: string) => {
        labels.push(label ?? "");
        run();
      },
    };

    expect(registerAgentTools(ctx, deps)).toBe(0);
    expect(labels).toEqual([]);
    expect(events()).toContain("agent-tools.unavailable");
  });

  it("registers both tools through the dynamically resolved service and records it", () => {
    const registered: string[] = [];
    const ctx: AgentToolsContext = {
      get: (name: string) => (name === "tools" ? serviceInto(registered) : undefined),
      effect: (run: () => void) => {
        run();
      },
    };

    expect(registerAgentTools(ctx, deps)).toBe(2);
    expect(registered).toEqual(["uniterminal_list_sessions", "uniterminal_exec"]);
    expect(events()).toContain("agent-tools.registered");
  });

  it("never throws when the service lookup itself throws", () => {
    const ctx: AgentToolsContext = {
      get: () => {
        throw new Error('cannot get property "tools" without inject');
      },
      effect: (run: () => void) => {
        run();
      },
    };

    expect(() => registerAgentTools(ctx, deps)).not.toThrow();
    expect(registerAgentTools(ctx, deps)).toBe(0);
    expect(events()).toContain("agent-tools.unavailable");
  });

  it("never touches ctx.tools: a host that throws on that property still registers", () => {
    // 真实故障复现：cordis 对未 inject 的服务，读属性直接抛错
    const registered: string[] = [];
    const ctx: AgentToolsContext = {
      get: (name: string) => (name === "tools" ? serviceInto(registered) : undefined),
      effect: (run: () => void) => {
        run();
      },
    };
    Object.defineProperty(ctx, "tools", {
      get(): never {
        throw new Error('cannot get property "tools" without inject');
      },
    });

    expect(registerAgentTools(ctx, deps)).toBe(2);
    expect(registered).toEqual(["uniterminal_list_sessions", "uniterminal_exec"]);
  });

  it("does not register anything when the service lookup answers undefined", () => {
    const ctx: AgentToolsContext = {
      get: () => undefined,
      effect: () => {},
    };

    expect(registerAgentTools(ctx, deps)).toBe(0);
    expect(events()).toContain("agent-tools.unavailable");
  });

  it("never throws when the host refuses a registration", () => {
    const ctx: AgentToolsContext = {
      get: () => ({
        register: () => {
          throw new Error("tools service is read-only");
        },
      }),
      effect: (run: () => void) => {
        run();
      },
    };

    expect(() => registerAgentTools(ctx, deps)).not.toThrow();
    expect(registerAgentTools(ctx, deps)).toBe(0);
    expect(events()).toContain("agent-tools.failed");
  });
});

describe("apply wiring (M5-1)", () => {
  /** 真实加载路径：apply 才是「换任何会话都能用」真正生效的地方。 */
  function hostWithTools(names: string[]): PluginContext {
    return {
      logger: { warn: () => {} },
      webServer: { register: () => () => {} },
      get: (name: string) =>
        name === "tools"
          ? {
              register: (tool: AgentToolDefinition) => {
                names.push(tool.name);
                return () => {};
              },
            }
          : undefined,
      effect: (run) => {
        run();
      },
    };
  }

  it("hands both tools to a host that runs a tools service", () => {
    const names: string[] = [];
    apply(hostWithTools(names), { bufferBytes: 1024, term: "xterm-256color", connectTimeoutMs: 1000 });

    expect(names).toEqual(["uniterminal_list_sessions", "uniterminal_exec"]);
    expect(events()).toContain("agent-tools.registered");
  });

  it("registers nothing when agentExec is off", () => {
    const names: string[] = [];
    apply(hostWithTools(names), {
      bufferBytes: 1024,
      term: "xterm-256color",
      connectTimeoutMs: 1000,
      agentExec: "off",
    });

    expect(names).toEqual([]);
    expect(events()).toContain("agent-tools.disabled");
  });

  it("still loads on a host without a tools service", () => {
    const ctx: PluginContext = {
      logger: { warn: () => {} },
      webServer: { register: () => () => {} },
      effect: (run) => {
        run();
      },
    };

    expect(() => apply(ctx, { bufferBytes: 1024, term: "xterm-256color", connectTimeoutMs: 1000 })).not.toThrow();
    expect(events()).toContain("agent-tools.unavailable");
  });

  it("still loads on a host whose tools lookup throws", () => {
    const ctx: PluginContext = {
      logger: { warn: () => {} },
      webServer: { register: () => () => {} },
      get: () => {
        throw new Error('cannot get property "tools" without inject');
      },
      effect: (run) => {
        run();
      },
    };

    expect(() => apply(ctx, { bufferBytes: 1024, term: "xterm-256color", connectTimeoutMs: 1000 })).not.toThrow();
    expect(events()).toContain("agent-tools.unavailable");
  });
});

describe("shell mode writes nothing but the two markers and the command (M5-4)", () => {
  const STAMP = "1700000000000_abc123";
  const BEGIN = "__UT_BEGIN_" + STAMP + "__";
  const END = "__UT_END_" + STAMP + "__";
  const clock = { now: () => 1700000000000, random: () => "abc123" };

  it("types exactly the begin marker, the command and the end marker - no cleanup line", async () => {
    const terminal = fakeTty({ prompt: "root@x:~# " });

    const outcome = await createSessionExec(terminal.source, clock)({
      sessionId: "s1",
      command: "free -h",
      mode: "shell",
    });

    // 用户在屏幕上看到的就这三行：插件不再往里写 ANSI，也不再敲清理命令
    expect(terminal.writes).toEqual(["echo " + BEGIN + "\nfree -h\necho " + END + "\n"]);
    expect(terminal.writes.join("")).not.toContain("\u001B");
    // 独立通道是 exec 模式的事：shell 模式一行都不走它
    expect(terminal.execs).toEqual([]);
    // 取回不受影响：命令的真实输出照旧
    expect(outcome.stdout).toBe("ran:free -h\n");
    expect(outcome).toMatchObject({ mode: "shell", code: null, stderr: "", truncated: false, timedOut: false });
  });
});

/**
 * M5-5：审计下沉到 createSessionExec —— 工具路径与路由路径共用它。
 * 只记在路由层的话，工具调用一条都不会留痕（真实事故就是这样漏的）。
 */
describe("createSessionExec audit (M5-5)", () => {
  const clock = { now: () => 1700000000000, random: () => "abc123" };
  const auditOf = (event: string): { event: string; data?: Record<string, unknown> }[] =>
    diagCalls.filter((call) => call.event === event);

  it("records exactly one session.exec when the tool path runs a command", async () => {
    const exec = createSessionExec(fakeTty().source, clock);
    const tool = toolNamed(createAgentTools({ sessions: () => [session("s1")], exec }), "uniterminal_exec");

    diagCalls.length = 0;
    const value = await tool.execute({ command: "uname -a" }, {});

    expect(value).toMatchObject({ ok: true, mode: "exec", code: 0 });
    // 一次执行只记一条：工具层不另记，共享实现里也只可能走到这里一次
    expect(auditOf("session.exec")).toEqual([
      {
        event: "session.exec",
        data: { sessionId: "s1", mode: "exec", ms: 0, code: 0, commandPreview: "uname -a" },
      },
    ]);
  });

  it("scrubs the password shape out of the preview before cutting it to 120 characters", async () => {
    const exec = createSessionExec(fakeTty().source, clock);
    const secret = "Sup3r-Secret-9911";
    const command = "login --password=" + secret + " " + "x".repeat(200);

    diagCalls.length = 0;
    await exec({ sessionId: "s1", command, mode: "exec" });

    const preview = String(auditOf("session.exec")[0]?.data?.commandPreview);
    // 先抹再截：截断在前会把口令切成不匹配形状的半截，反而漏出去
    expect(preview).toHaveLength(120);
    expect(preview.startsWith("login --password=*** x")).toBe(true);
    expect(preview).not.toContain(secret);
    expect(JSON.stringify(diagCalls)).not.toContain(secret);
  });

  it("keeps a timeout and a failure on their own events, still one record per attempt", async () => {
    // 只回显不执行：shell 模式必然超时
    const stalled = createSessionExec(fakeTty({ execute: false }).source, clock);

    diagCalls.length = 0;
    const outcome = await stalled({ sessionId: "s1", command: "sleep 30", mode: "shell", timeoutMs: 30 });

    expect(outcome.timedOut).toBe(true);
    expect(auditOf("session.exec")).toEqual([]);
    expect(auditOf("session.exec-timeout")).toEqual([
      {
        event: "session.exec-timeout",
        data: { sessionId: "s1", mode: "shell", ms: 0, code: null, commandPreview: "sleep 30" },
      },
    ]);

    diagCalls.length = 0;
    await expect(stalled({ sessionId: "s404", command: "id", mode: "shell" })).rejects.toMatchObject({
      reason: "unknown-session",
    });
    const failed = auditOf("session.exec-failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.data).toMatchObject({
      sessionId: "s404",
      mode: "shell",
      code: null,
      commandPreview: "id",
      reason: "unknown-session",
    });
  });
});

/**
 * M5-5：shell 模式把命令敲进用户正在看的那一个终端，vim 这类交互式/全屏程序会整屏抢走它。
 * 拒绝必须发生在写入之前；exec 模式走独立通道，不受此限制。
 */
describe("shell mode refuses interactive programs (M5-5)", () => {
  const clock = { now: () => 1700000000000, random: () => "abc123" };

  interface Attempt {
    terminal: ReturnType<typeof fakeTty>;
    outcome?: ExecOutcome;
    error?: unknown;
  }

  async function attempt(command: string, mode: ExecMode = "shell"): Promise<Attempt> {
    const terminal = fakeTty();
    const exec = createSessionExec(terminal.source, clock);
    try {
      return { terminal, outcome: await exec({ sessionId: "s1", command, mode, timeoutMs: 200 }) };
    } catch (error) {
      return { terminal, error };
    }
  }

  /** 拒绝时的完整文案：每个用例都顺带断言「一行都没写进用户的 shell」。 */
  const refusalMessage = async (command: string): Promise<string> => {
    const { error, terminal } = await attempt(command);
    expect(error).toMatchObject({ reason: "unsupported" });
    expect(terminal.writes).toEqual([]);
    return error instanceof Error ? error.message : String(error);
  };

  it("refuses vim in shell mode with an actionable message", async () => {
    const message = await refusalMessage("vim /x");

    expect(message).toMatch(/「vim」/);
    expect(message).toContain("交互式");
    expect(message).toContain("用户终端");
    expect(message).toContain("mode=exec");
    expect(message).toContain("让用户自己执行");
  });

  it("catches the program behind a leading wrapper or a pipe", async () => {
    expect(await refusalMessage("cd /opt && vim x")).toMatch(/「vim」/);
    expect(await refusalMessage("cd /opt; nano /x")).toMatch(/「nano」/);
    expect(await refusalMessage("echo hi | more")).toMatch(/「more」/);
  });

  it("refuses top, ignores case and sees through an absolute path", async () => {
    expect(await refusalMessage("top")).toMatch(/「top」/);
    expect(await refusalMessage("Vim /x")).toMatch(/「vim」/);
    expect(await refusalMessage("/usr/bin/vi /x")).toMatch(/「vi」/);
  });

  it("does not refuse a command whose first word is off the denylist", async () => {
    const { outcome, terminal } = await attempt("echo vim");

    expect(outcome).toMatchObject({ mode: "shell", code: null });
    expect(outcome?.stdout).toBe("vim\n");
    expect(terminal.writes).toHaveLength(1);
  });

  it("leaves exec mode alone: a separate channel cannot hijack the user's terminal", async () => {
    const { outcome, terminal } = await attempt("vim x", "exec");

    expect(outcome).toMatchObject({ mode: "exec", code: 0 });
    // exec 走独立通道：命令真的发出去了，用户 shell 一行都没被写
    expect(terminal.execs).toEqual(["vim x"]);
    expect(terminal.writes).toEqual([]);
  });

  it("surfaces the refusal to the model through the tool result", async () => {
    const exec = createSessionExec(fakeTty().source, clock);
    const tool = toolNamed(createAgentTools({ sessions: () => [session("s1")], exec }), "uniterminal_exec");

    const value = (await tool.execute({ command: "vim /x", mode: "shell" }, {})) as Record<string, unknown>;

    expect(value.ok).toBe(false);
    expect(value.code).toBe("unsupported");
    expect(String(value.message)).toContain("mode=exec");
  });
});
