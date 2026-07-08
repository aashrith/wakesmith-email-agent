/**
 * The inbound "trigger" logic: fetch whatever new mail has arrived and
 * run it through handleInboundMessage. Shared by the background poller
 * (layer 6) and the API's manual POST /poll route (layer 5) so there's
 * exactly one code path for "react to new mail" regardless of what
 * kicked it off.
 */

import { handleInboundMessage, ThreadNotFoundError } from "../../application/useCases/handleInboundMessage.js";
import { logger } from "../../lib/logger.js";
import type { Container } from "../../bootstrap.js";

export interface PollResult {
  processed: number;
  skipped: Array<{ from: string; reason: string }>;
}

export async function runPollCycle(container: Container): Promise<PollResult> {
  const inboundMessages = await container.email.fetchNew();
  const result: PollResult = { processed: 0, skipped: [] };

  for (const inbound of inboundMessages) {
    try {
      const thread = await handleInboundMessage({
        inbound,
        llm: container.llm,
        email: container.email,
        calendar: container.calendar,
        memory: container.memory,
      });
      result.processed += 1;
      logger.info("inbound message handled", { threadId: thread.id, from: inbound.fromAddress, status: thread.status });
    } catch (err) {
      // A stray reply from someone we never pitched is a normal, expected
      // case (wrong address, spam, etc.) — log and move on rather than
      // taking down the whole poll cycle over one bad message.
      const reason = err instanceof ThreadNotFoundError ? err.message : String(err);
      logger.warn("skipped inbound message", { from: inbound.fromAddress, reason });
      result.skipped.push({ from: inbound.fromAddress, reason });
    }
  }
  return result;
}
