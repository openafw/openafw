import { newActionId, newRunId } from '../../core/ids.ts'
import type { AgentPacket, NetworkPayload } from '../../core/packet.ts'
import { appendPacket } from '../store/writer.ts'
import { dayBucketThreadId } from './correlate.ts'
import type { DecodeInput, Decoder } from './types.ts'

export const passthroughDecoder: Decoder = {
  async decode(input: DecodeInput): Promise<void> {
    // Drain the stream so the tee doesn't apply backpressure to the client branch.
    const reader = input.resBody.getReader()
    while (true) {
      const { done } = await reader.read()
      if (done) break
    }

    const payload: NetworkPayload = {
      kind: 'network',
      protocol: 'passthrough',
      endpoint: input.upstreamUrl,
      method: input.reqMethod,
      status: input.resStatus,
    }

    // No request body to fingerprint — keep the per-day bucket fallback.
    const packet: AgentPacket = {
      id: newActionId(),
      runId: newRunId(),
      threadId: dayBucketThreadId(input.agent),
      ts: Date.now(),
      durMs: performance.now() - input.startedAt,
      sourceAgent: input.agent,
      payload,
    }

    await appendPacket(packet)
  },
}
