/**
 * The agent's toolbelt. Each method is a thin, guarded wrapper: it
 * mutates the in-memory Thread aggregate (reversible, no external IO)
 * via the aggregate's own guarded methods, so an illegal call (e.g.
 * booking a slot from a declined thread) raises IllegalTransitionError
 * instead of silently corrupting state. External side effects (sending
 * the email, persisting to disk) happen after the reasoning loop
 * returns — see useCases/handleInboundMessage.ts. That split is the
 * perception/reasoning vs. action boundary described in
 * SYSTEM_DESIGN.md.
 */

import { IllegalTransitionError } from "../domain/errors.js";
import type { Thread } from "../domain/models.js";
import { evaluateOffer, OfferDecision } from "../domain/policies.js";
import { ThreadStatus } from "../domain/stateMachine.js";
import type { AgentTools as AgentToolsPort, CalendarGateway } from "./ports.js";

export class AgentTools implements AgentToolsPort {
  constructor(
    private readonly thread: Thread,
    private readonly calendar: CalendarGateway,
  ) {}

  getThreadState(): Record<string, unknown> {
    return {
      status: this.thread.status,
      currentRate: this.thread.negotiation.currentRate,
      currentSlot: this.thread.negotiation.currentSlot?.toISOString() ?? null,
      rescheduleCount: this.thread.negotiation.rescheduleCount,
      budgetMin: this.thread.gig.budgetMin,
      budgetMax: this.thread.gig.budgetMax,
      recentMessages: this.thread.messages.slice(-6).map((m) => ({ direction: m.direction, body: m.body })),
    };
  }

  proposeTerms(rate: number): { decision: string; rate: number | null } {
    const outcome = evaluateOffer(this.thread.gig, rate, this.thread.negotiation.counterRounds);
    if (outcome.decision === OfferDecision.ACCEPT) {
      this.thread.agreeRate(outcome.rate!);
    } else if (outcome.decision === OfferDecision.COUNTER) {
      this.thread.negotiation.counterRounds += 1;
    } else {
      this.thread.transitionTo(ThreadStatus.WALKED_AWAY);
    }
    return { decision: outcome.decision, rate: outcome.rate };
  }

  async proposeSlots(n = 3): Promise<{ slots: string[] }> {
    const slots = await this.calendar.listAvailableSlots(n);
    return { slots: slots.map((s) => s.toISOString()) };
  }

  async bookSlot(slotIso: string): Promise<{ ok: boolean; slot?: string; error?: string }> {
    const slotTime = new Date(slotIso);
    try {
      await this.calendar.hold(slotTime, this.thread.id);
      this.thread.lockSlot(slotTime);
    } catch (err) {
      if (err instanceof IllegalTransitionError) return { ok: false, error: err.message };
      throw err;
    }
    return { ok: true, slot: slotIso };
  }

  async cancelSlot(): Promise<{ ok: boolean; status?: string; error?: string }> {
    try {
      await this.calendar.release(this.thread.id);
      this.thread.requestReschedule();
    } catch (err) {
      if (err instanceof IllegalTransitionError) return { ok: false, error: err.message };
      throw err;
    }
    return { ok: true, status: this.thread.status };
  }

  decline(): { ok: boolean; error?: string } {
    try {
      this.thread.transitionTo(ThreadStatus.DECLINED);
    } catch (err) {
      if (err instanceof IllegalTransitionError) return { ok: false, error: err.message };
      throw err;
    }
    return { ok: true };
  }
}
