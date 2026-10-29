import { readFileSync } from "node:fs";
import { defineConfig, type TsdownPlugin } from "tsdown";

// 客户端包裹的 id 与真实宿主产物一致：取包名（见 @linxin666/dsh-ssh/lib/client.js）。
const CLIENT_MODULE_ID = "@winking-r/dsh-uniterminal";

const CLIENT_BANNER = [
  "window.__ModuleLoader__.load({",
  `\tid: "${CLIENT_MODULE_ID}",`,
  "\tfactory: (require) => {",
  "\t\tvar module = { exports: {} };",
  "\t\tvar exports = module.exports;",
].join("\n");

const CLIENT_FOOTER = ["\t\treturn module.exports;", "\t}", "});"].join("\n");

// 与真实插件一致：CSS 不作为独立资源，而是变成“导出 CSS 文本的字符串模块”
// （本机证据：@linxin666/dsh-ssh 的 xterm.css.ts），运行时注入 <style data-plugin-css>。
const CSS_MODULE_PREFIX = "\0dsh-css:";
// 虚拟 id 以 .mjs 结尾：与真实产物里的 \0dsh-css:…xterm.css.mjs 同名，
// 同时避开 tsdown 的 css-guard（它会对以 .css 结尾的 id 要求安装 @tsdown/css）。
const CSS_MODULE_SUFFIX = ".mjs";

const cssAsString: TsdownPlugin = {
  name: "uniterminal-css-as-string",
  async resolveId(source, importer) {
    if (!source.endsWith(".css")) return null;
    const resolved = await this.resolve(source, importer, { skipSelf: true });
    if (resolved === null || resolved.external) return null;
    return CSS_MODULE_PREFIX + resolved.id + CSS_MODULE_SUFFIX;
  },
  load(id) {
    if (!id.startsWith(CSS_MODULE_PREFIX) || !id.endsWith(CSS_MODULE_SUFFIX)) return null;
    const file = id.slice(CSS_MODULE_PREFIX.length, id.length - CSS_MODULE_SUFFIX.length);
    return "export default " + JSON.stringify(readFileSync(file, "utf8")) + ";";
  },
};

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: "esm",
    platform: "node",
    outDir: "lib",
    // TS 7.0.2 原生端口没有 rolldown-plugin-dts 需要的 classic API；本包 exports 不声明 types。
    dts: false,
    outExtensions: () => ({ js: ".js" }),
    // @napi-rs/keyring 是原生模块：绝不能打进产物（打包会失败，且 .node 必须由 Node 直接 require）。
    external: ["ssh2", "ws", "@deepseek-ai/cordis", "@deepseek-ai/schemastery", "@napi-rs/keyring"],
  },
  {
    entry: { client: "src/client/index.ts" },
    format: "cjs",
    platform: "browser",
    outDir: "lib",
    dts: false,
    outExtensions: () => ({ js: ".js" }),
    // react 由宿主 loader 的 require 解析（与本机真实插件一致），xterm 必须打进产物。
    deps: {
      neverBundle: ["react", "react/jsx-runtime", "@deepseek-ai/dsh-client-ui-primitives"],
      alwaysBundle: [/^@xterm\//],
      onlyBundle: [/^@xterm\//],
    },
    plugins: [cssAsString],
    outputOptions: {
      banner: CLIENT_BANNER,
      footer: CLIENT_FOOTER,
    },
  },
]);