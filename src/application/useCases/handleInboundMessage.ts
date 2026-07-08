/**
 * Use case: react to one inbound email. This is where every required
 * behaviour meets — negotiation, scheduling, the reschedule loop, and
 * the graceful walk-away — because they're all just different tool
 * calls the LLM makes against the same guarded Thread aggregate.
 *
 * Threads that are already terminal (completed / declined / walked_away)
 * are logged and otherwise ignored: once we've walked away, we don't
 * re-engage.
 */

import type { Thread } from "../../domain/models.js";
import { isTerminal, ThreadStatus } from "../../domain/stateMachine.js";
import type { InboundEmail } from "../dto.js";
import type { CalendarGateway, EmailGateway, LLMAgent, MemoryRepository } from "../ports.js";
import { AgentTools } from "../tools.js";

export class ThreadNotFoundError extends Error {
  constructor(email: string) {
    super(`No thread for ${email}; run initiateOutreach first`);
    this.name = "ThreadNotFoundError";
  }
}

export interface HandleInboundMessageDeps {
  inbound: InboundEmail;
  llm: LLMAgent;
  email: EmailGateway;
  calendar: CalendarGateway;
  memory: MemoryRepository;
}

export async function handleInboundMessage({
  inbound,
  llm,
  email,
  calendar,
  memory,
}: HandleInboundMessageDeps): Promise<Thread> {
  const thread = await memory.findByProspectEmail(inbound.fromAddress);
  if (thread === null) {
    throw new ThreadNotFoundError(inbound.fromAddress);
  }

  thread.recordMessage({
    direction: "in",
    body: inbound.body,
    timestamp: inbound.receivedAt,
    messageId: inbound.messageId,
    inReplyTo: inbound.inReplyTo,
  });

  if (isTerminal(thread.status)) {
    await memory.save(thread);
    return thread;
  }

  if (thread.status === ThreadStatus.INITIATED) {
    thread.transitionTo(ThreadStatus.NEGOTIATING);
  }

  const tools = new AgentTools(thread, calendar);
  const result = await llm.handleTurn(thread, inbound.body, tools);

  const sent = await email.send({
    toAddress: thread.prospect.email,
    subject: `Re: ${thread.gig.title}`,
    body: result.replyBody,
    inReplyTo: inbound.messageId,
  });
  thread.recordMessage({
    direction: "out",
    body: result.replyBody,
    timestamp: sent.sentAt,
    messageId: sent.messageId,
    inReplyTo: inbound.messageId,
  });

  await memory.save(thread);
  return thread;
}
