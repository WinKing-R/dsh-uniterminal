export interface ImportedForward {
  bindPort: number;
  destHost: string;
  destPort: number;
}

export interface ImportedHost {
  alias: string;
  host?: string;
  port?: number;
  user?: string;
  identityFile?: string;
  /** M3-3：按顺序的跳板链，每项形如 user@host:port（user 与 port 可省略）。 */
  proxyJump?: string[];
  localForwards: ImportedForward[];
}

export interface SkippedHost {
  alias: string;
  reason: string;
}

export interface ImportResult {
  hosts: ImportedHost[];
  skipped: SkippedHost[];
  directives: string[];
}

const KNOWN_DIRECTIVES: readonly string[] = [
  "hostname",
  "user",
  "port",
  "identityfile",
  "proxyjump",
  "localforward",
];

const unquote = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const head = trimmed[0];
  if ((head === '"' || head === "'") && trimmed.endsWith(head)) return trimmed.slice(1, -1);
  return trimmed;
};

const splitWords = (value: string): string[] =>
  value
    .split(/\s+/)
    .map(unquote)
    .filter((word) => word !== "");

const splitDirective = (line: string): { key: string; value: string } => {
  const matched = /^([^=\s]+)(?:\s*=\s*|\s+)(.*)$/.exec(line);
  if (matched === null) return { key: line, value: "" };
  return { key: matched[1] ?? "", value: (matched[2] ?? "").trim() };
};

const parsePort = (value: string): number | undefined => {
  if (!/^\d+$/.test(value)) return undefined;
  const port = Number.parseInt(value, 10);
  return port > 0 && port <= 65535 ? port : undefined;
};

const stripBrackets = (value: string): string =>
  value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;

const parseForward = (value: string): ImportedForward | undefined => {
  const words = splitWords(value);
  if (words.length !== 2) return undefined;
  const bindSpec = words[0] ?? "";
  const destSpec = words[1] ?? "";
  const bindPort = parsePort(bindSpec.slice(bindSpec.lastIndexOf(":") + 1));
  const splitAt = destSpec.lastIndexOf(":");
  if (bindPort === undefined || splitAt <= 0) return undefined;
  const destHost = stripBrackets(destSpec.slice(0, splitAt));
  const destPort = parsePort(destSpec.slice(splitAt + 1));
  if (destHost === "" || destPort === undefined) return undefined;
  return { bindPort, destHost, destPort };
};

const isWildcardAlias = (alias: string): boolean => alias.includes("*") || alias.includes("?");

/**
 * Parses the subset of ~/.ssh/config that a host list can represent.
 * Include is never followed and Match switches the remainder of the file off.
 */
export function parseSshConfig(text: string): ImportResult {
  const hosts: ImportedHost[] = [];
  const skipped: SkippedHost[] = [];
  const directives: string[] = [];
  const seenDirectives = new Set<string>();
  let block: ImportedHost[] = [];
  let matching = false;

  const apply = (entry: ImportedHost, name: string, value: string): void => {
    if (name === "hostname") {
      const host = unquote(value);
      if (host !== "") entry.host = host;
      return;
    }
    if (name === "user") {
      const user = unquote(value);
      if (user !== "") entry.user = user;
      return;
    }
    if (name === "port") {
      const port = parsePort(unquote(value));
      if (port !== undefined) entry.port = port;
      return;
    }
    if (name === "identityfile") {
      const identityFile = unquote(value);
      if (identityFile !== "") entry.identityFile = identityFile;
      return;
    }
    if (name === "proxyjump") {
      // ssh_config 的 ProxyJump 是**逗号分隔的链**：一项一跳，绝不当成一个主机名存下去
      const hops = splitWords(unquote(value).split(",").join(" ")).filter((hop) => hop !== "");
      if (hops.length > 0) entry.proxyJump = hops;
      return;
    }
    const forward = parseForward(value);
    if (forward !== undefined) entry.localForwards.push(forward);
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const { key, value } = splitDirective(line);
    const name = key.toLowerCase();
    if (name === "match") {
      if (!matching) skipped.push({ alias: value, reason: "match-unsupported" });
      matching = true;
      block = [];
      continue;
    }
    if (matching) continue;
    if (name === "include") {
      skipped.push({ alias: value, reason: "include-unsupported" });
      continue;
    }
    if (name === "host") {
      block = [];
      for (const alias of splitWords(value)) {
        if (isWildcardAlias(alias)) {
          skipped.push({ alias, reason: "wildcard" });
          continue;
        }
        const entry: ImportedHost = { alias, localForwards: [] };
        block.push(entry);
        hosts.push(entry);
      }
      continue;
    }
    if (!KNOWN_DIRECTIVES.includes(name)) {
      if (!seenDirectives.has(name)) {
        seenDirectives.add(name);
        directives.push(key);
      }
      continue;
    }
    for (const entry of block) apply(entry, name, value);
  }

  return { hosts, skipped, directives };
}
