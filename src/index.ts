import type { Config } from "./config.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { createSessionExec, registerAgentTools } from "./agent-tools.js";
import type { AgentToolsContext } from "./agent-tools.js";
import { TransportRegistry } from "./engine/registry.js";
import { SessionManager } from "./engine/session-manager.js";
import { createSshTransport, loadSshClientFactory } from "./engine/ssh-transport.js";
import { TunnelManager } from "./engine/tunnel.js";
import { createRoutes } from "./routes.js";
import type { RouteDeps, WebRouteLike } from "./routes.js";
import { diag } from "./host-diag.js";
import { AppearanceStore } from "./store/appearance.js";
import { KnownHosts } from "./store/known-hosts.js";
import { ProfileStore } from "./store/profile-store.js";
import { SecurityStore } from "./store/security.js";
import { createWsBridge } from "./ws-bridge.js";
import type { UpgradeRouteLike, WsBridge } from "./ws-bridge.js";

export { Config } from "./config.js";
export const name = "uniterminal";
/**
 * 只声明真正直接读取的服务。`tools` **故意不在这里**：cordis 对未 inject 的服务读属性会抛错
 * （cannot get property "tools" without inject），而没有该服务的部署仍必须能挂载插件，
 * 所以它由 resolveToolsService 用 ctx.get 动态取。
 */
export const inject = ["webServer"];

/** 本插件用到的宿主 webServer 成员。 */
export interface WebServerLike {
  register(route: WebRouteLike): () => void;
  /** 升级路由注册器（形状见 ws-bridge.ts：只认 path + handler，键名精确匹配）。 */
  registerUpgrade?: (route: UpgradeRouteLike) => () => void;
}

/**
 * 本插件用到的宿主上下文成员（最小声明，不依赖宿主内部包）。
 * `get` 是可选的：老宿主没有它，插件照常加载，只是取不到可选服务。
 */
export interface PluginContext extends AgentToolsContext {
  logger?: { warn: (message: string, ...args: unknown[]) => void };
  webServer: WebServerLike;
}

/**
 * 同步构造 profiles / known_hosts / security 存储，异步加载：路由与传输层都拿同一份实例。
 * 加载失败只记警告（路由随后按 503 上报），不静默清空文件，也不让 apply 抛出。
 */
function createStoreDeps(ctx: PluginContext, config: Config): RouteDeps | undefined {
  try {
    const home = homedir();
    const configDir = join(home, ".dsh", "uniterminal");
    const profiles = new ProfileStore(join(configDir, "profiles.json"));
    const knownHosts = new KnownHosts(join(configDir, "known_hosts.json"));
    // SecurityStore 收的是目录（security.json / credentials.json 两件套；
    // vault.bin 是已停用的旧档文件，只用来识别与清理，永远不读）
    const security = new SecurityStore(join(configDir));
    // M6-1：外观存自己的 appearance.json；插件 config 的 appearance 只作为 seed 默认值
    const appearance = new AppearanceStore(configDir, config.appearance);
    const ready = Promise.all([
      profiles.load(),
      knownHosts.load(),
      security.load(),
      appearance.load(),
    ]).then(async () => {
      // 选定凭据后端（探测系统密码箱 + 把旧明文库搬进去）**放在 ready 之内**：
      // 路由的 guard 等的就是 ready，因此不会出现"后端还没选好就先服务请求"的窗口。
      await ensureCredentialStore(ctx, security);
    });
    // 万一没有处理器等待 ready，也不要产生 unhandledRejection
    ready.catch((error: unknown) => {
      ctx.logger?.warn?.("uniterminal: store load failed: %s", String(error));
    });
    return { profiles, knownHosts, security, appearance, ready, sshConfigPath: join(home, ".ssh", "config") };
  } catch (error) {
    ctx.logger?.warn?.("uniterminal: store setup failed: %s", String(error));
    return undefined;
  }
}

/**
 * 确保凭据存储就绪：**探测**系统密码箱 → 有就用它（并把旧明文库逐条搬进去），
 * 没有就回落明文文件（security.json + credentials.json）。
 *
 * - 探测是只读的，绝不为了探测去写一条测试凭据；
 * - 迁移是逐条的：**全部写成功之后**才删 credentials.json，绝不出现"删了文件但密码没搬进去"；
 * - 任何一步失败都只是"用文件后端"，**绝不让插件起不来**；
 * - 旧版凭据文件不在这里动：删它是破坏性动作，只能由用户经 /security/clear-legacy 确认。
 * 测试进程不落盘：index.test.ts 直接调 apply，没有注入临时目录，绝不能写真实 ~/.dsh/uniterminal。
 */
