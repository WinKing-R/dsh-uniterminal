/** 构建期把 .css 变成“导出 CSS 文本的字符串模块”（见 tsdown.config.ts 的 cssAsString 插件）。 */
declare module "*.css" {
  const cssText: string;
  export default cssText;
}
