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
  it("extracts only the URL from an interactive mcp-remote entry", () => {
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
  it("extracts only the URL from an interactive ~/.claude.json entry", () => {
    const json = {
      mcpServers: {
        engager: { type: "http", url: URL_, headers: { Authorization: "Bearer eng_ck" } },
      },
    };
    expect(codeConfigEndpoint(json)).toEqual({ url: URL_, source: "claude-code" });
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

  it("orders a saved runner credential before keyless discovered endpoints", () => {
    const found: DetectedEndpoint[] = [
      { url: "http://localhost:8788/mcp", source: "local-dev" },
      { url: DEV, source: "claude-code" }, // same URL, no key
      { url: DEV, apiKey: "k", source: "saved-config" }, // runner credential wins dedupe
      { url: URL_, apiKey: "s", source: "saved-config" },
    ];
    const opts = buildEndpointOptions(found);
    expect(opts.map((o) => o.url)).toEqual([
      DEV,
      URL_,
      "http://localhost:8788/mcp",
      DEFAULT_CLOUD_URL,
    ]);
    expect(opts[0]?.apiKey).toBe("k");
  });

  it("a saved runner credential at the cloud URL replaces the bare default", () => {
    const opts = buildEndpointOptions([
      { url: DEFAULT_CLOUD_URL, apiKey: "k", source: "saved-config" },
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
