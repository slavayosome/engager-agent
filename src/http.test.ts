import { describe, expect, it } from "vitest";
import { boundedFetch, readBoundedJson } from "./http.js";

describe("bounded HTTP responses", () => {
  it("rejects an oversized declared content length before reading", async () => {
    const response = new Response("{}", { headers: { "content-length": "1000" } });
    await expect(readBoundedJson(response, 32)).rejects.toThrow(/content-length exceeds 32/);
  });

  it("rejects chunked JSON that crosses the byte ceiling", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"value":"'));
          controller.enqueue(new TextEncoder().encode("x".repeat(100)));
          controller.enqueue(new TextEncoder().encode('"}'));
          controller.close();
        },
      }),
    );
    await expect(readBoundedJson(response, 32)).rejects.toThrow(/exceeded 32 bytes/);
  });

  it("bounds the stream returned to the MCP transport", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(20));
            controller.enqueue(new Uint8Array(20));
            controller.close();
          },
        }),
      );
    try {
      const response = await boundedFetch("https://engager.test/mcp", undefined, 32);
      await expect(response.arrayBuffer()).rejects.toThrow(/exceeded 32 bytes/);
    } finally {
      globalThis.fetch = original;
    }
  });
});
