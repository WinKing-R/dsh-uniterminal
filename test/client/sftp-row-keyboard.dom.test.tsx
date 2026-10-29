// @vitest-environment jsdom
/**
 * DOM 级回归锁：SFTP 文件行的「选中」接进键盘（B5 无障碍第四段）。
 *
 * 【为什么必须有 DOM 级测试】这一条的用户价值全在"行为"上，源码字符串断言抓不住：
 * ① 文件名真的是 role="button"（在 Tab 序列里，键盘能停上去）；
 * ② 按回车/空格真的把 aria-pressed 从 false 翻成 true；
 * ③ 选中之后工具栏「删除」**真的**从禁用变可用——这才是"键盘用户删得掉文件"；
 * ④ 单击目录名仍然只是选中，**不进入目录**（进入还在双击与动作列按钮上）。
 *
 * 【怎么处理 fetch】SftpPanel 挂载时 POST 一次 {op:"ls"}：这里 vi.mock 掉 ./api.js
 * （仓库里已有这种打法），列表就能在 jsdom 里真实渲染出来。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SftpPanel } from "../../src/client/SftpPanel.js";

/** ls 回一行文件 + 一行目录；其余 op 一律成功。字面量写在工厂里：vi.mock 会被提升。 */
vi.mock("../../src/client/api.js", () => ({
  api: {
    get: () => Promise.resolve({ ok: true, data: {} }),
    post: (_path: string, body: { op?: string }) =>
      Promise.resolve(
        body.op === "ls"
          ? {
              ok: true,
              data: {
                entries: [
                  { name: "notes.txt", path: "/notes.txt", type: "file", size: 12, mtime: 0, mode: 0 },
                  { name: "logs", path: "/logs", type: "dir", size: 0, mtime: 0, mode: 0 },
                ],
              },
            }
          : { ok: true, data: { ok: true } },
      ),
  },
  errorText: () => "请求失败",
}));

/** 本包 vitest 没开 globals，RTL 的自动 cleanup 注册不上，要显式清理。 */
afterEach(cleanup);

const isDisabled = (name: string): boolean =>
  (screen.getByRole("button", { name }) as HTMLButtonElement).disabled;

describe("SFTP 的「选中」是键盘可达的动作（WCAG 2.1.1）", () => {
  it("文件名是按钮，回车选中后 aria-pressed 翻真、删除按钮才可用", async () => {
    const user = userEvent.setup();
    render(<SftpPanel sessionId="s1" />);

    const name = await screen.findByRole("button", { name: "notes.txt" });
    expect(name.getAttribute("aria-pressed")).toBe("false");
    // 选中之前删除按钮是禁用的：没有选中项就没什么可删
    expect(isDisabled("删除")).toBe(true);

    // 真的能键盘聚焦：Tab 序列里停得上去（不是只能点）
    name.focus();
    expect(document.activeElement).toBe(name);
    await user.keyboard("{Enter}");

    expect(name.getAttribute("aria-pressed")).toBe("true");
    expect(isDisabled("删除")).toBe(false);
  });

  it("单击目录名只选中，不进入目录（进入靠双击或动作列按钮）", async () => {
    const user = userEvent.setup();
    render(<SftpPanel sessionId="s1" />);

    const dir = await screen.findByRole("button", { name: "logs" });
    await user.click(dir);

    expect(dir.getAttribute("aria-pressed")).toBe("true");
    // 还在根目录：一旦误进目录，根上的「上级目录」就不再禁用了
    expect(isDisabled("上级目录")).toBe(true);
  });

  it("点行本身（不是文件名）仍然能选中：鼠标便利没有丢", async () => {
    const user = userEvent.setup();
    render(<SftpPanel sessionId="s1" />);

    const name = await screen.findByRole("button", { name: "notes.txt" });
    const row = name.closest(".uniterminal-row");
    expect(row).not.toBeNull();

    await user.click(row as HTMLElement);

    expect(name.getAttribute("aria-pressed")).toBe("true");
    expect(isDisabled("删除")).toBe(false);
  });
});
