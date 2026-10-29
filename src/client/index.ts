import { ensureUniterminalCss } from "./inject-css.js";
import { registerTab, TAB_TYPE } from "./right-pane.js";
import { terminalTabIcon } from "./tab-icon.js";
import { UniterminalTab } from "./UniterminalTab.js";

export const TAB_ID = TAB_TYPE;

// 模块一被浏览器执行就留下痕迹：不需要在控制台输入任何东西即可判断客户端半边是否被加载。
console.info("[uniterminal] client bundle loaded");

/** 与真实客户端插件一致：声明依赖的服务名。 */
export const inject = ["slots", "locale"];

type Ctx = Record<string, unknown>;

interface Diag {
  loaded: boolean;
  phase: "module" | "apply" | "apply-failed";
  inject: string[];
  services: { betterSidebar: string; sidebarRightTabs: string; inject: string };
  attempts: { target: string; ok: boolean; error?: string }[];
  finalTarget?: string;
  finalError?: string;
  at: number;
}

const diag: Diag = {
  loaded: true,
  phase: "module",
  inject: ["slots", "locale"],
  services: { betterSidebar: "unknown", sidebarRightTabs: "unknown", inject: "unknown" },
  attempts: [],
  at: Date.now(),
};

// 自诊断出口：重启后在浏览器控制台执行 __UNITERMINAL__ 即可看到客户端半边的真实状态。
(globalThis as unknown as { __UNITERMINAL__?: Diag }).__UNITERMINAL__ = diag;

function warn(ctx: Ctx, message: string): void {
  diag.attempts.push({ target: "warn", ok: false, error: message });
  try {
    const logger = ctx["logger"];
    if (typeof logger === "object" && logger !== null) {
      const logWarn = (logger as { warn?: unknown })["warn"];
      if (typeof logWarn === "function") {
        logWarn.call(logger, message);
        return;
      }
    }
  } catch {
    // 退回 console
  }
  console.warn(message);
}

function describe(ctx: Ctx, key: string): string {
  try {
    const value = ctx[key];
    if (value === undefined || value === null) return "absent";
    return typeof value;
  } catch (error) {
    return "throws:" + String(error).slice(0, 60);
  }
}

function attempt(ctx: Ctx): { ok: boolean; target: string; error?: string } {
  const result = registerTab(ctx, {
    id: TAB_ID,
    title: () => "UniTerminal",
    component: UniterminalTab,
    icon: terminalTabIcon,
    description: "SSH 终端：主机列表、多会话、SFTP、隧道",
  });
  const entry: { target: string; ok: boolean; error?: string } = { target: result.target, ok: result.ok };
  if (result.error !== undefined) entry.error = result.error;
  diag.attempts.push(entry);
  return result;
}

/** 浏览器半边入口：注入样式 + 注册右栏 tab 类型；任何失败都只记录，绝不拖垮 web shell。 */
export function apply(ctx: Ctx): void {
  diag.phase = "apply";
  diag.services = {
    betterSidebar: describe(ctx, "betterSidebar"),
    sidebarRightTabs: describe(ctx, "sidebarRightTabs"),
    inject: typeof ctx["inject"],
  };
  console.info("[uniterminal] apply called, services seen:", diag.services);

  try {
    ensureUniterminalCss();
  } catch (error) {
    console.warn("uniterminal: style injection failed:", error);
  }

  try {
    const first = attempt(ctx);
    if (first.ok) {
      diag.finalTarget = first.target;
      console.info("[uniterminal] tab type registered into " + first.target);
      return;
    }

    let settled = false;
    const finish = (ok: boolean, target: string, error?: string): void => {
      if (settled) return;
      settled = true;
      diag.finalTarget = target;
      if (!ok) {
        diag.finalError = String(error);
        console.info("[uniterminal] registration FAILED, target=" + target);
        warn(ctx, "uniterminal: right pane unavailable (" + target + "): " + String(error));
      } else {
        console.info("[uniterminal] tab type registered into " + target + " (after waiting)");
      }
    };

    const injectFn = ctx["inject"];
    if (typeof injectFn === "function") {
      const waitFor = (service: string): void => {
        (injectFn as (deps: string[], cb: (scoped: Ctx) => void) => void)([service], (scoped) => {
          const result = attempt(scoped);
          finish(result.ok, result.target, result.error);
        });
      };
      waitFor("betterSidebar");
      waitFor("sidebarRight");
    }

    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      const result = attempt(ctx);
      if (result.ok) {
        clearInterval(timer);
        finish(true, result.target);
        return;
      }
      if (attempts >= 10) {
        clearInterval(timer);
        finish(false, result.target, result.error);
      }
    }, 300);
  } catch (error) {
    diag.phase = "apply-failed";
    console.warn("uniterminal: apply failed without breaking the shell:", error);
  }
}
