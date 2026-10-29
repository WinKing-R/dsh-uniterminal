/**
 * M5-1：把「在这台机器的服务器上执行命令」交到**任意** AI 会话手里。
 * 这里有两个出口，共用同一份实现：
 *  - createSessionExec：两个模式的执行器（exec 走独立通道 / shell 写进用户正在用的 shell）；
 *  - createAgentTools：注册给宿主的两个工具（列表 + 执行），服务由 index.ts 用 ctx.get 动态取。
 * 宿主 tools 服务只按结构化最小契约本地声明，绝不 import 宿主内部包。
 */
import { randomBytes } from "node:crypto";
import type { SessionInfo } from "./engine/session-manager.js";
import { ExecChannelError } from "./engine/types.js";
import type { ExecOptions, ExecResult } from "./engine/types.js";
import { diag } from "./host-diag.js";

export type ExecMode = "exec" | "shell";

export interface ExecRequest {
  sessionId: string;
  command: string;
  mode: ExecMode;
  timeoutMs?: number;
}

export interface ExecOutcome extends ExecResult {
  mode: ExecMode;
  ms: number;
}

export type ExecRunner = (request: ExecRequest) => Promise<ExecOutcome>;

/**
 * 会话来源：SessionManager 在结构上满足它（list / exec / write / subscribe）。
 * 刻意只取这四个方法——绝不给调用方一条能关会话的控制面。
 */
export interface ExecSessionSource {
  list(): SessionInfo[];
  exec(id: string, command: string, options?: ExecOptions): Promise<ExecResult>;
  write(id: string, chunk: Uint8Array): void;
  subscribe(id: string, listener: (chunk: Uint8Array) => void): () => void;
}

export interface SessionExecOptions {
  now?: () => number;
  /** 标记里的随机串来源；测试注入固定值即可断言顺序与解析。 */
  random?: () => string;
}

/** 一条命令的默认上限：没有上限时，一条卡住的命令能把通道挂到天荒地老。 */
const DEFAULT_EXEC_TIMEOUT_MS = 60000;
/** shell 模式的取回上限（字符数）：与传输层的 256 KiB 同一口径。 */
const SHELL_CAPTURE_LIMIT = 256 * 1024;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const asExecError = (error: unknown): ExecChannelError =>
  error instanceof ExecChannelError ? error : new ExecChannelError("failed", messageOf(error));

/** ANSI 转义（OSC / CSI / 单字符序列）：提示符与颜色都夹带它们，不剥离就拼不出「整行只有标记」。 */
const ANSI_OSC = /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g;
const ANSI_CSI = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const ANSI_SINGLE = /\u001B[@-Z\\-_]/g;

/** 只剥转义序列，不碰换行：CRLF 与裸 CR 的归一留给取回判据自己做。 */
function stripAnsi(text: string): string {
  return text.replace(ANSI_OSC, "").replace(ANSI_CSI, "").replace(ANSI_SINGLE, "");
}

/** 归一：剥离 ANSI，并把 `\r\n` 与单独的 `\r` 统一成 `\n`（tty 的回显用 CRLF）。 */
function normalizeTerminalText(text: string): string {
  return stripAnsi(text).replace(/\r\n?/g, "\n");
}

/** 被 chunk 切断的末尾转义序列先扣住：拆成两半的 `\u001B[` 会留下一截认不出的碎片。 */
function splitTrailingEscape(text: string): { body: string; pending: string } {
  const index = text.lastIndexOf("\u001B");
  if (index < 0) return { body: text, pending: "" };
  const tail = text.slice(index);
  const complete = /^\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)|[@-Z\\-_])/.test(tail);
  return complete ? { body: text, pending: "" } : { body: text.slice(0, index), pending: tail };
}

interface MarkerHit {
  start: number;
  end: number;
  /** 标记独占一行（带提示符的回显行不满足：它前后还有提示符与引号）。 */
  wholeLine: boolean;
}

const lineStartOf = (text: string, index: number): number => text.lastIndexOf("\n", index - 1) + 1;

function lineEndOf(text: string, index: number): number {
  const found = text.indexOf("\n", index);
  return found < 0 ? text.length : found;
}

