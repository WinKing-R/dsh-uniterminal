import Schema from "@deepseek-ai/schemastery";
import type { AppearancePatch } from "./store/appearance.js";
import type { UnknownHostKeyPolicy } from "./store/known-hosts.js";

export interface Config {
  bufferBytes: number;
  term: string;
  connectTimeoutMs: number;
  /** 未知主机指纹的策略：reject 拒绝（默认，M1 验收路径）；trust 自动信任并落盘。 */
  knownHostsPolicy?: UnknownHostKeyPolicy;
  /**
   * M5-1：面向 AI 会话的执行入口。默认开——换任何会话都要能在这台机器连着的服务器上执行命令。
   * off 时既不注册工具，/sessions/exec 也一律 403。
   */
  agentExec?: "on" | "off";
  /**
   * M6-1 终端外观默认值（seed）：只填想改的字段，其余取内置默认。
   * 真正的用户值存在 ~/.dsh/uniterminal/appearance.json——插件不能写宿主配置，只把这里当默认值来源。
   */
  appearance?: AppearancePatch;
}

export const Config: Schema<Config> = Schema.object({
  bufferBytes: Schema.number().default(1 << 20).description("每个会话保留的输出字节数"),
  term: Schema.string().default("xterm-256color").description("SSH 终端类型"),
  connectTimeoutMs: Schema.number().default(20000).description("连接超时（毫秒）"),
  knownHostsPolicy: Schema.union([Schema.const("reject"), Schema.const("trust")])
    .default("reject")
    .description("未知主机指纹策略：reject 拒绝并要求显式信任，trust 自动信任"),
  agentExec: Schema.union([Schema.const("on"), Schema.const("off")])
    .default("on")
    .description("面向 AI 会话的 exec 入口：on 注册 uniterminal_exec 并开放 /sessions/exec，off 全部关闭"),
  appearance: Schema.object({
    fontFamily: Schema.string().description("默认字体（CSS font-family 列表）"),
    fontSize: Schema.number().description("默认字号（8..32 的整数）"),
    lineHeight: Schema.number().description("默认行高（1.0..2.0）"),
    letterSpacing: Schema.number().description("默认字距（0..5）"),
    themeMode: Schema.union([
      Schema.const("follow"),
      Schema.const("dark"),
      Schema.const("light"),
      Schema.const("custom"),
    ]).description("默认主题模式：follow 跟随 DSH 明暗，custom 用下面四个颜色"),
    background: Schema.string().description("自定义背景色（#rgb 或 #rrggbb）"),
    foreground: Schema.string().description("自定义前景色（#rgb 或 #rrggbb）"),
    cursor: Schema.string().description("光标颜色（#rgb 或 #rrggbb）"),
    selectionBackground: Schema.string().description("选中色（#rgb 或 #rrggbb）"),
  }).description("终端外观默认值：只填想改的字段，其余取内置默认"),
});
