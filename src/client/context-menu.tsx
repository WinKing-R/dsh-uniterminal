import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from "react";

export interface ContextMenuItem {
  label: string;
  onSelect: () => void;
  /** 破坏性操作用危险色。 */
  danger?: boolean;
  disabled?: boolean;
}

export interface ContextMenuProps {
  /**
   * 相对面板的坐标（面板本身是定位上下文）。
   *
   * **left 与 right 互斥**，由 `menuAnchor()` 决定用哪一个：
   * 锚点靠右时改用 right（菜单向左展开），否则会伸出面板右边缘被宿主的 overflow 裁掉。
   * 两个都设会让 `position: absolute` 的元素被拉伸到两边贴齐。
   */
  left?: number;
  right?: number;
  top: number;
  items: readonly ContextMenuItem[];
  onClose: () => void;
  /**
   * 触发菜单的那个元素：菜单关闭时把焦点还回去。
   *
   * 拿不到（没传 / 已经不在 DOM 里）就**不还**——瞎猜一个 body 只会把焦点甩到文档开头，
   * 键盘与读屏用户因此丢掉"我刚才在列表的哪一行"这个上下文。
   */
  returnFocusTo?: HTMLElement | null;
  /**
   * 菜单的可访问名（B5）。
   *
   * `role="menu"` 只有名字，读屏用户才知道"这是**谁**的操作菜单"：
   * 同一屏上主机菜单与分组菜单结构一模一样，没有名字时两者读起来没有区别。
   */
  label?: string;
}

/** 菜单内**可获得焦点**的项：禁用项本身不可聚焦，方向键必须跨过它。 */
function focusableItems(nodes: readonly (HTMLButtonElement | null)[]): HTMLButtonElement[] {
  return nodes.filter((node): node is HTMLButtonElement => node !== null && !node.disabled);
}

/**
 * 右键菜单：把不常用的行内动作从列表里挪走，行内只留"连接 / 测试"。
 *
 * 定位用相对面板的坐标（absolute），不依赖视口；面板是 `position: relative`，
 * 所以主题给祖先加 transform 也不会把它带走。
 */
export function ContextMenu(props: ContextMenuProps): ReactElement {
  const { onClose } = props;
  /** 菜单根节点：用来判断"这次 mousedown 是不是点在菜单内部"。 */
  const rootRef = useRef<HTMLDivElement>(null);
  /** 每一项的 ref：方向键要在"可获得焦点的项"之间循环移动。 */
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  /** 关闭时要把焦点还回去的元素：在挂载那一刻记下（此时触发元素一定已经在 DOM 里）。 */
  const returnFocusRef = useRef<HTMLElement | null>(props.returnFocusTo ?? null);

  // 打开就把焦点送进第一项。
  // 不送的话菜单虽然画出来了，焦点还留在外面：方向键、回车全落在菜单之外的元素上，
  // 键盘用户看到的就是"菜单弹出来了，但按什么都没反应"。
  useEffect(() => {
    focusableItems(itemRefs.current)[0]?.focus();
  }, []);

  // 关闭时把焦点还给触发元素；元素已经不在 DOM 里（例如它所在的行被删掉）就跳过。
  useEffect(
    () => () => {
      const target = returnFocusRef.current;
      if (target !== null && target.isConnected) target.focus();
    },
    [],
  );

  useEffect(() => {
    // 点在菜单**内部**时不能关菜单。
    // 旧实现无条件 onClose()，而且监听挂在**捕获阶段**：
    // 捕获阶段先于冒泡阶段执行，菜单根 div 上的 stopPropagation（冒泡阶段）拦不住它，
    // 于是 mousedown 就把菜单卸载了，后面的 mouseup / click 落不到菜单项上，
    // item.onSelect() 永不执行——真机上表现为"右键菜单里每一项都点不动"。
    // contains() 判断让"点菜单项"这条路径根本不触发关菜单，mouseup/click 必定落在按钮上。
    const onPointerDown = (event: MouseEvent): void => {
      const node = rootRef.current;
      if (node !== null && event.target instanceof Node && node.contains(event.target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    // 窗口尺寸变了，菜单的定位就没意义了：直接关掉。
    const onResize = (): void => onClose();
    // mousedown 仍留在捕获阶段（点在菜单外时，目标可能不在菜单所在的 DOM 子树里），
    // 但"点在菜单里就不关"由上面的包含判断保证，与阶段无关。
    window.addEventListener("mousedown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("mousedown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", onResize);
    };
  }, [onClose]);

  /**
   * 方向键 / Home / End / Tab。
   * 挂在菜单根节点（而不是 window）上：焦点已经在菜单里，按键必然从这里冒泡上来，
   * 不会误吞页面上别处的同类按键。Escape 仍由上面的窗口监听负责，这里不重复处理。
   */
  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Tab") {
      // menu 模式的惯例：Tab 不在菜单里停留，离开即关闭。
      onClose();
      return;
    }
    const nodes = focusableItems(itemRefs.current);
    if (nodes.length === 0) return;
    const current = nodes.findIndex((node) => node === document.activeElement);
    /** 取模让首尾相接：最后一项再按 ArrowDown 回到第一项，反之亦然。 */
    const focusAt = (index: number): void => {
      nodes[(index + nodes.length) % nodes.length]?.focus();
    };
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusAt(current === -1 ? 0 : current + 1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      focusAt(current === -1 ? nodes.length - 1 : current - 1);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      focusAt(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      focusAt(nodes.length - 1);
    }
  };

  return (
    <div
      ref={rootRef}
      className="uniterminal-context-menu"
      role="menu"
      aria-label={props.label}
      style={{ left: props.left, right: props.right, top: props.top }}
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={onMenuKeyDown}
    >
      {props.items.map((item, index) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          // 菜单项不是 Tab 停靠点：Tab 是"离开菜单"的意思，进菜单靠打开时的焦点与方向键。
          tabIndex={-1}
          ref={(node) => {
            itemRefs.current[index] = node;
          }}
          disabled={item.disabled}
          className="uniterminal-context-item"
          style={item.danger === true ? { color: "var(--dsw-alias-label-error, #e5534b)" } : undefined}
          onClick={() => {
            item.onSelect();
            onClose();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
