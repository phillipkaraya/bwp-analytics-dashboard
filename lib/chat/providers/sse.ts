/** Bounded SSE decoder for the local connector. No response logging. */
export async function* readSse(response: Response, signal: AbortSignal): AsyncGenerator<{ event: string; data: string }> {
  if (!response.body) throw new Error("The provider returned no stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let bytes = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 4_000_000) throw new Error("The provider stream exceeded the connector limit.");
      pending += decoder.decode(chunk.value, { stream: true }).replace(/\r/g, "");
      let boundary: number;
      while ((boundary = pending.indexOf("\n\n")) >= 0) {
        const frame = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        if (frame.length > 65_536) throw new Error("The provider frame exceeded the connector limit.");
        const lines = frame.split("\n");
        const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (data) yield { event: lines.find((line) => line.startsWith("event:"))?.slice(6).trim() ?? "message", data };
      }
      if (pending.length > 65_536) throw new Error("The provider frame exceeded the connector limit.");
    }
    if (pending.trim()) throw new Error("The provider stream ended inside a frame.");
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(new DOMException("Stopped", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([promise, stopped]); }
  finally { signal.removeEventListener("abort", abort); }
}
