// Image pre-describe pass.
//
// When the routed text model can't see images and the user has a vision
// companion configured, afw calls the companion *itself* before the
// request ever leaves for the routed model, replaces each image with a
// text description of it inline, and forwards a text-only request. The
// routed model never sees binary image data and never has to decide to
// call a view_image tool — which means there's nothing for it to mis-
// emit in XML / Hermes / Anthropic-invoke / JS-call format.
//
// Tradeoff vs. the tool-use loop this replaces:
//   - Pre-describe is robust: no model-specific tool-call format
//     parsing, no failure mode where the model forgets to call the
//     tool or emits the call wrong. One round trip per image.
//   - Pre-describe is less interactive: the routed model can't ask
//     follow-up "look closer at the corner of the image" questions,
//     because it doesn't have the image anymore. For typical
//     describe-this-image asks, this isn't a regression.
//
// The image cache (image-cache.ts) lets a multi-turn conversation
// re-describe an image only on its first appearance — subsequent turns
// reuse the cached description.

import { logger } from '../../core/logger.ts'
import type { ModelApi } from '../../core/model-registry.ts'
import { parseRequestToIR, serializeRequestFromIR } from '../translate/index.ts'
import type { IRBlock, IRImageSource, IRMessage, IRRequest } from '../translate/ir.ts'
import type { RoutedAttempt } from './capture.ts'
import { execAttempt } from './exec.ts'
import { newRequestId, putImage } from './image-cache.ts'
import type { ResolvedMember } from './resolve.ts'

const PREDESCRIBE_SYSTEM = [
  'You are an image-description assistant.',
  'Describe the image accurately, in plain language, covering everything a text-only ' +
    'reader would need to understand it: subjects, actions, text content, layout, ' +
    'colors, charts, diagrams, anything visually meaningful.',
  'Do not editorialize. Do not address the user. Output only the description.',
].join(' ')

const PREDESCRIBE_MAX_TOKENS = 1024

export type PreDescribeResult = {
  /** The clientRequest with every image block replaced by a text block
   *  containing the companion model's description. Same shape as the
   *  input; safe to pass to execAttempt as a normal text-only request. */
  request: Record<string, unknown>
  /** Vision-companion attempts the pass made — captured under the same
   *  parent run so the dashboard shows the full fan-out. */
  attempts: RoutedAttempt[]
  /** True when every image we found was successfully described. False
   *  when at least one companion call failed; the routed model still
   *  runs against whatever descriptions we did manage to fold in, so
   *  the conversation isn't blocked. */
  ok: boolean
}

/** Walk every image block in the request's messages and replace each
 *  with a text block carrying a description produced by the vision
 *  companion. Returns the rewritten request plus the captured attempts.
 *  Caller dispatches the rewritten request to the routed text model as
 *  a normal one-shot execAttempt. */
export async function preDescribeImages(
  clientApi: ModelApi,
  clientRequest: Record<string, unknown>,
  visionMember: ResolvedMember,
  ctx: { agent: string; reqHeaders: Headers },
): Promise<PreDescribeResult> {
  // Parse to IR so we can walk image blocks generically across wire
  // formats; serialize back to clientApi when we're done.
  let ir: IRRequest
  try {
    ir = parseRequestToIR(clientApi, clientRequest)
  } catch (err) {
    logger.warn(`pre-describe: could not parse client request — ${(err as Error).message}`)
    return { request: clientRequest, attempts: [], ok: false }
  }

  const requestId = newRequestId()
  let ordinal = 0
  const attempts: RoutedAttempt[] = []
  let ok = true

  const newMessages: IRMessage[] = []
  for (const msg of ir.messages) {
    const replacedBlocks: IRBlock[] = []
    for (const block of msg.content) {
      if (block.type !== 'image') {
        replacedBlocks.push(block)
        continue
      }
      ordinal += 1
      putImage(requestId, ordinal, block.source)
      const description = await describeOneImage(block.source, ordinal, visionMember, ctx, attempts)
      if (!description.ok) ok = false
      replacedBlocks.push({
        type: 'text',
        text: `[Image #${ordinal}]\n${description.text}`,
      })
    }
    newMessages.push({ ...msg, content: replacedBlocks })
  }

  const rewrittenIR: IRRequest = { ...ir, messages: newMessages }
  const rewrittenBody = serializeRequestFromIR(clientApi, rewrittenIR) as Record<string, unknown>
  return { request: rewrittenBody, attempts, ok }
}

/** Make one upstream call to the vision companion: a single user
 *  message containing the image plus a short instruction. Returns the
 *  companion's text response, or an error placeholder when the call
 *  fails — either way the conversation continues with whatever text
 *  the routed model gets to see. */
async function describeOneImage(
  source: IRImageSource,
  ordinal: number,
  visionMember: ResolvedMember,
  ctx: { agent: string; reqHeaders: Headers },
  attemptsAcc: RoutedAttempt[],
): Promise<{ ok: true; text: string } | { ok: false; text: string }> {
  const visionIR: IRRequest = {
    model: visionMember.model.id,
    system: PREDESCRIBE_SYSTEM,
    messages: [
      {
        role: 'user',
        content: [{ type: 'image', source }],
      },
    ],
    maxTokens: PREDESCRIBE_MAX_TOKENS,
    stream: false,
  }
  const body = serializeRequestFromIR(visionMember.api, visionIR) as Record<string, unknown>
  const result = await execAttempt(visionMember, visionMember.api, body, ctx)
  attemptsAcc.push({
    member: visionMember,
    result,
    role: 'vision',
    step: attemptsAcc.length,
  })
  if (!result.ok) {
    logger.warn(
      `pre-describe: image #${ordinal} failed via ${visionMember.model.id}: ${result.errorText}`,
    )
    return {
      ok: false,
      text: `(image #${ordinal} could not be described: ${result.errorText})`,
    }
  }
  const text = textOfBlocks(result.ir.blocks)
  if (!text) {
    return { ok: false, text: `(image #${ordinal}: companion returned no text)` }
  }
  return { ok: true, text }
}

function textOfBlocks(blocks: readonly { type: string; text?: string }[]): string {
  return blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
    .trim()
}

/** True when this request actually carries an image block worth
 *  pre-describing — cheap probe so the orchestrator skips the parse
 *  cost when there's nothing to do. */
export function requestHasImageBlock(
  clientApi: ModelApi,
  clientRequest: Record<string, unknown>,
): boolean {
  try {
    const ir = parseRequestToIR(clientApi, clientRequest)
    for (const msg of ir.messages) {
      for (const block of msg.content) {
        if (block.type === 'image') return true
        if (block.type === 'tool_result' && Array.isArray(block.content)) {
          for (const sub of block.content) {
            if (sub.type === 'image') return true
          }
        }
      }
    }
  } catch {
    // unparseable — fall through; orchestrator's other paths handle it
  }
  return false
}
