// Tracks in-flight proxied requests — the model calls passing through the
// wire. The update machinery waits for this to reach zero before restarting
// the daemon: a restart mid-request would drop the agent's call. A request
// counts from just before the upstream fetch until its response body has
// been fully delivered to the client.

let inFlight = 0

export function beginRequest(): void {
  inFlight++
}

export function endRequest(): void {
  if (inFlight > 0) inFlight--
}

export function inFlightCount(): number {
  return inFlight
}

/**
 * Wrap a response stream so `onDone` fires exactly once when the body has
 * been fully delivered — closed, cancelled, or errored. This keeps a request
 * counted for its whole streaming lifetime, not just until the proxy handler
 * returns (the handler returns while the body is still streaming).
 */
export function trackStream(
  stream: ReadableStream<Uint8Array>,
  onDone: () => void,
): ReadableStream<Uint8Array> {
  let settled = false
  const finish = (): void => {
    if (settled) return
    settled = true
    onDone()
  }
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = stream.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          controller.enqueue(value)
        }
        controller.close()
      } catch (err) {
        controller.error(err)
      } finally {
        reader.releaseLock()
        finish()
      }
    },
    cancel() {
      finish()
    },
  })
}