async function ensureCredentialStore(ctx: PluginContext, security: SecurityStore): Promise<void> {
  if (process.env.NODE_ENV === "test" || process.env.VITEST !== undefined) return;
  try {
    await security.ensureStorage();
    const state = security.state();
    diag("security.storage", { storage: state.storage, degraded: state.degraded });
  } catch (error) {
    // 选后端失败不是致命故障：文件后端仍然可用（凭据库里已记住的密码照常取回）。
    ctx.logger?.warn?.("uniterminal: credential storage setup failed: %s", String(error));
  }
}

export function apply(ctx: PluginContext, config: Config): void {
  const registry = new TransportRegistry();
  const manager = new SessionManager(registry, { bufferBytes: config.bufferBytes });
  // M3-2 隧道表：通道来自 manager.openTunnels（复用已有 SSH 连接），
  // 会话一关就由 onClosed 把该会话派生的隧道全部回收（端口/监听都不留给下一条链路）
  const tunnels = new TunnelManager({
    sessions: (id) => manager.openTunnels(id),
    onSessionClosed: (listener) => manager.onClosed(listener),
  });
  // M5-1：AI 会话的执行入口。路由与工具共用同一个执行器——两个模式的实现只有一份。
  const agentExec = config.agentExec ?? "on";
  const exec = createSessionExec(manager);
  const storeDeps = createStoreDeps(ctx, config);
  diag("apply", { hasRegisterUpgrade: typeof ctx.webServer.registerUpgrade === "function", hasRegister: typeof ctx.webServer.register === "function" });

  // 在 ready 之后判定：load() 之前 state().mode 恒为 null，会误把已配置的机器再 setup 一次。
  const security = storeDeps?.security;
  if (security !== undefined && storeDeps !== undefined) {
    const ready = storeDeps.ready;
    void (async () => {
      try {
        await ready;
      } catch (error) {
        ctx.logger?.warn?.("uniterminal: credential store setup failed: %s", String(error));
      }
    })();
  }
  const hostRegisterUpgrade = ctx.webServer.registerUpgrade;
  const registerUpgrade =
    typeof hostRegisterUpgrade === "function" ? hostRegisterUpgrade.bind(ctx.webServer) : undefined;

  ctx.effect(() => {
    let disposed = false;
    const disposers: (() => void)[] = [];

    // HTTP 路由与升级路由都是纯内存注册，不依赖 ssh2 的懒加载：
    // 同步注册，避免 /api/uniterminal/health 在 ssh2 加载完成前不可用。
    // registry 必须一并注入：少了它，/profiles/test 在真实宿主里会恒 503（功能形同不存在）
    // sftp 同理：走 manager.openSftp，复用**已有**的 SSH 连接，绝不为传文件再开一条
    for (const route of createRoutes(manager, {
      ...storeDeps,
      registry,
      sftp: (id) => manager.openSftp(id),
      tunnels,
      exec,
      agentExec,
    })) {
      try {
        disposers.push(ctx.webServer.register(route));
      } catch (error) {
        ctx.logger?.warn?.("uniterminal: route %s not registered: %s", route.path, String(error));
      }
    }

    // M5-1：把两个工具交给宿主。注册失败只记诊断——绝不让插件加载失败。
    try {
      if (agentExec === "off") diag("agent-tools.disabled", {});
      else registerAgentTools(ctx, { sessions: () => manager.list(), exec });
    } catch (error) {
      diag("agent-tools.failed", { error: String(error).slice(0, 160) });
    }

    let bridge: WsBridge | undefined;
    try {
      bridge = createWsBridge({ manager, registerUpgrade, logger: ctx.logger });
    } catch (error) {
      ctx.logger?.warn?.("uniterminal: websocket bridge unavailable: " + String(error));
    }

    void (async () => {
      try {
        const factory = await loadSshClientFactory();
        if (disposed) return;
        // 已信任的指纹必须先就位，否则已信任的主机会被误判成 unknown host key
        await storeDeps?.ready?.catch(() => undefined);
        if (disposed) return;
        registry.register(
          createSshTransport(factory, {
            term: config.term,
            connectTimeoutMs: config.connectTimeoutMs,
            // 注入 knownHosts 才会启用 hostVerifier：M1-4 的指纹校验靠这一步接进传输层
            knownHosts: storeDeps?.knownHosts,
            onUnknownHostKey: config.knownHostsPolicy ?? "reject",
          }),
        );
      } catch (error) {
        ctx.logger?.warn?.("uniterminal: ssh transport unavailable: %s", String(error));
      }
    })();

    return () => {
      disposed = true;
      // 先收隧道再摘路由：否则本地监听端口会在路由消失后继续被占着
      tunnels.dispose();
      void tunnels.stopAll();
      for (const dispose of disposers.splice(0)) dispose();
      void bridge?.dispose();
    };
  });
}
