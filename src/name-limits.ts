/**
 * 名称长度上限的唯一来源。
 *
 * 主机名与分组名共用一个值：两者都排在一行里、都要给右侧按钮留位置，
 * 曾经各写一份（主机 16、分组 64），结果分组名能写成一长串把标题行撑爆。
 */
export const NAME_MAX = 16;

export function nameTooLong(value: string): boolean {
  return value.trim().length > NAME_MAX;
}

/** 统一的错误文案；label 用中文（"名称"/"分组名"）。 */
export function nameLimitMessage(label: string): string {
  return label + "不能超过 " + NAME_MAX + " 个字符";
}
