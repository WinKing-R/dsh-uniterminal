/**
 * 右键菜单相对面板的位置。
 *
 * 【为什么需要它】菜单是 `position: absolute`，锚点取"触发元素/鼠标点"。
 * 但「更多操作」按钮在**行尾**、右键也可能点在**面板右半边**——
 * 菜单一律向右伸展就会伸出面板右边缘，被**宿主的 overflow 裁掉**
 * （面板自己没设 overflow，裁剪来自它的宿主祖先，我们改不了）。
 * 真机表现：菜单右边被切掉，「移入分组…」「测试连接」只显示半截。
 *
 * 解法只有一条：**靠右时把菜单的右边缘对齐锚点**，让它向左展开。
 * 不量菜单本身宽度（内容驱动、随文案变），只按锚点在面板里的相对位置判断，
 * 所以没有"测量后布局抖动"的问题。
 */
export interface MenuAnchor {
  /** 与 right 互斥：两者都设会让 absolute 元素被拉伸。 */
  left?: number;
  right?: number;
  top: number;
}

/**
 * @param anchorX 锚点的横向位置（相对面板左边缘，像素）
 * @param anchorY 锚点的纵向位置（相对面板上边缘，像素）
 * @param paneWidth 面板宽度；0 或未知时退回左对齐（总比跑到面板外好）
 */
export function menuAnchor(anchorX: number, anchorY: number, paneWidth: number): MenuAnchor {
  const top = Math.max(0, anchorY);
  if (paneWidth > 0 && anchorX > paneWidth / 2) {
    // 右半屏：菜单右边缘贴锚点，向左展开
    return { right: Math.max(0, paneWidth - anchorX), top };
  }
  return { left: Math.max(0, anchorX), top };
}
