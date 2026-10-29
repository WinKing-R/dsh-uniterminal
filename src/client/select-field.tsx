import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactElement } from "react";

export interface SelectOption {
  value: string;
  label: string;
}

/**
 * 自己画的下拉框。
 *
 * 为什么不用原生 `<select>`：它的**弹出层由浏览器绘制，不继承我们的主题变量**。
 * 深色主题下出现过"白底 + 浅灰字"，选项几乎看不见（用户实报）。
 * 换成自己渲染的列表后，颜色、边框、选中态全部走 `--ut-border` 与宿主主题变量。
 *
 * 键盘操作（M38 补齐）：↑/↓ 移动、Home/End 到两头、Enter/Space 选中、Esc 收起、Tab 收起并离开。
 * 焦点始终留在按钮上，用 `aria-activedescendant` 指向当前项——这是 listbox 的标准做法，
 * 比"把焦点挪到每个选项上"更稳（不会因为列表重渲染而丢焦点）。
 */
export function SelectField(props: {
  value: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
  label: string;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const selectedIndex = Math.max(0, props.options.findIndex((option) => option.value === props.value));
  const selected = props.options[selectedIndex];
  const optionId = (index: number): string => listId + "-option-" + String(index);

  // 点外面关闭：下拉是浮层，必须能"不选就退出"
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    return () => window.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const choose = (index: number): void => {
    const option = props.options[index];
    if (option === undefined) return;
    props.onChange(option.value);
    setOpen(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!open) {
      // 收起状态下按 ↓ / ↑ / Enter / Space 都等于"打开"
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
        event.preventDefault();
        setActiveIndex(selectedIndex);
        setOpen(true);
      }
      return;
    }
    const last = props.options.length - 1;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, last));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(last);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(activeIndex);
    } else if (event.key === "Escape") {
      // 只收自己的键：别让 Esc 冒到外层把整个浮层也关掉
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  };

  return (
    <div className="uniterminal-select" ref={rootRef} onKeyDown={onKeyDown}>
      <button
        type="button"
        className="uniterminal-select-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? optionId(activeIndex) : undefined}
        aria-label={props.label}
        onClick={() => {
          setActiveIndex(selectedIndex);
          setOpen((value) => !value);
        }}
      >
        <span className="uniterminal-select-value">{selected?.label ?? props.value}</span>
        <span className="uniterminal-select-caret" aria-hidden={true}>▾</span>
      </button>
      {open && (
        <div className="uniterminal-select-list" role="listbox" id={listId} aria-label={props.label}>
          {props.options.map((option, index) => (
            <button
              key={option.value}
              id={optionId(index)}
              type="button"
              role="option"
              aria-selected={option.value === props.value}
              className="uniterminal-select-option"
              style={index === activeIndex ? { background: "color-mix(in srgb, currentColor 12%, transparent)" } : undefined}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(index)}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