/** 标记那一行除空白之外别无他物。 */
function markerIsAloneOnLine(text: string, index: number, marker: string): boolean {
  return (
    text.slice(lineStartOf(text, index), index).trim() === "" &&
    text.slice(index + marker.length, lineEndOf(text, index + marker.length)).trim() === ""
  );
}

/** 我们自己敲进去的 `echo "标记"` 回显：标记前面紧挨着 echo，那不是命令的输出。 */
const markerIsOurEcho = (text: string, index: number): boolean => /echo\s+"?$/.test(text.slice(0, index));

/**
 * 找一个标记。「整行只有标记」是正常情形；整行形态一个也没有时（终端不回显，
 * 提示符直接粘在标记前面）才退化成子串切分，并跳过我们自己敲的回显行——
 * 否则命令还没跑完就会提前命中。
 */
function findMarker(text: string, marker: string, from: number): MarkerHit | undefined {
  for (let index = text.indexOf(marker, from); index >= 0; index = text.indexOf(marker, index + marker.length)) {
    if (markerIsAloneOnLine(text, index, marker)) {
      return { start: index, end: index + marker.length, wholeLine: true };
    }
  }
  for (let index = text.indexOf(marker, from); index >= 0; index = text.indexOf(marker, index + marker.length)) {
    if (!markerIsOurEcho(text, index)) return { start: index, end: index + marker.length, wholeLine: false };
  }
  return undefined;
}

