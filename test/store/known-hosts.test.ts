import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KnownHosts, decideHostKey } from "../../src/store/known-hosts.js";

const renameSpy = vi.hoisted(() => vi.fn());

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  renameSpy.mockImplementation((from: string, to: string) => actual.rename(from, to));
  return { ...actual, rename: renameSpy };
});

const FINGERPRINT = "SHA256:aaabbbcccdddeee";
const OTHER_FINGERPRINT = "SHA256:zzzyyyxxxwwwvvv";

type PersistedFile = {
  version: number;
  hosts: { host: string; port: number; fingerprint: string; addedAt: number }[];
};

let dir = "";
let file = "";
let store: KnownHosts;

const readPersisted = async (): Promise<PersistedFile> =>
  JSON.parse(await readFile(file, "utf8")) as PersistedFile;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "uniterminal-known-hosts-"));
  file = join(dir, "known_hosts.json");
  store = new KnownHosts(file);
  renameSpy.mockClear();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("KnownHosts", () => {
  it("reports an unknown key and rejects it under the default policy", async () => {
    await store.load();

    expect(store.check("10.0.0.1", 22, FINGERPRINT)).toBe("unknown");

    const verifier = decideHostKey({ knownHosts: store }, "10.0.0.1", 22);
    expect(() => verifier(FINGERPRINT)).toThrow(/uniterminal: unknown host key/);
    expect(renameSpy).not.toHaveBeenCalled();
  });

  it("reports a match once the key is trusted, and persists it atomically", async () => {
    await store.load();
    await store.trust("10.0.0.1", 2222, FINGERPRINT);

    expect(store.check("10.0.0.1", 2222, FINGERPRINT)).toBe("match");
    expect(store.check("10.0.0.1", 22, FINGERPRINT)).toBe("unknown");
    expect(decideHostKey({ knownHosts: store }, "10.0.0.1", 2222)(FINGERPRINT)).toBe(true);

    expect(renameSpy).toHaveBeenCalledTimes(1);
    const call = renameSpy.mock.calls[0] as unknown[];
    expect(String(call[1])).toBe(file);
    expect(String(call[0])).not.toBe(file);

    const persisted = await readPersisted();
    expect(persisted.version).toBe(1);
    expect(persisted.hosts).toEqual([
      { host: "10.0.0.1", port: 2222, fingerprint: FINGERPRINT, addedAt: expect.any(Number) },
    ]);

    const reloaded = new KnownHosts(file);
    await reloaded.load();
    expect(reloaded.check("10.0.0.1", 2222, FINGERPRINT)).toBe("match");
    expect(reloaded.check("10.0.0.1", 2222, FINGERPRINT.replace("SHA256:", ""))).toBe("match");
  });

  it("reports a mismatch when the presented fingerprint changed, and names it in the error", async () => {
    await store.load();
    await store.trust("10.0.0.1", 22, FINGERPRINT);

    expect(store.check("10.0.0.1", 22, OTHER_FINGERPRINT)).toBe("mismatch");

    const verifier = decideHostKey({ knownHosts: store }, "10.0.0.1", 22);
    expect(() => verifier(OTHER_FINGERPRINT)).toThrow(/uniterminal: host key changed/);
    expect(store.check("10.0.0.1", 22, FINGERPRINT)).toBe("match");
  });

  it("trusts and persists an unknown key when the policy allows it", async () => {
    await store.load();

    const verifier = decideHostKey({ knownHosts: store, onUnknownHostKey: "trust" }, "10.0.0.1", 2222);
    expect(verifier(FINGERPRINT)).toBe(true);
    expect(store.check("10.0.0.1", 2222, FINGERPRINT)).toBe("match");

    await vi.waitFor(async () => {
      const persisted = await readPersisted();
      expect(persisted.hosts.map((entry) => entry.fingerprint)).toEqual([FINGERPRINT]);
    });
  });

  it("throws on a malformed known_hosts file instead of clearing it", async () => {
    const badVersion = JSON.stringify({ version: 2, hosts: [] });
    await writeFile(file, badVersion, "utf8");
    await expect(store.load()).rejects.toThrow(/known_hosts\.json/);
    expect(await readFile(file, "utf8")).toBe(badVersion);

    const badHosts = JSON.stringify({ version: 1, hosts: "nope" });
    await writeFile(file, badHosts, "utf8");
    await expect(store.load()).rejects.toThrow(/known_hosts\.json/);
    expect(await readFile(file, "utf8")).toBe(badHosts);

    expect(store.check("10.0.0.1", 22, FINGERPRINT)).toBe("unknown");
  });
});
