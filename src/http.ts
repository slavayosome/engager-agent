export const MAX_MCP_RESPONSE_BYTES = 1024 * 1024;
export const MAX_DEVICE_AUTH_RESPONSE_BYTES = 64 * 1024;

/** Wrap fetch responses in a byte-counting stream. This protects both ordinary
 * JSON-RPC responses and long/chunked SSE bodies without buffering successful
 * MCP traffic or changing the SDK's transport behavior. */
export async function boundedFetch(
  input: string | URL | Request,
  init?: RequestInit,
  maxBytes: number = MAX_MCP_RESPONSE_BYTES,
): Promise<Response> {
  const response = await fetch(input, init);
  assertContentLength(response, maxBytes);
  if (!response.body) return response;

  let total = 0;
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > maxBytes) {
          throw new Error(`HTTP response exceeded ${maxBytes} bytes`);
        }
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export async function readBoundedJson(
  response: Response,
  maxBytes: number = MAX_DEVICE_AUTH_RESPONSE_BYTES,
): Promise<unknown> {
  assertContentLength(response, maxBytes);
  if (!response.body) throw new Error("HTTP response body was empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("response byte ceiling exceeded").catch(() => undefined);
        throw new Error(`HTTP response exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function assertContentLength(response: Response, maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError("HTTP response byte ceiling must be a positive safe integer");
  }
  const raw = response.headers.get("content-length");
  if (raw == null) return;
  const length = Number(raw);
  if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes) {
    throw new Error(`HTTP response content-length exceeds ${maxBytes} bytes`);
  }
}
