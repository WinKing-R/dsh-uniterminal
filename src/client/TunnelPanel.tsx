import { useEffect, useState } from "react";
import { api } from "./api.js";
import { SelectField } from "./select-field.js";
import { SELECT_STYLE } from "./ui.js";
import { reportClient } from "./report.js";
import { noticeLiveProps } from "./notice.js";

const TUNNELS_ENDPOINT = "/api/uniterminal/tunnels";
const TUNNEL_STOP_ENDPOINT = "/api/uniterminal/tunnels/stop";

/** 后端只接受回环监听：界面不给改的机会，也不替用户猜别的值。 */
const BIND_HOST = "127.0.0.1";
const BIND_HOST_NOTE = "只监听本机回环，局域网其他机器无法访问";
/** -R 的远端监听在停止隧道时撤不掉（只有会话关闭才回收），必须让用户知道。 */
const REMOTE_RELEASE_NOTE = "远端端口在会话关闭时才会释放";
const SOCKS_NO_DEST_NOTE = "动态代理无需目标：目标由每个 SOCKS5 请求自己决定";

/** 与 engine/tunnel.ts 的 TunnelMode 一致。 */
type TunnelMode = "local" | "remote" | "socks";

/** GET /tunnels 里的一条快照（字段与 TunnelInfo 对齐，永远不含凭据）。 */
interface TunnelInfo {
  id: string;
  sessionId: string;
  mode: TunnelMode;
  bindHost: string;
  bindPort: number;
  destHost: string | null;
  destPort: number | null;
  state: "active" | "stopped";
  bytesIn: number;
  bytesOut: number;
  createdAt: number;
}

interface TunnelListResponse {
  tunnels?: TunnelInfo[];
  error?: string;
}

interface StartTunnelResponse {
  tunnel?: TunnelInfo;
  error?: string;
}

interface StopTunnelResponse {
  ok?: boolean;
  stopped?: boolean;
  error?: string;
}

/**
 * 隧道模式的**唯一一份**定义：下拉选项与列表里的模式名都从这里取。
 * 原来 MODE_LABEL 与 MODE_OPTIONS 各写一遍同样的文案，改一处漏一处就会漂移。
 */
const MODE_OPTIONS: { value: TunnelMode; label: string }[] = [
  { value: "local", label: "本地转发 -L" },
  { value: "remote", label: "远程转发 -R" },
  { value: "socks", label: "动态 SOCKS5 -D" },
];

/** 列表里的模式名：从下拉选项推导，显示文本与选项逐字一致。 */
const MODE_LABEL: Record<TunnelMode, string> = Object.fromEntries(
  MODE_OPTIONS.map((option) => [option.value, option.label]),
) as Record<TunnelMode, string>;

const asMode = (value: string): TunnelMode => (value === "remote" || value === "socks" ? value : "local");

/** 1..65535 的整数端口；非法返回 undefined，由调用方给出文案（不发请求）。 */
function parsePort(text: string): number | undefined {
  const raw = text.trim();
  if (!/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) return undefined;
  return value;
}

/** 建好后可直接复制的地址：本地监听（-D 是 SOCKS5 代理入口）。 */
const addressOf = (tunnel: TunnelInfo): string => tunnel.bindHost + ":" + String(tunnel.bindPort);

const targetOf = (tunnel: TunnelInfo): string =>
  tunnel.destHost === null || tunnel.destPort === null
    ? "—"
    : tunnel.destHost + ":" + String(tunnel.destPort);

export interface TunnelPanelProps {
  sessionId: string;
}

/**
 * 隧道面板（M3-4b）：只看/只建本会话的 -L / -R / -D 转发，后端 engine/tunnel.ts 已就绪。
 * 所有 JSON 请求都走共享的 api.ts（失败是结构化的，永不抛错）；端口在这里先校验一遍，非法就不发请求。
 */
