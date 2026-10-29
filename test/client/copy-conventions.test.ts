import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * 文案约定守卫（配合 docs/copy-guide.md）。
 *
 * 【为什么需要它】规范写在文档里，人会忘；测试不会。
 * 这里把**最容易复发、且复发时最伤用户**的几条钉死：
 *
 * ① **不许把内部字段名暴露给用户**（"响应缺少 session.id"这类）。
 *    用户看到它既不知道出了什么事，也不知道下一步该做什么。
 *    正确形状是「服务返回异常，请重试」，原始细节进 diag。
 * ② **不许出现工程编号**（"M1 只支持 SSH 连接："）——里程碑编号是给开发者看的。
 * ③ **不许出现"其它"**——统一用「其他」。
 * ④ **"口令"只允许出现在"私钥口令"这个词组里**——
 *    密码统一叫「密码」；"口令保护"是已取消的加密能力（台账 D-2a），界面里不许提。
 *
 * 【扫描范围】src/client/** 里**含中文的字符串字面量**——
 * 只有字面量是真正显示给用户的文本（JSX 里的静态文本也是，但本项目这类文案都在字面量里）。
 * 注释与代码标识符不参与，避免把"文档里提到 session.id"也算成违规。
 *
 * 【为什么先剥注释】注释里带引号的中文（例：不再因为"本机还记得口令"…）
 * 不是用户可见文案，却会被字面量提取正则当成文案——那是**误报**，
 * 迁就扫描器去改注释是把方向搞反了。所以这里先把注释剥掉，再提取字面量。
 */

const CLIENT_DIR = new URL("../../src/client/", import.meta.url);

/**
 * 剥掉注释，字符串字面量原样保留。
 *
 * 为什么不能直接用正则按行删注释：`//` 也可能出现在字符串里（"http://x"），
 * 按行切会把后面整行连同那个字符串一起吃掉。这里按**字符顺序**扫一遍：
 * - 处在字符串里（单引号 / 双引号 / 模板串）就整段跳过——里面的 `//` 不是注释；
 * - 只有处在"代码"状态下遇到的 `//` 与 `/*` 才是注释。
 *
 * 模板串的 `${…}` 里可能又出现字符串，所以用栈记录"该回到哪种状态"；
 * 插值里的 `{` / `}` 用计数器配平，免得提前退出插值。
 *
 * 注释里的字符换成空格、换行原样保留：返回的串与原文等长，行号列号都不变。
 */
function stripComments(source: string): string {
  const out = source.split("");
  const n = source.length;
  type Frame = { kind: "code"; braces: number } | { kind: "string"; quote: string };
  const stack: Frame[] = [{ kind: "code", braces: 0 }];
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to; i += 1) if (out[i] !== "\n") out[i] = " ";
  };
  let i = 0;
  while (i < n) {
    const top = stack[stack.length - 1];
    if (top === undefined) break;
    if (top.kind === "string") {
      const ch = source[i];
      // 转义：下一个字符一定是字面量的一部分（\\" 不算引号）
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === top.quote) {
        stack.pop();
        i += 1;
        continue;
      }
      // 模板串的插值：回到"代码"状态，插值结束再回到模板串
      if (top.quote === "`" && ch === "$" && source[i + 1] === "{") {
        stack.push({ kind: "code", braces: 0 });
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    const ch = source[i];
    if (ch === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      stack.push({ kind: "string", quote: ch });
      i += 1;
      continue;
    }
    if (ch === "{") {
      top.braces += 1;
      i += 1;
      continue;
    }
    if (ch === "}") {
      if (top.braces > 0) {
        top.braces -= 1;
        i += 1;
        continue;
      }
      // 插值结束：回到外层的模板串
      if (stack.length > 1) {
        stack.pop();
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return out.join("");
}

/** 含中文的字符串字面量（含单引号/双引号/模板串）；注释里的不算。 */
function userFacingLiterals(source: string): string[] {
  const found: string[] = [];
  const pattern = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
  for (const match of stripComments(source).matchAll(pattern)) {
    const value = match[2];
    if (value === undefined) continue;
    if (!/[\u4e00-\u9fff]/.test(value)) continue;
    found.push(value);
  }
  return found;
}

async function collectUserFacingLiterals(): Promise<Array<{ file: string; text: string }>> {
  const dir = new URL(".", CLIENT_DIR);
  const entries = await readdir(dir);
  const out: Array<{ file: string; text: string }> = [];
  for (const name of entries) {
    if (!name.endsWith(".ts") && !name.endsWith(".tsx")) continue;
    const source = await readFile(new URL(name, CLIENT_DIR), "utf8");
    for (const text of userFacingLiterals(source)) out.push({ file: name, text });
  }
  return out;
}

describe("文案约定（docs/copy-guide.md）", () => {
  it("用户可见文案里不出现内部字段名与内部标识", async () => {
    const literals = await collectUserFacingLiterals();
    expect(literals.length).toBeGreaterThan(50);

    const forbidden = ["session.id", "ws 地址", "响应缺少", "字段缺少"];
    const offenders = literals.filter((item) => forbidden.some((token) => item.text.includes(token)));
    expect(
      offenders.map((item) => item.file + "：" + item.text),
      "这些文案把内部实现暴露给用户了——改成「服务返回异常，请重试」，原始细节写进 diag",
    ).toEqual([]);
  });

  it("用户可见文案里不出现里程碑编号", async () => {
    const literals = await collectUserFacingLiterals();
    const offenders = literals.filter((item) => /\bM\d+\b/.test(item.text));
    expect(
      offenders.map((item) => item.file + "：" + item.text),
      "里程碑编号是给开发者看的，不给用户",
    ).toEqual([]);
  });

  it("统一用「其他」，不用「其它」", async () => {
    const literals = await collectUserFacingLiterals();
    const offenders = literals.filter((item) => item.text.includes("其它"));
    expect(
      offenders.map((item) => item.file + "：" + item.text),
      "统一用「其他」",
    ).toEqual([]);
  });

  it("「口令」只允许出现在私钥口令这个词组里", async () => {
    const literals = await collectUserFacingLiterals();
    const offenders = literals.filter((item) => item.text.includes("口令") && !item.text.includes("私钥"));
    expect(
      offenders.map((item) => item.file + "：" + item.text),
      "密码统一叫「密码」；「口令保护」是已取消的加密能力，界面里不许提",
    ).toEqual([]);
  });

  it("注释里的引号中文不算界面文案（先剥注释再提取字面量）", async () => {
    // 回归锁：注释里带引号的中文曾经被当成界面文案，害得注释被改成别的说法。
    // 这里直接验剥离：注释里的引号内容既不会被提取，也不会破坏字符串字面量本身。
    const commented = [
      '// 历史事实："本机还记得口令"这句曾经出现在界面上',
      'const a = "地址 http://x";',
      '/* 块注释里的"其它"也不算数 */',
    ].join("\n");
    const literals = userFacingLiterals(commented);

    // 真字面量照旧提取得到
    expect(literals).toEqual(["地址 http://x"]);
    // 注释里的中文一个字都不在里面
    expect(literals.join("|")).not.toContain("口令");
    expect(literals.join("|")).not.toContain("其它");
    // 字符串字面量里的 // 原样保留，没有被当成行注释吃掉
    expect(literals[0]).toContain("http://x");
  });
});
