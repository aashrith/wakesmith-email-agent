/**
 * Ports: the interfaces the application layer depends on. Adapters
 * (layer 3) implement these; the application never imports a concrete
 * adapter. TypeScript's structural typing means an adapter satisfies a
 * port just by shape — no explicit `implements` required, though we use
 * it anyway at the adapter for clarity and to get compiler checking.
 */

import type { AgentTurnResult, InboundEmail, SentEmail } from "./dto.js";
import type { Gig, Prospect, Thread } from "../domain/models.js";

export interface SendEmailArgs {
  readonly toAddress: string;
  readonly subject: string;
  readonly body: string;
  readonly inReplyTo?: string | null;
}

/** Outbound port: the SMTP/IMAP (GreenMail/smtp4dev-backed) mailbox. */
export interface EmailGateway {
  send(args: SendEmailArgs): Promise<SentEmail>;
  /** Messages received since the last call. Adapter must not return the
   * same message twice (see adapters/outbound/emailSmtpImap.ts). */
  fetchNew(): Promise<InboundEmail[]>;
}

/**
 * Outbound port. The real implementation in this project is a stubbed
 * slot picker (see SYSTEM_DESIGN.md) — swap for a Google Calendar
 * adapter later without touching the application layer.
 */
export interface CalendarGateway {
  listAvailableSlots(n?: number): Promise<Date[]>;
  hold(slotTime: Date, threadId: string): Promise<void>;
  release(threadId: string): Promise<void>;
}

/** Outbound port over the markdown-per-thread memory store. */
export interface MemoryRepository {
  load(threadId: string): Promise<Thread | null>;
  findByProspectEmail(email: string): Promise<Thread | null>;
  save(thread: Thread): Promise<void>;
  allThreadIds(): Promise<string[]>;
}

/**
 * What the LLM adapter is allowed to call mid-reasoning. Concrete
 * implementation lives in application/tools.ts — it's not a swappable
 * adapter, just the boundary the LLM port is allowed to see.
 */
export interface AgentTools {
  getThreadState(): Record<string, unknown>;
  proposeTerms(rate: number): { decision: string; rate: number | null };
  proposeSlots(n?: number): Promise<{ slots: string[] }>;
  bookSlot(slotIso: string): Promise<{ ok: boolean; slot?: string; error?: string }>;
  cancelSlot(): Promise<{ ok: boolean; status?: string; error?: string }>;
  decline(): { ok: boolean; error?: string };
}

/**
 * Outbound port to the reasoning layer. Implemented by the OpenRouter
 * adapter (layer 3), but the application layer only ever sees this
 * interface — swapping models/providers never touches a use case.
 */
export interface LLMAgent {
  /** Cold-open email. No tools needed — nothing to negotiate yet. */
  draftOutreach(gig: Gig, prospect: Prospect): Promise<string>;

  /** Perception step, used for logging only (see dto.AgentIntent). */
  classifyIntent(latestInboundBody: string): Promise<import("./dto.js").AgentIntent>;

  /** Main reasoning loop: model may call tools zero or more times before
   * producing the final reply text. */
  handleTurn(thread: Thread, latestInboundBody: string, tools: AgentTools): Promise<AgentTurnResult>;

  /** A polite check-in when the prospect has gone quiet. No tools —
   * there's nothing new to negotiate, just a nudge referencing the
   * existing thread. See useCases/followUpOnSilence.ts. */
  draftFollowUp(thread: Thread): Promise<string>;
}