/** 提示符 + 我们敲的那行输入（`root@host:~# uname -a`）：输入不是输出，切掉。 */
function isOwnEchoLine(line: string, input: string): boolean {
  const trimmed = line.trim();
  const command = input.trim();
  if (trimmed === "" || command === "") return false;
  if (trimmed === command) return true;
  if (!trimmed.endsWith(command)) return false;
  // 前面只剩提示符才算回显：`ls: cannot access x` 这种真实输出不能误删
  return /[#$%>]\s$/.test(trimmed.slice(0, trimmed.length - command.length));
}

/** 提示符残段：只有终端不回显（标记不独占一行）时，提示符才会落进取回内容里。 */
const PROMPT_HEAD = /^\S*[#$%>]\s/;
const PROMPT_TAIL = /[^\n]*[#$%>]\s*$/;

function trimEmptyEnds(lines: string[]): void {
  while (lines.length > 0 && lines[0]?.trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") lines.pop();
}

/** 只取两个标记之间的内容：区间在 begin 标记行之后、end 标记行之前。 */
function betweenMarkers(text: string, begin: string, end: string, command: string): string {
  const normalized = normalizeTerminalText(text);
  const beginHit = findMarker(normalized, begin, 0);
  if (beginHit === undefined) return "";
  const from = beginHit.wholeLine ? lineEndOf(normalized, beginHit.end) + 1 : beginHit.end;
  const endHit = findMarker(normalized, end, from);
  const to =
    endHit === undefined ? normalized.length : endHit.wholeLine ? lineStartOf(normalized, endHit.start) : endHit.start;
  const ownEchoes = [command, "echo " + end].flatMap((line) => line.split("\n"));
  const lines = normalized
    .slice(from, to)
    .split("\n")
    .filter((line) => !ownEchoes.some((input) => isOwnEchoLine(line, input)));
  trimEmptyEnds(lines);
  // 标记不独占一行时提示符会粘在内容两端：各剪一段
  if (!beginHit.wholeLine && lines.length > 0) lines[0] = (lines[0] ?? "").replace(PROMPT_HEAD, "");
  if (endHit !== undefined && !endHit.wholeLine && lines.length > 0) {
    lines[lines.length - 1] = (lines[lines.length - 1] ?? "").replace(PROMPT_TAIL, "");
  }
  trimEmptyEnds(lines);
  return lines.length === 0 ? "" : lines.join("\n") + "\n";
}

/** shell 模式：先把标记与命令敲进用户正在用的那个 shell，再从它的输出流里按标记取回。 */
async function runOnShell(
  source: ExecSessionSource,
  request: ExecRequest,
  timeoutMs: number,
  now: () => number,
  random: () => string,
): Promise<ExecResult> {
  const stamp = String(now()) + "_" + random();
  const begin = "__UT_BEGIN_" + stamp + "__";
  const end = "__UT_END_" + stamp + "__";
  // 回显行是 `root@host# echo __UT_END_x__`：带提示符/echo 前缀，与命令真正的输出行不同
  const beginLine = "echo " + begin;
  const endLine = "echo " + end;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let text = "";
  let pending = "";
  let truncated = false;
  let timedOut = false;
  let stop: (() => void) | undefined;

  // 先订阅再写入：任何一段输出都不许漏在订阅之前
  const collected = new Promise<void>((resolve) => {
    const unsubscribe = source.subscribe(request.sessionId, (chunk) => {
      // 归一在收流时做：判定标记与最后取回用的是同一份文本，ANSI 与 CRLF 都漏不进判据
      const split = splitTrailingEscape(pending + decoder.decode(chunk, { stream: true }));
      pending = split.pending;
      text += normalizeTerminalText(split.body);
      if (text.length > SHELL_CAPTURE_LIMIT) {
        truncated = true;
        text = text.slice(0, SHELL_CAPTURE_LIMIT);
      }
      if (findMarker(text, end, 0) !== undefined) resolve();
    });
    const timer = setTimeout(() => {
      timedOut = true;
      resolve();
    }, timeoutMs);
    stop = () => {
      clearTimeout(timer);
      unsubscribe();
    };
  });

  try {
    // 三行合成**一次**写入：分成三次会让每个小包各自等 ACK（Nagle），
    // 而 bash 读到一个 chunk 仍会按行顺序执行，语义不变。
    source.write(
    request.sessionId,
    encoder.encode(beginLine + "\n" + request.command + "\n" + endLine + "\n"),
    );
    await collected;
  } finally {
    stop?.();
  }

  // 交互式 shell 没有退出码可拿：code 恒为 null，绝不编一个 0 出来
  const result: ExecResult = {
    stdout: betweenMarkers(text, begin, end, request.command),
    stderr: "",
    code: null,
    truncated,
    timedOut,
  };
  return result;
}

/**
 * M5-5：命令预览与响应都必须抹掉口令/私钥的形状。审计下沉到本文件后这里是唯一实现，
 * routes.ts 直接复用同一份——两份实现迟早会漂移成两种 scrub。
 */
const SECRET_SHAPES: readonly { pattern: RegExp; replacement: string }[] = [
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    replacement: "***PRIVATE KEY***",
  },
  {
    pattern: /(password|passwd|passphrase|secret|token)(\s*[=:]\s*)\S+/gi,
    replacement: "$1$2***",
  },
];

/** 只认形状不认具体值：不知道口令也能把它抹掉。 */
export const scrubSecrets = (text: string): string =>
  SECRET_SHAPES.reduce((value, shape) => value.replace(shape.pattern, shape.replacement), text);

/** 审计里的命令预览长度：够看清是哪条命令，又不至于把整段脚本塞进日志。 */
const COMMAND_PREVIEW_LIMIT = 120;

/**
 * M5-5：shell 模式把命令敲进**用户正在看的那一个终端**，vi/top 这类程序会把整屏抢走，
 * AI 再也拿不回提示符（真实事故：vim 占满终端，AI 只能盲发 Esc :q!）。
 * 只拦交互式/全屏程序；exec 模式走独立通道，不碰用户终端，因此不受此限制。
 */
const INTERACTIVE_PROGRAMS: ReadonlySet<string> = new Set([
  "vi", "vim", "nvim", "nano", "emacs", "less", "more", "top", "htop",
  "watch", "man", "tmux", "screen", "su", "ssh",
]);

/** 命令分段：`cd X && vim …`、`a; b`、`a | b`、后台 `a &` 的每一段都有自己的首词。 */
const COMMAND_SEGMENT = /&&|\|\||;|\||\n|&/;

/** 一段命令的首词：去引号、去目录前缀后小写（`/usr/bin/Vim` 也算 vim）。 */
function firstWordOf(segment: string): string {
  const token = segment.trim().split(/\s+/)[0] ?? "";
  const unquoted = token.replace(/^["'`]+/, "").replace(/["'`]+$/, "");
  return unquoted.slice(unquoted.lastIndexOf("/") + 1).toLowerCase();
}

/** 找出命令里会启动交互式/全屏程序的那一段；没有就返回 undefined。 */
function interactiveProgramOf(command: string): string | undefined {
  for (const segment of command.split(COMMAND_SEGMENT)) {
    const word = firstWordOf(segment);
    if (INTERACTIVE_PROGRAMS.has(word)) return word;
  }
  return undefined;
}

/** 拒绝文案必须给出下一步：换 mode=exec，或者让用户自己执行。 */
function refuseInteractive(program: string): never {
  throw new ExecChannelError(
    "unsupported",
    "uniterminal: shell 模式不能启动交互式程序「" +
      program +
      "」——它会占满用户终端（提示符回不来）。请改用 mode=exec（独立通道，不碰用户终端）；" +
      "若这确实是用户想要的交互式操作，请让用户自己执行。",
  );
}

/**
 * 两个模式的执行器。exec 走 ssh2 的独立通道（不碰用户的终端）；
 * shell 写进用户正在用的那个 shell，用一对随机标记取回输出。
 */
export function createSessionExec(source: ExecSessionSource, options: SessionExecOptions = {}): ExecRunner {
  const now = options.now ?? Date.now;
  const random = options.random ?? (() => randomBytes(8).toString("hex"));

  const requireKnown = (sessionId: string): void => {
    if (source.list().some((session) => session.id === sessionId)) return;
    throw new ExecChannelError("unknown-session", "uniterminal: unknown session '" + sessionId + "'");
  };

  return async (request) => {
    const startedAt = now();
    // 先抹再截：截断在前会把一个长口令切成「不匹配形状」的半截，反而漏出去
    const commandPreview = scrubSecrets(request.command).slice(0, COMMAND_PREVIEW_LIMIT);
    try {
      requireKnown(request.sessionId);
      // shell 模式先拦在写入之前：交互式程序会把用户的终端整屏抢走
      if (request.mode === "shell") {
        const program = interactiveProgramOf(request.command);
        if (program !== undefined) refuseInteractive(program);
      }
      const timeoutMs = request.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
      const result =
        request.mode === "shell"
          ? await runOnShell(source, request, timeoutMs, now, random)
          : await source.exec(request.sessionId, request.command, { timeoutMs });
      const ms = now() - startedAt;
      // M5-5：一次执行恰好一条审计。工具路径与路由路径都经过这里，
      // 因此路由层不再自己记——记在别处等于给工具调用留一个盲区。
      diag(result.timedOut ? "session.exec-timeout" : "session.exec", {
        sessionId: request.sessionId,
        mode: request.mode,
        ms,
        code: result.code,
        commandPreview,
      });
      return { ...result, mode: request.mode, ms };
    } catch (error) {
      const failure = asExecError(error);
      diag("session.exec-failed", {
        sessionId: request.sessionId,
        mode: request.mode,
        ms: now() - startedAt,
        code: null,
        commandPreview,
        reason: failure.reason,
        error: messageOf(failure).slice(0, 160),
      });
      throw failure;
    }
  };
}

/** 宿主 tools 服务的结构化最小契约（本地声明，不依赖宿主内部包）。 */
export interface AgentToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    additionalProperties: false;
    properties: Record<string, unknown>;
    required?: string[];
  };
  output: {
    schema: { type: string; additionalProperties?: boolean };
    render: (args: unknown, value: unknown) => { type: "text"; text: string }[];
  };
  timeoutMs?: number;
  execute(args: unknown, exec: unknown): Promise<unknown>;
}

export interface HostToolsService {
  /** 与真实宿主一致：返回注销函数（交给 ctx.effect 收口），没有就返回 void。 */
  register(tool: AgentToolDefinition): (() => void) | void;
}

/** 宿主上下文里本文件用到的那一小片：可选服务的动态查询（cordis 的 ctx.get）。 */
export interface PluginContextLike {
  /** 老宿主没有它：取不到任何可选服务，插件照常加载。 */
  get?(name: string): unknown;
}

export interface AgentToolsContext extends PluginContextLike {
  effect: (fn: () => (() => void) | void, label?: string) => void;
}

export interface AgentToolDeps {
  sessions: () => SessionInfo[];
  exec: ExecRunner;
}

/** 工具结果就是给模型看的文本：一段 JSON 比任何花哨排版都好读。 */
const textOutput = {
  schema: { type: "object", additionalProperties: true },
  render: (_args: unknown, value: unknown): { type: "text"; text: string }[] => [
    { type: "text", text: JSON.stringify(value) },
  ],
};

/**
 * 给人看的会话标签。
 *
 * 两个会话连同一台主机时，{id, host, user} 完全一样 —— 模型看到的是两条一模一样的记录，
 * 根本没法判断"哪个是你屏幕上的哪个窗口"。所以补两样东西：
 * 1. 同名会话按**打开顺序**编号（第二个是 #2），与客户端标签栏的编号规则一致；
 * 2. 打开时间（模型可以问用户"14:42 开的那条是不是"）。
 */
interface SessionCandidate {
  id: string;
  label: string;
  host: string | null;
  user: string | null;
  port: number | null;
  openedAt: string;
  status: string;
}

const labelSessions = (sessions: SessionInfo[]): SessionCandidate[] => {
  const ordered = [...sessions].sort((a, b) => a.createdAt - b.createdAt);
  const seen = new Map<string, number>();
  return ordered.map((session) => {
    const base =
      (session.user === undefined || session.user === "" ? "" : session.user + "@") +
      (session.host ?? "?") +
      (session.port === undefined ? "" : ":" + String(session.port));
    const ordinal = (seen.get(base) ?? 0) + 1;
    seen.set(base, ordinal);
    return {
      id: session.id,
      // 只有重名时才带序号：唯一时保持简短
      label: ordinal === 1 ? base : base + " #" + String(ordinal),
      host: session.host ?? null,
      user: session.user ?? null,
      port: session.port ?? null,
      openedAt: new Date(session.createdAt).toISOString(),
      status: session.status,
    };
  });
};

const candidatesOf = (sessions: SessionInfo[]): SessionCandidate[] => labelSessions(sessions);

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

function listSessionsTool(deps: AgentToolDeps): AgentToolDefinition {
  return {
    name: "uniterminal_list_sessions",
    description: [
      "List the sessions this machine's Uniterminal plugin currently holds.",
      "Each entry carries the session id, a human label, host, user, port, status and openedAt;",
      "label is what the user sees in the Uniterminal session bar (duplicates of the same endpoint get '#2', '#3' by opening order).",
      "pass the id to uniterminal_exec to run a command on the server behind it.",
    ].join(" "),
    parameters: { type: "object", additionalProperties: false, properties: {} },
    output: textOutput,
    timeoutMs: 10000,
    async execute() {
      const sessions = labelSessions(deps.sessions());
      return { ok: true, count: sessions.length, sessions };
    },
  };
}

function execTool(deps: AgentToolDeps): AgentToolDefinition {
  return {
    name: "uniterminal_exec",
    description: [
      "Run one shell command on a server this machine's Uniterminal plugin is already connected to.",
      "Prefer mode=exec: it is the default, it opens a separate channel, it has no side effects,",
      "and it never touches the user's terminal.",
      "Use mode=shell only when the command must continue the interactive shell's own state -",
      "a cd, an export, or variables and functions already set up in that shell;",
      "the command is typed into the terminal the user is watching, so the user sees it appear and run;",
      "the BEGIN and END marker commands this tool types around it are echoed there too,",
      "and they stay on the user's screen.",
      "Never pick shell just to make the output visible: the result is returned to you either way.",
      "Shell mode refuses interactive full-screen programs (vi, vim, top, less, man and the like):",
      "they take over the user's terminal, so use mode=exec or let the user start them;",
      "mode=exec is never blocked by that rule.",
      "Omit sessionId when exactly one session is open.",
      "When several are open and the user did not name one, do not guess: call uniterminal_list_sessions,",
      "show the user the labels (duplicates of one endpoint are numbered #2, #3 by opening order,",
      "matching the panel's session bar) and ask which window they mean, then retry with that sessionId.",
    ].join(" "),
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        command: {
          type: "string",
          description: "Command line to run on the remote server.",
        },
        sessionId: {
          type: "string",
          description: "Target session id from uniterminal_list_sessions. Optional when exactly one session is open.",
        },
        mode: {
          type: "string",
          enum: ["exec", "shell"],
          description:
            "exec (default, strongly preferred): opens a separate channel, has no side effects and leaves the user's terminal untouched. shell: types the command into the session's interactive shell, which the user sees happening in their own terminal; use it only to continue that shell's state (cd, export, existing variables).",
        },
        timeoutMs: {
          type: "number",
          description: "Timeout in milliseconds (default 60000).",
        },
      },
      required: ["command"],
    },
    output: textOutput,
    timeoutMs: 120000,
    async execute(args) {
      const input = asRecord(args);
      const command = typeof input.command === "string" ? input.command : "";
      if (command.trim() === "") {
        return { ok: false, code: "invalid-command", message: "command must be a non-empty string" };
      }
      const mode: ExecMode = input.mode === "shell" ? "shell" : "exec";
      const timeoutMs =
        typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
          ? input.timeoutMs
          : undefined;
      const sessions = deps.sessions();
      const requested = typeof input.sessionId === "string" && input.sessionId.trim() !== "" ? input.sessionId : undefined;
      const target = requested ?? (sessions.length === 1 ? sessions[0]?.id : undefined);
      if (target === undefined) {
        if (sessions.length === 0) {
          return {
            ok: false,
            code: "no-session",
            message:
              "no Uniterminal session is open; open one in the Uniterminal panel, then call uniterminal_list_sessions",
          };
        }
        return {
          ok: false,
          code: "session-required",
          message:
            "several sessions are open: do NOT guess. Show the user the sessions below (label + openedAt) and ask which window to use, then retry with that sessionId.",
          sessions: candidatesOf(sessions),
        };
      }
      try {
        const outcome = await deps.exec({ sessionId: target, command, mode, timeoutMs });
        return {
          ok: true,
          sessionId: target,
          host: sessions.find((session) => session.id === target)?.host ?? null,
          mode: outcome.mode,
          stdout: outcome.stdout,
          stderr: outcome.stderr,
          code: outcome.code,
          truncated: outcome.truncated,
          timedOut: outcome.timedOut,
          ms: outcome.ms,
        };
      } catch (error) {
        return {
          ok: false,
          code: asExecError(error).reason,
          message: messageOf(error),
          sessionId: target,
          sessions: candidatesOf(sessions),
        };
      }
    },
  };
}

export function createAgentTools(deps: AgentToolDeps): AgentToolDefinition[] {
  return [listSessionsTool(deps), execTool(deps)];
}

/**
 * 动态取宿主 tools 服务。**故意不写进 inject**：cordis 对未 inject 的服务读属性会直接抛错
 * （cannot get property "tools" without inject），而没装该服务的部署仍必须能挂载插件。
 */
export function resolveToolsService(ctx: PluginContextLike): HostToolsService | undefined {
  try {
    const tools = ctx.get?.("tools") as HostToolsService | undefined;
    return tools !== undefined && tools !== null && typeof tools.register === "function" ? tools : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 注册两个工具。任何一步失败都只记诊断，绝不把插件加载拖垮：
 * 没有 tools 服务的宿主照常可用，只是 AI 会话看不到这两个工具。
 */
export function registerAgentTools(ctx: AgentToolsContext, deps: AgentToolDeps): number {
  const tools = resolveToolsService(ctx);
  if (tools === undefined) {
    // 不是错误，但必须留痕——否则「工具为什么没出现」无从查起
    diag("agent-tools.unavailable", {});
    return 0;
  }
  const registered: string[] = [];
  for (const tool of createAgentTools(deps)) {
    try {
      // 注册函数原样交给 effect：插件卸载时工具跟着注销，绝不留一条悬空的工具
      ctx.effect(() => tools.register(tool), "uniterminal: " + tool.name);
      registered.push(tool.name);
    } catch (error) {
      diag("agent-tools.failed", { tool: tool.name, error: messageOf(error).slice(0, 160) });
    }
  }
  if (registered.length > 0) diag("agent-tools.registered", { tools: registered });
  return registered.length;
}
