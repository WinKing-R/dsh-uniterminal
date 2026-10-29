import { describe, expect, it } from "vitest";
import { parseSshConfig } from "../../src/store/ssh-config-import.js";

describe("parseSshConfig", () => {
  it("parses a basic Host block with host, user, port, identity, proxy and forwards", () => {
    const text = [
      "# production",
      "Host prod",
      "  HostName 10.0.0.1",
      "  User ops",
      "  Port 2222",
      "  IdentityFile ~/.ssh/id_ed25519",
      "  ProxyJump bastion",
      "  LocalForward 8080 localhost:80",
      "  LocalForward 127.0.0.1:9090 db.internal:5432",
      "",
    ].join("\n");

    const result = parseSshConfig(text);

    expect(result.hosts).toEqual([
      {
        alias: "prod",
        host: "10.0.0.1",
        port: 2222,
        user: "ops",
        identityFile: "~/.ssh/id_ed25519",
        proxyJump: ["bastion"],
        localForwards: [
          { bindPort: 8080, destHost: "localhost", destPort: 80 },
          { bindPort: 9090, destHost: "db.internal", destPort: 5432 },
        ],
      },
    ]);
    expect(result.skipped).toEqual([]);
    expect(result.directives).toEqual([]);
  });

  it("shares one block across the aliases of a single Host line, and accepts key=value with quotes", () => {
    const text = [
      'Host web1 web2',
      '  HostName="web.internal"',
      '  User=deploy',
      "Host other",
      "  User root",
      "",
    ].join("\n");

    const result = parseSshConfig(text);

    expect(result.hosts).toEqual([
      { alias: "web1", host: "web.internal", user: "deploy", localForwards: [] },
      { alias: "web2", host: "web.internal", user: "deploy", localForwards: [] },
      { alias: "other", user: "root", localForwards: [] },
    ]);
  });

  it("skips wildcard aliases with reason wildcard", () => {
    const text = [
      "Host *.example.com",
      "  User root",
      "Host db?",
      "  User root",
      "Host db",
      "  HostName db.local",
      "",
    ].join("\n");

    const result = parseSshConfig(text);

    expect(result.hosts.map((entry) => entry.alias)).toEqual(["db"]);
    expect(result.skipped).toEqual([
      { alias: "*.example.com", reason: "wildcard" },
      { alias: "db?", reason: "wildcard" },
    ]);
  });

  it("collects unknown directives once, in order of first appearance", () => {
    const text = [
      "ServerAliveInterval 30",
      "Host prod",
      "  Compression yes",
      "  hostname 10.0.0.1",
      "  Compression no",
      "",
    ].join("\n");

    const result = parseSshConfig(text);

    expect(result.directives).toEqual(["ServerAliveInterval", "Compression"]);
    expect(result.hosts).toEqual([{ alias: "prod", host: "10.0.0.1", localForwards: [] }]);
  });

  it("ignores everything after a Match directive", () => {
    const text = [
      "Host prod",
      "  HostName 10.0.0.1",
      "Match host *.example.com user root",
      "Host ignored",
      "  HostName nope",
      "",
    ].join("\n");

    const result = parseSshConfig(text);

    expect(result.hosts).toEqual([{ alias: "prod", host: "10.0.0.1", localForwards: [] }]);
    expect(result.skipped).toEqual([
      { alias: "host *.example.com user root", reason: "match-unsupported" },
    ]);
  });

  it("records Include as skipped instead of recursing into it", () => {
    const text = [
      "Include ~/.ssh/config.d/*",
      "Host prod",
      "  HostName 10.0.0.1",
      "",
    ].join("\n");

    const result = parseSshConfig(text);

    expect(result.skipped).toEqual([
      { alias: "~/.ssh/config.d/*", reason: "include-unsupported" },
    ]);
    expect(result.hosts.map((entry) => entry.alias)).toEqual(["prod"]);
  });
});

describe("parseSshConfig ProxyJump", () => {
  // M3-3：解析出的跳板链就是 profile.proxyJump 落库的原值，两种写法都必须留得住
  it("keeps ProxyJump as hop specs, with and without user and port", () => {
    const text = [
      "Host single",
      "  ProxyJump bastion.example.com",
      "Host one-hop",
      "  ProxyJump user@host:2222",
      "",
    ].join("\n");

    const result = parseSshConfig(text);

    expect(result.hosts).toEqual([
      { alias: "single", proxyJump: ["bastion.example.com"], localForwards: [] },
      { alias: "one-hop", proxyJump: ["user@host:2222"], localForwards: [] },
    ]);
  });

  it("splits a comma separated ProxyJump into one hop per item", () => {
    const text = [
      "Host prod",
      "  ProxyJump ops@bastion1:2222, jump2.example.com",
      "",
    ].join("\n");

    const result = parseSshConfig(text);

    expect(result.hosts).toEqual([
      { alias: "prod", proxyJump: ["ops@bastion1:2222", "jump2.example.com"], localForwards: [] },
    ]);
  });

  it("leaves no proxyJump behind when the block has none", () => {
    const text = ["Host plain", "  HostName 10.0.0.9", ""].join("\n");

    const result = parseSshConfig(text);

    expect(result.hosts).toEqual([{ alias: "plain", host: "10.0.0.9", localForwards: [] }]);
  });
});
