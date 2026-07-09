/**
 * Core domain concepts. No IO, no framework imports — this module is
 * unit-testable with nothing but the language itself, and that's the
 * point: business rules should never require a mail server or an LLM to
 * verify.
 */

import { BudgetViolationError, IllegalTransitionError } from "./errors.js";
import { ThreadStatus, canTransition } from "./stateMachine.js";

export type MessageDirection = "in" | "out";

/** The work being offered. Config-driven — see config/config.yaml. */
export interface Gig {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly budgetMin: number;
  readonly budgetMax: number;
  readonly tone: string;
}

export interface Prospect {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

export interface CalendarSlot {
  readonly slotTime: Date;
  readonly heldByThreadId: string | null;
}

/**
 * One email, verbatim. Immutable — the episodic log is append-only,
 * never edited (see SYSTEM_DESIGN.md §4).
 */
export interface Message {
  readonly direction: MessageDirection;
  readonly body: string;
  readonly timestamp: Date;
  readonly messageId: string;
  readonly inReplyTo: string | null;
}

/**
 * The mutable, authoritative "what's true right now" for a thread.
 * Maps 1:1 to the YAML state header in the markdown memory file.
 */
export interface NegotiationState {
  currentRate: number | null;
  currentSlot: Date | null;
  rescheduleCount: number;
  counterRounds: number;
  nudgeCount: number;
}

export function initialNegotiationState(): NegotiationState {
  return { currentRate: null, currentSlot: null, rescheduleCount: 0, counterRounds: 0, nudgeCount: 0 };
}

export interface ThreadProps {
  id: string;
  prospect: Prospect;
  gig: Gig;
  status?: ThreadStatus;
  negotiation?: NegotiationState;
  messages?: Message[];
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * Aggregate root. Owns the invariant that status transitions must be
 * legal. Everything that mutates a thread goes through a method here —
 * nothing reaches into `.status` or `.messages` directly from outside.
 */
export class Thread {
  readonly id: string;
  readonly prospect: Prospect;
  readonly gig: Gig;
  status: ThreadStatus;
  negotiation: NegotiationState;
  messages: Message[];
  readonly createdAt: Date;
  updatedAt: Date;

  constructor(props: ThreadProps) {
    this.id = props.id;
    this.prospect = props.prospect;
    this.gig = props.gig;
    this.status = props.status ?? ThreadStatus.INITIATED;
    this.negotiation = props.negotiation ?? initialNegotiationState();
    this.messages = props.messages ?? [];
    this.createdAt = props.createdAt ?? new Date();
    this.updatedAt = props.updatedAt ?? new Date();
  }

  transitionTo(newStatus: ThreadStatus, now: Date = new Date()): void {
    if (!canTransition(this.status, newStatus)) {
      throw new IllegalTransitionError(this.status, newStatus);
    }
    this.status = newStatus;
    this.updatedAt = now;
  }

  recordMessage(message: Message, now: Date = new Date()): void {
    this.messages.push(message);
    this.updatedAt = now;
  }

  agreeRate(rate: number, now: Date = new Date()): void {
    // Callers (application/tools.ts) are responsible for deciding the
    // rate via domain/policies.evaluateOffer, which never returns a
    // value above the ceiling — this check is a hard backstop against
    // that invariant being violated by a future caller, not the primary
    // control.
    if (rate > this.gig.budgetMax) {
      throw new BudgetViolationError(rate, this.gig.budgetMax);
    }
    this.negotiation.currentRate = rate;
    this.updatedAt = now;
  }

  lockSlot(slotTime: Date, now: Date = new Date()): void {
    this.negotiation.currentSlot = slotTime;
    this.transitionTo(ThreadStatus.SCHEDULED, now);
  }

  /** The critical use case: hold everything (rate, history, prior
   * commitments) and re-open negotiation rather than starting over. */
  requestReschedule(now: Date = new Date()): void {
    this.negotiation.rescheduleCount += 1;
    this.negotiation.currentSlot = null;
    this.transitionTo(ThreadStatus.RESCHEDULE_REQUESTED, now);
    this.transitionTo(ThreadStatus.NEGOTIATING, now);
  }

  /** A follow-up nudge was sent because the prospect went quiet. Doesn't
   * change status — silence isn't a reply we can classify, just an
   * elapsed-time signal (see followUpOnSilence.ts). */
  registerNudgeSent(now: Date = new Date()): void {
    this.negotiation.nudgeCount += 1;
    this.updatedAt = now;
  }

  /** Nudges exhausted with no reply. Distinct from declining (an
   * explicit rejection) or walking away (a budget decision) — this is
   * the "silent" intent the brief names, closed gracefully and without
   * sending yet another email into the void. */
  closeNoResponse(now: Date = new Date()): void {
    this.transitionTo(ThreadStatus.NO_RESPONSE, now);
  }
}
