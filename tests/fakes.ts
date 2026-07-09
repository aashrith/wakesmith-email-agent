/**
 * In-memory fakes for the application ports. TypeScript's structural
 * typing means these satisfy the port interfaces just by shape — no
 * test-only base classes or mocking library needed.
 */

import { AgentIntent } from "../src/application/dto.js";
import type { AgentTurnResult, InboundEmail, SentEmail } from "../src/application/dto.js";
import type { AgentTools, CalendarGateway, EmailGateway, LLMAgent, MemoryRepository, SendEmailArgs } from "../src/application/ports.js";
import type { Gig, Prospect, Thread } from "../src/domain/models.js";

export class FakeEmailGateway implements EmailGateway {
  sent: Array<{ to: string; subject: string; body: string; inReplyTo: string | null | undefined; messageId: string }> = [];
  private counter = 0;

  async send(args: SendEmailArgs): Promise<SentEmail> {
    const messageId = `msg-${++this.counter}`;
    this.sent.push({ to: args.toAddress, subject: args.subject, body: args.body, inReplyTo: args.inReplyTo, messageId });
    return { messageId, sentAt: new Date() };
  }

  async fetchNew(): Promise<InboundEmail[]> {
    return [];
  }
}

export class FakeCalendarGateway implements CalendarGateway {
  held = new Map<string, Date>();
  private base: Date;

  constructor(baseDay?: Date) {
    this.base = baseDay ?? new Date(Date.now() + 86400_000);
  }

  async listAvailableSlots(n = 3): Promise<Date[]> {
    return Array.from({ length: n }, (_, i) => new Date(this.base.getTime() + i * 86400_000));
  }

  async hold(slotTime: Date, threadId: string): Promise<void> {
    this.held.set(threadId, slotTime);
  }

  async release(threadId: string): Promise<void> {
    this.held.delete(threadId);
  }
}

export class FakeMemoryRepository implements MemoryRepository {
  private byId = new Map<string, Thread>();

  async load(threadId: string): Promise<Thread | null> {
    return this.byId.get(threadId) ?? null;
  }

  async findByProspectEmail(email: string): Promise<Thread | null> {
    for (const t of this.byId.values()) {
      if (t.prospect.email === email) return t;
    }
    return null;
  }

  async save(thread: Thread): Promise<void> {
    this.byId.set(thread.id, thread);
  }

  async allThreadIds(): Promise<string[]> {
    return [...this.byId.keys()];
  }
}

export type HandleTurnFn = (thread: Thread, latestBody: string, tools: AgentTools) => Promise<AgentTurnResult> | AgentTurnResult;

/**
 * Test double for LLMAgent: `handleTurn` delegates to a caller-supplied
 * function so each test can script exactly which tools the "model" calls,
 * without needing a real OpenRouter round-trip.
 */
export class ScriptedLLMAgent implements LLMAgent {
  handleTurnCalls = 0;

  constructor(
    private handleTurnFn?: HandleTurnFn,
    private outreachBody = "Hi, quick opportunity...",
  ) {}

  setHandleTurnFn(fn: HandleTurnFn) {
    this.handleTurnFn = fn;
  }

  async draftOutreach(_gig: Gig, _prospect: Prospect): Promise<string> {
    return this.outreachBody;
  }

  async classifyIntent(_latestInboundBody: string): Promise<AgentIntent> {
    return AgentIntent.OTHER;
  }

  async handleTurn(thread: Thread, latestInboundBody: string, tools: AgentTools): Promise<AgentTurnResult> {
    this.handleTurnCalls += 1;
    if (!this.handleTurnFn) {
      return { intent: AgentIntent.OTHER, replyBody: "ok", toolCallsMade: [] };
    }
    return this.handleTurnFn(thread, latestInboundBody, tools);
  }

  async draftFollowUp(_thread: Thread): Promise<string> {
    return "Just checking in — still interested?";
  }
}
