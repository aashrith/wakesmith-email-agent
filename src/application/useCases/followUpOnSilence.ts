/**
 * Use case: the "silent" intent from the brief. Not triggered by an
 * inbound message (there isn't one) — triggered by elapsed time since a
 * thread's last activity. Waiting threads (initiated/negotiating) that
 * have gone quiet past the configured threshold get one nudge; once
 * `maxNudges` nudges have gone unanswered, the thread closes as
 * NO_RESPONSE without sending yet another email into the void.
 *
 * `Thread.updatedAt` is already bumped by every message and status
 * change, so "time since last activity" needs no extra bookkeeping —
 * only nudgeCount is new domain state (see domain/models.ts).
 */

import type { Thread } from "../../domain/models.js";
import { ThreadStatus } from "../../domain/stateMachine.js";
import type { EmailGateway, LLMAgent, MemoryRepository } from "../ports.js";

export interface FollowUpOnSilenceDeps {
  llm: LLMAgent;
  email: EmailGateway;
  memory: MemoryRepository;
  thresholdMs: number;
  maxNudges: number;
  now?: Date;
}

export interface FollowUpResult {
  nudged: string[];
  closed: string[];
}

const WAITING_STATUSES = new Set<ThreadStatus>([ThreadStatus.INITIATED, ThreadStatus.NEGOTIATING]);

export async function followUpOnSilence({
  llm,
  email,
  memory,
  thresholdMs,
  maxNudges,
  now = new Date(),
}: FollowUpOnSilenceDeps): Promise<FollowUpResult> {
  const result: FollowUpResult = { nudged: [], closed: [] };

  for (const threadId of await memory.allThreadIds()) {
    const thread = await memory.load(threadId);
    if (!thread || !WAITING_STATUSES.has(thread.status)) continue;

    const elapsedMs = now.getTime() - thread.updatedAt.getTime();
    if (elapsedMs < thresholdMs) continue;

    if (thread.negotiation.nudgeCount >= maxNudges) {
      thread.closeNoResponse(now);
      await memory.save(thread);
      result.closed.push(threadId);
      continue;
    }

    await sendNudge(thread, llm, email);
    thread.registerNudgeSent(now);
    await memory.save(thread);
    result.nudged.push(threadId);
  }

  return result;
}

async function sendNudge(thread: Thread, llm: LLMAgent, email: EmailGateway): Promise<void> {
  const body = await llm.draftFollowUp(thread);
  const lastOutbound = [...thread.messages].reverse().find((m) => m.direction === "out");
  const sent = await email.send({
    toAddress: thread.prospect.email,
    subject: `Re: ${thread.gig.title}`,
    body,
    inReplyTo: lastOutbound?.messageId ?? null,
  });
  thread.recordMessage({
    direction: "out",
    body,
    timestamp: sent.sentAt,
    messageId: sent.messageId,
    inReplyTo: lastOutbound?.messageId ?? null,
  });
}
