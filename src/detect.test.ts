import { createServer, type Server } from "node:http";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildEndpointOptions,
  codeConfigEndpoint,
  DEFAULT_CLOUD_URL,
  desktopEndpoint,
  probeLocal,
  type DetectedEndpoint,
} from "./detect.js";

const URL_ = "https://mcp.example.com/mcp";
const DEV = "https://dev.example.com/mcp";

describe("desktopEndpoint", () => {
  it("extracts URL + key from a real mcp-remote bridge entry", () => {
    const config = {
      mcpServers: {
        engager: {
          command: "npx",
          args: ["-y", "mcp-remote", DEV, "--header", "Authorization: Bearer eng_devkey"],
        },
      },
    };
    expect(desktopEndpoint(config)).toEqual({
      url: DEV,
      apiKey: "eng_devkey",
      source: "claude-desktop",
    });
  });

  it("null when absent or URL-less", () => {
    expect(desktopEndpoint(null)).toBeNull();
    expect(desktopEndpoint({ mcpServers: {} })).toBeNull();
    expect(
      desktopEndpoint({ mcpServers: { engager: { command: "npx", args: ["-y", "mcp-remote"] } } }),
    ).toBeNull();
  });
});

describe("codeConfigEndpoint", () => {
  it("extracts an http entry with a bearer header from ~/.claude.json", () => {
    const json = {
      mcpServers: {
        engager: { type: "http", url: URL_, headers: { Authorization: "Bearer eng_ck" } },
      },
    };
    expect(codeConfigEndpoint(json)).toEqual({ url: URL_, apiKey: "eng_ck", source: "claude-code" });
  });

  it("survives arbitrary shapes without throwing", () => {
    expect(codeConfigEndpoint(null)).toBeNull();
    expect(codeConfigEndpoint("junk")).toBeNull();
    expect(codeConfigEndpoint({ mcpServers: { engager: { url: "not-a-url" } } })).toBeNull();
    expect(codeConfigEndpoint({ mcpServers: { engager: { url: URL_ } } })).toEqual({
      url: URL_,
      source: "claude-code",
    });
  });
});

describe("buildEndpointOptions", () => {
  it("always includes the cloud default, last", () => {
    const opts = buildEndpointOptions([]);
    expect(opts).toHaveLength(1);
    expect(opts[0]).toEqual({ url: DEFAULT_CLOUD_URL, source: "cloud" });
  });

  it("orders: saved config → keyed finds → keyless finds → cloud; dedupes by URL keeping the keyed entry", () => {
    const found: DetectedEndpoint[] = [
      { url: "http://localhost:8788/mcp", source: "local-dev" },
      { url: DEV, source: "claude-code" }, // same URL, no key
      { url: DEV, apiKey: "k", source: "claude-desktop" }, // keyed wins the dedupe
      { url: URL_, apiKey: "s", source: "saved-config" },
    ];
    const opts = buildEndpointOptions(found);
    expect(opts.map((o) => o.url)).toEqual([
      URL_,
      DEV,
      "http://localhost:8788/mcp",
      DEFAULT_CLOUD_URL,
    ]);
    expect(opts[1]?.apiKey).toBe("k");
  });

  it("a keyed find at the cloud URL replaces the bare default", () => {
    const opts = buildEndpointOptions([
      { url: DEFAULT_CLOUD_URL, apiKey: "k", source: "claude-desktop" },
    ]);
    expect(opts).toHaveLength(1);
    expect(opts[0]?.apiKey).toBe("k");
  });
});

describe("probeLocal", () => {
  let server: Server | null = null;
  afterAll(() => server?.close());

  it("a fail-closed 401 responder counts as alive; a closed port does not", async () => {
    server = createServer((_req, res) => {
      res.statusCode = 401;
      res.end();
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const alive = await probeLocal([`http://127.0.0.1:${port}/mcp`]);
    expect(alive).toEqual({ url: `http://127.0.0.1:${port}/mcp`, source: "local-dev" });

    const dead = await probeLocal(["http://127.0.0.1:1/mcp"]);
    expect(dead).toBeNull();
  });
});

describe("unwrapSkillFile", () => {
  it("unwraps the server's {name, path, content} envelope", async () => {
    const { unwrapSkillFile } = await import("./mcp.js");
    const envelope = JSON.stringify({ name: "engager-batch", path: "README.md", content: "# hi\n" });
    expect(unwrapSkillFile(envelope, "engager-batch", "README.md")).toBe("# hi\n");
  });

  it("passes bare text through, and refuses to unwrap mismatched or lookalike JSON", async () => {
    const { unwrapSkillFile } = await import("./mcp.js");
    expect(unwrapSkillFile("# plain markdown", "s", "f.md")).toBe("# plain markdown");
    // a skill file whose CONTENT is JSON with a content field must survive verbatim
    const lookalike = JSON.stringify({ name: "other", path: "x", content: "nope" });
    expect(unwrapSkillFile(lookalike, "engager-batch", "README.md")).toBe(lookalike);
  });
});
