/** 保存前要确认的"会丢掉什么"。 */
export type DroppedSecret = "password" | "keyPath";

export interface StoredCredentialFacts {
  /** 凭据库里是否还存着这台主机的密码。 */
  rememberedPassword: boolean;
  /** 存档里是否记着私钥路径。 */
  storedKeyPath?: string;
}

export interface SaveIntent {
  usePassword: boolean;
  remember: boolean;
  useKey: boolean;
  rememberKeyPath: boolean;
  identityPath: string;
}

/**
 * 取消勾选并保存 = 主动丢弃已存的东西，所以要先问一句。
 *
 * 只算"确实存在且这次会被清掉"的项：本来就没存过密码的机器，取消勾选不该弹框。
 * **私钥文件本身永远不删**——这里只说"路径不再保存"。
 */
export function droppedSecrets(facts: StoredCredentialFacts, intent: SaveIntent): DroppedSecret[] {
  const dropped: DroppedSecret[] = [];
  const keepPassword = intent.usePassword && intent.remember;
  if (facts.rememberedPassword && !keepPassword) dropped.push("password");

  const hasPath = (facts.storedKeyPath ?? "").trim() !== "";
  const keepPath = intent.useKey && intent.rememberKeyPath && intent.identityPath.trim() !== "";
  if (hasPath && !keepPath) dropped.push("keyPath");

  return dropped;
}

/** 弹框正文：按实际会丢的东西组织，不含糊其辞。 */
export function droppedSecretsMessage(dropped: readonly DroppedSecret[]): string {
  const parts: string[] = [];
  if (dropped.includes("password")) parts.push("已保存的密码");
  if (dropped.includes("keyPath")) parts.push("已保存的私钥路径");
  return (
    "取消勾选并保存后，会删除" +
    parts.join("与") +
    "（私钥文件本身不会被删除）。确定保存吗？"
  );
}
