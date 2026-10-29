// @vitest-environment jsdom
/**
 * DOM 级回归锁：自绘下拉（键盘、ARIA、点外面收起）。
 *
 * 这个组件的复杂度全在键盘与焦点上：
 * 焦点**始终留在按钮上**，用 aria-activedescendant 指向当前项（listbox 的标准做法）；
 * Esc 只收自己的键、不能冒到外层把整个浮层也关掉。
 * 这些以前只有"源码里出现过 ArrowDown / aria-activedescendant"这种字符串断言。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactElement } from "react";
import { SelectField, type SelectOption } from "../../src/client/select-field.js";

/** 本包 vitest 没开 globals，RTL 的自动 cleanup 注册不上，要显式清理。 */
afterEach(cleanup);

const OPTIONS: readonly SelectOption[] = [
  { value: "local", label: "本地转发 -L" },
  { value: "remote", label: "远程转发 -R" },
  { value: "socks", label: "动态 SOCKS5 -D" },
];

function FieldHarness(props: { onChange: (value: string) => void; onOuterKey?: (key: string) => void }): ReactElement {
  const [value, setValue] = useState("local");
  return (
    <div onKeyDown={(event) => props.onOuterKey?.(event.key)}>
      <SelectField
        label="模式"
        value={value}
        options={OPTIONS}
        onChange={(next) => {
          props.onChange(next);
          setValue(next);
        }}
      />
    </div>
  );
}

describe("select field — DOM 级交互", () => {
  it("收起时显示当前值，按钮带 listbox 的可访问性属性", () => {
    render(<FieldHarness onChange={() => undefined} />);

    const button = screen.getByRole("button", { name: "模式" });
    expect(button.getAttribute("aria-haspopup")).toBe("listbox");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("本地转发 -L")).toBeDefined();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("点开出现 listbox，选项带 role=option 与选中态", async () => {
    const user = userEvent.setup();
    render(<FieldHarness onChange={() => undefined} />);

    await user.click(screen.getByRole("button", { name: "模式" }));

    expect(screen.getByRole("listbox")).toBeDefined();
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(3);
    expect(options[0]?.getAttribute("aria-selected")).toBe("true");
    expect(options[1]?.getAttribute("aria-selected")).toBe("false");
  });

  it("方向键移动当前项，焦点始终留在按钮上（aria-activedescendant）", async () => {
    const user = userEvent.setup();
    render(<FieldHarness onChange={() => undefined} />);

    const button = screen.getByRole("button", { name: "模式" });
    await user.click(button);
    const options = screen.getAllByRole("option");

    expect(button.getAttribute("aria-activedescendant")).toBe(options[0]?.id);

    await user.keyboard("{ArrowDown}");

    expect(button.getAttribute("aria-activedescendant")).toBe(options[1]?.id);
    // 焦点没有挪到选项上——焦点留在按钮，这是 listbox 的标准做法
    expect(document.activeElement).toBe(button);
  });

  it("回车选中当前项并收起", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<FieldHarness onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: "模式" }));
    await user.keyboard("{ArrowDown}{Enter}");

    expect(onChange).toHaveBeenCalledWith("remote");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("Esc 只收自己的键，不冒到外层（不会把整个浮层也关掉）", async () => {
    const onChange = vi.fn();
    const onOuterKey = vi.fn();
    const user = userEvent.setup();
    render(<FieldHarness onChange={onChange} onOuterKey={onOuterKey} />);

    await user.click(screen.getByRole("button", { name: "模式" }));
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(onOuterKey).not.toHaveBeenCalledWith("Escape");
  });

  it("点外面收起，不触发 onChange", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <div>
        <FieldHarness onChange={onChange} />
        <button type="button">外面</button>
      </div>,
    );

    await user.click(screen.getByRole("button", { name: "模式" }));
    await user.click(screen.getByRole("button", { name: "外面" }));

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});