export function TunnelPanel({ sessionId }: TunnelPanelProps) {
  const [tunnels, setTunnels] = useState<TunnelInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | undefined>(undefined);
  const [reloadKey, setReloadKey] = useState(0);
  const [stoppingId, setStoppingId] = useState<string | undefined>(undefined);
  const [mode, setMode] = useState<TunnelMode>("local");
  const [bindPortText, setBindPortText] = useState("");
  const [destHostText, setDestHostText] = useState("127.0.0.1");
  const [destPortText, setDestPortText] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | undefined>(undefined);
  /** 刚建好的那条：地址要能一眼看到并复制。 */
  const [created, setCreated] = useState<TunnelInfo | undefined>(undefined);
  const [copyNotice, setCopyNotice] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setListError(undefined);
    void (async () => {
      try {
        const res = await api.get<TunnelListResponse>(TUNNELS_ENDPOINT);
        if (cancelled) return;
        if (!res.ok) {
          setTunnels([]);
          setListError(res.error.message);
          return;
        }
        setTunnels(res.data.tunnels ?? []);
      } catch (caught) {
        if (!cancelled) {
          setTunnels([]);
          setListError(String(caught));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, reloadKey]);

  async function copyAddress(address: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(address);
      setCopyNotice("已复制 " + address);
    } catch {
      setCopyNotice("复制失败：请手动选中地址复制");
    }
  }

  /** 建立一条隧道：端口与目标先在前端校验，非法时一个请求都不发。 */
  async function createTunnel(): Promise<void> {
    if (busy) return;
    setFormError(undefined);
    setCopyNotice(undefined);
    setCreated(undefined);
    const bindPort = parsePort(bindPortText);
    if (bindPort === undefined) {
      setFormError((mode === "remote" ? "远端监听端口" : "本地端口") + "必须是 1..65535 之间的整数");
      return;
    }
    let destHost: string | undefined;
    let destPort: number | undefined;
    if (mode !== "socks") {
      const host = destHostText.trim();
      if (host === "" || /\s/.test(host)) {
        setFormError("目标主机必须是主机名或 IP（不能为空、不能含空白）");
        return;
      }
      destHost = host;
      destPort = parsePort(destPortText);
      if (destPort === undefined) {
        setFormError("目标端口必须是 1..65535 之间的整数");
        return;
      }
    }
    const body: Record<string, unknown> = { sessionId, mode, bindHost: BIND_HOST, bindPort };
    // -D 的目标由每个 SOCKS 请求决定：后端会拒收 destHost/destPort，这里干脆不发
    if (destHost !== undefined && destPort !== undefined) {
      body.destHost = destHost;
      body.destPort = destPort;
    }
    setBusy(true);
    try {
      const res = await api.post<StartTunnelResponse>(TUNNELS_ENDPOINT, body);
      if (!res.ok) {
        setFormError(res.error.message);
        return;
      }
      const tunnel = res.data.tunnel;
      if (tunnel === undefined) {
        // 内部字段名不进界面（copy-guide §2.1）：原始细节只写进 diag，
        // 用户看到的是「请重试」这条能照做的下一步。
        reportClient("client.tunnel-create-failed", { reason: "missing-tunnel" });
        setFormError("建立失败：服务返回异常，请重试");
        return;
      }
      setCreated(tunnel);
      setBindPortText("");
      setDestPortText("");
      setReloadKey((key) => key + 1);
    } catch (caught) {
      setFormError(String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function stopTunnel(id: string): Promise<void> {
    if (stoppingId !== undefined) return;
    setStoppingId(id);
    setListError(undefined);
    setCopyNotice(undefined);
    try {
      const res = await api.post<StopTunnelResponse>(TUNNEL_STOP_ENDPOINT, { id });
      if (!res.ok) {
        setListError(res.error.message);
        return;
      }
      // stopped:false 表示这条早就不在了：幂等成功，照样刷新列表
      setCreated((current) => (current !== undefined && current.id === id ? undefined : current));
      setReloadKey((key) => key + 1);
    } catch (caught) {
      setListError(String(caught));
    } finally {
      setStoppingId(undefined);
    }
  }

  // 其他会话的隧道一律不显示：面板只对本次会话负责
  const visible = tunnels.filter((tunnel) => tunnel.sessionId === sessionId);
  const bindPortLabel = mode === "remote" ? "远端监听端口" : "本地端口";
  const destHostLabel = mode === "remote" ? "本地目标主机" : "目标主机";
  const destPortLabel = mode === "remote" ? "本地目标端口" : "目标端口";

  return (
    <div className="uniterminal-col-gap uniterminal-flex-auto uniterminal-fill" style={{ overflow: "auto" }}>
      <div className="uniterminal-row">
        <span className="uniterminal-body uniterminal-strong">本次会话的隧道</span>
        <button type="button" disabled={loading || stoppingId !== undefined} onClick={() => setReloadKey((key) => key + 1)}>
          刷新
        </button>
        {loading && <span className="uniterminal-hint">加载中…</span>}
      </div>
      <div
        className="uniterminal-fixed"
        style={{
          border: "1px solid var(--ut-border)",
          borderRadius: 4,
          overflow: "auto",
          maxHeight: 220,
        }}
      >
        <div
          className="uniterminal-small"
          style={{
            display: "flex",
            gap: 8,
            padding: "4px 8px",
            opacity: 0.7,
            borderBottom: "1px solid var(--ut-border)",
          }}
        >
          <span className="uniterminal-col-mode">模式</span>
          <span className="uniterminal-col-local">本地地址</span>
          <span className="uniterminal-grow">目标</span>
          <span className="uniterminal-col-state">状态</span>
          <span className="uniterminal-right uniterminal-col-state">操作</span>
        </div>
        {/* 隧道列表加载失败：与 SFTP 目录失败同一形态——B5 之前这处也完全静音。
            容器常驻，只有文字进条件。 */}
        <div {...noticeLiveProps("error")} className="uniterminal-live">
          {listError !== undefined && (
            <p className="uniterminal-notice uniterminal-break" style={{ padding: 8 }}>
              {listError}
            </p>
          )}
        </div>
        {listError === undefined && !loading && visible.length === 0 && (
          <p className="uniterminal-hint" style={{ padding: 8 }}>
            本次会话还没有隧道
          </p>
        )}
        {visible.map((tunnel) => (
          <div
            key={tunnel.id}
            className="uniterminal-row"
            style={{
              padding: "4px 8px",
              borderBottom: "1px solid rgba(128, 128, 128, 0.16)",
            }}
          >
            <span className="uniterminal-col-mode">{MODE_LABEL[tunnel.mode]}</span>
            <span className="uniterminal-ellipsis uniterminal-col-local">
              {addressOf(tunnel)}
              {tunnel.mode === "remote" && <span className="uniterminal-hint">（服务端监听）</span>}
            </span>
            <span
              className="uniterminal-grow uniterminal-ellipsis"
              title={tunnel.mode === "socks" ? SOCKS_NO_DEST_NOTE : undefined}
            >
              {targetOf(tunnel)}
            </span>
            <span className="uniterminal-col-state">{tunnel.state === "active" ? "运行中" : "已停止"}</span>
            <span className="uniterminal-col-state" style={{ display: "flex", justifyContent: "flex-end" }}>
              <button
                type="button"
                style={{ padding: "1px 6px" }}
                disabled={stoppingId !== undefined || tunnel.state !== "active"}
                onClick={() => void stopTunnel(tunnel.id)}
              >
                停止
              </button>
            </span>
          </div>
        ))}
      </div>

      <div
        className="uniterminal-col-gap"
        style={{
          borderTop: "1px solid rgba(128, 128, 128, 0.16)",
          paddingTop: 8,
        }}
      >
        <span className="uniterminal-body uniterminal-strong">新建隧道</span>
        <label>
          模式
          {/* 自绘下拉（M36）：原生 select 的弹出层由浏览器绘制、不继承主题变量，深色主题下选项看不清 */}
          <div
            style={{
              ...SELECT_STYLE,
              // 自绘下拉自己画边框与底色（.uniterminal-select-button），外壳只留排版
              padding: 0,
              border: "none",
              alignSelf: "flex-start",
              minWidth: 180,
              // SelectField 没有 disabled 属性：建立期间用 pointer-events 关掉鼠标，
              // 再在 onChange 里挡一道，等价于原来的 disabled={busy}
              pointerEvents: busy ? "none" : undefined,
              opacity: busy ? 0.5 : undefined,
            }}
          >
            <SelectField
              label="模式"
              value={mode}
              options={MODE_OPTIONS}
              onChange={(value) => {
                if (busy) return;
                setMode(asMode(value));
                setFormError(undefined);
                setCopyNotice(undefined);
              }}
            />
          </div>
        </label>
        <label>
          监听地址（固定）
          <div className="uniterminal-row uniterminal-wrap">
            <input
              value={BIND_HOST}
              readOnly
              aria-readonly="true"
              // 值恒为回环地址：bindHost 不可改，后端也只接受它（readOnly 下无需 onChange）
              style={{ width: 140, opacity: 0.8 }}
            />
            <span className="uniterminal-hint">{BIND_HOST_NOTE}</span>
          </div>
        </label>
        <label>
          {bindPortLabel}
          <input
            value={bindPortText}
            disabled={busy}
            inputMode="numeric"
            placeholder="例如 8080"
            style={{ width: 140 }}
            onChange={(event) => setBindPortText(event.target.value)}
          />
        </label>
        {mode === "remote" && (
          <p className="uniterminal-hint">{REMOTE_RELEASE_NOTE}（后端限制：会话级的远端监听撤不掉）</p>
        )}
        {mode === "socks" ? (
          <p className="uniterminal-hint">{SOCKS_NO_DEST_NOTE}</p>
        ) : (
          <>
            <label>
              {destHostLabel}
              <input
                value={destHostText}
                disabled={busy}
                placeholder="例如 10.0.0.5 或 db.internal"
                onChange={(event) => setDestHostText(event.target.value)}
              />
            </label>
            <label>
              {destPortLabel}
              <input
                value={destPortText}
                disabled={busy}
                inputMode="numeric"
                placeholder="例如 5432"
                style={{ width: 140 }}
                onChange={(event) => setDestPortText(event.target.value)}
              />
            </label>
          </>
        )}
        <button type="button" disabled={busy} onClick={() => void createTunnel()}>
          {busy ? "建立中…" : "建立隧道"}
        </button>
        {created !== undefined && (
          <div className="uniterminal-row uniterminal-wrap uniterminal-body">
            <span>已建立，可直接复制：</span>
            <code style={{ fontFamily: "monospace", userSelect: "text" }}>{addressOf(created)}</code>
            <button
              type="button"
              style={{ padding: "1px 6px" }}
              onClick={() => void copyAddress(addressOf(created))}
            >
              复制地址
            </button>
            {copyNotice !== undefined && <span className="uniterminal-hint">{copyNotice}</span>}
          </div>
        )}
        {/* B5 无障碍：外层容器常驻，只有失败文字会变，读屏才播报得到 */}
        <div {...noticeLiveProps("error")} className="uniterminal-live">
          {formError !== undefined && <div className="uniterminal-notice">{formError}</div>}
        </div>
      </div>
    </div>
  );
}
