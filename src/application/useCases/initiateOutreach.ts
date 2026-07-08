/**
 * Use case: start a new thread with a prospect. The only use case that
 * doesn't need the tool-calling loop — there's nothing to negotiate yet.
 */

import { v4 as uuidv4 } from "uuid";
import type { Gig, Prospect } from "../../domain/models.js";
import { Thread } from "../../domain/models.js";
import type { EmailGateway, LLMAgent, MemoryRepository } from "../ports.js";

export interface InitiateOutreachDeps {
  gig: Gig;
  prospect: Prospect;
  llm: LLMAgent;
  email: EmailGateway;
  memory: MemoryRepository;
}

export async function initiateOutreach({ gig, prospect, llm, email, memory }: InitiateOutreachDeps): Promise<Thread> {
  const existing = await memory.findByProspectEmail(prospect.email);
  if (existing !== null) {
    return existing; // idempotent: don't re-pitch someone we already have a thread with
  }

  const thread = new Thread({ id: uuidv4(), prospect, gig });
  const body = await llm.draftOutreach(gig, prospect);
  const sent = await email.send({ toAddress: prospect.email, subject: `Quick opportunity: ${gig.title}`, body });
  thread.recordMessage({ direction: "out", body, timestamp: sent.sentAt, messageId: sent.messageId, inReplyTo: null });
  await memory.save(thread);
  return thread;
}
