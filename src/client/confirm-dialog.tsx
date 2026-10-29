import { useEffect, useId, useRef, type ReactElement } from "react";
import { reportClient } from "./report.js";

/**
 * 破坏性操作的确认弹框（删除主机 / 删除分组 / 断开连接 / 保存前确认 / 导入前确认）。
 *
 * **定位方式**：遮罩用 `position: absolute; inset: 0` 贴住所在面板（`.uniterminal-pane` 是 relative）。
 * 早期版本用 `position: fixed` + 视口坐标，被玻璃/壁纸主题打穿了：
 * 那类主题会在容器上加 `transform` / `backdrop-filter`，**这会给 fixed 造出新的包含块**，
 * 于是"视口坐标"被当成"相对该祖先的坐标"，弹框被放到屏幕外——表现为"点删除/断开没反应"。
 * 贴住面板就没有坐标系问题，也不需要量尺寸。
 */
export interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** 破坏性操作用危险色，避免"确认"看起来像普通按钮。 */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** 弹框里"可以按 Tab 到达"的元素。焦点陷阱只在这几个之间循环。 */
const TABBABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function ConfirmDialog(props: ConfirmDialogProps): ReactElement {
  const cancelRef = useRef<HTMLButtonElement>(null);
  /** 弹框节点：焦点陷阱要靠它找出边界（第一个 / 最后一个可 Tab 的元素）。 */
  const dialogRef = useRef<HTMLDivElement>(null);
  /**
   * 正文的稳定 id：`aria-describedby` 要把「从本机列表删除 web-01？」这句**关键正文**
   * 绑给读屏。只有 aria-label（标题）时，读屏念完「删除主机」就停了，
   * 用户根本不知道这次要删的是哪一台。用 useId 而不是写死 id：同一屏可能同时存在多个弹框。
   */
  const messageId = useId();
  const { onCancel } = props;

  // 自检：贴住的祖先如果不是 .uniterminal-pane，说明定位上下文被别处改写了——
  // 这正是"弹框跑到窗口中间/角落"的根因，直接写进 diag，不再靠猜。
  useEffect(() => {
    const parent = cancelRef.current?.closest(".uniterminal-modal-backdrop")?.parentElement?.closest(".uniterminal-pane");
    if (parent === null || parent === undefined) {
      const backdrop = cancelRef.current?.closest(".uniterminal-modal-backdrop") as HTMLElement | null;
      reportClient("client.dialog-off-pane", {
        offsetParent: backdrop?.offsetParent instanceof HTMLElement ? backdrop.offsetParent.className.slice(0, 80) : "none",
      });
    }
  }, []);

  // 打开即把焦点放到「取消」上：回车不会误触发删除（破坏性操作绝不能是默认焦点）。
  // 同一时刻记住"打开前焦点在哪"——遮罩已经挂上来了，但 activeElement 还是触发弹框的那个按钮；
  // 卸载时还回去，否则键盘用户关掉弹框后焦点掉到 body，得从页面开头重新 Tab 一遍。
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    return () => {
      // 元素已经不在 DOM 里（例如它所在的列表行被删掉了）就跳过，别把焦点丢进虚空。
      if (previous !== null && previous.isConnected) previous.focus();
    };
  }, []);

  // 焦点陷阱：Tab / Shift+Tab 只在弹框内循环。
  // 挂在 window 捕获阶段而不是弹框自己的 onKeyDown 上——焦点一旦跑到弹框之外
  // （例如用户点了弹框里的纯文本，焦点回到 body），挂在弹框上的处理器就再也收不到按键，
  // 陷阱会**永久漏水**，一次都拦不住。
  useEffect(() => {
    const onTab = (event: KeyboardEvent): void => {
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (dialog === null) return;
      const nodes = Array.from(dialog.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR));
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (first === undefined || last === undefined) return;
      const inside = dialog.contains(document.activeElement);
      if (event.shiftKey) {
        if (inside && document.activeElement !== first) return;
        event.preventDefault();
        last.focus();
        return;
      }
      if (inside && document.activeElement !== last) return;
      event.preventDefault();
      first.focus();
    };
    window.addEventListener("keydown", onTab, true);
    return () => window.removeEventListener("keydown", onTab, true);
  }, []);

  // Esc 取消。用捕获阶段并吃掉事件，免得同一次按键再被终端或其他快捷键处理。
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  return (
    <div className="uniterminal-modal-backdrop" role="presentation" onClick={onCancel}>
      <div
        ref={dialogRef}
        className="uniterminal-modal"
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        aria-describedby={messageId}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="uniterminal-modal-title">{props.title}</div>
        <div className="uniterminal-modal-text" id={messageId}>
          {props.message}
        </div>
        <div className="uniterminal-modal-actions">
          <button type="button" ref={cancelRef} onClick={onCancel}>
            {props.cancelLabel ?? "取消"}
          </button>
          <button
            type="button"
            style={{ color: props.danger === true ? "var(--dsw-alias-label-error, #e5534b)" : undefined }}
            onClick={props.onConfirm}
          >
            {props.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
