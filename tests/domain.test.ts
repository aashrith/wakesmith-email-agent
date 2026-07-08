import { describe, expect, it } from "vitest";
import { BudgetViolationError, IllegalTransitionError } from "../src/domain/errors.js";
import type { Gig } from "../src/domain/models.js";
import { Thread } from "../src/domain/models.js";
import { evaluateOffer, OfferDecision } from "../src/domain/policies.js";
import { ThreadStatus } from "../src/domain/stateMachine.js";

function makeGig(overrides: Partial<Gig> = {}): Gig {
  return {
    id: "gig-1",
    title: "Backend contract",
    description: "...",
    budgetMin: 60,
    budgetMax: 100,
    tone: "warm",
    ...overrides,
  };
}

function makeThread(gig: Gig = makeGig()): Thread {
  return new Thread({ id: "t-1", prospect: { id: "p-1", name: "Sam", email: "sam@example.com" }, gig });
}

describe("Thread state machine", () => {
  it("allows the legal transition sequence", () => {
    const t = makeThread();
    t.transitionTo(ThreadStatus.NEGOTIATING);
    t.lockSlot(new Date(Date.now() + 86400_000));
    expect(t.status).toBe(ThreadStatus.SCHEDULED);
  });

  it("rejects an illegal transition", () => {
    const t = makeThread();
    expect(() => t.transitionTo(ThreadStatus.SCHEDULED)).toThrow(IllegalTransitionError);
  });

  it("rejects a same-status no-op transition", () => {
    const t = makeThread();
    expect(() => t.transitionTo(ThreadStatus.INITIATED)).toThrow(IllegalTransitionError);
  });

  it("refuses to agree a rate above the gig's budget ceiling (hard backstop)", () => {
    const t = makeThread(makeGig({ budgetMax: 100 }));
    t.transitionTo(ThreadStatus.NEGOTIATING);
    expect(() => t.agreeRate(150)).toThrow(BudgetViolationError);
  });

  it("cannot book a call from a declined thread", () => {
    const t = makeThread();
    t.transitionTo(ThreadStatus.NEGOTIATING);
    t.transitionTo(ThreadStatus.DECLINED);
    expect(() => t.lockSlot(new Date())).toThrow(IllegalTransitionError);
  });

  it("the reschedule loop preserves history and can repeat N times", () => {
    const t = makeThread();
    t.transitionTo(ThreadStatus.NEGOTIATING);
    t.agreeRate(90);
    t.recordMessage({ direction: "out", body: "how about $90/hr?", timestamp: new Date(), messageId: "m1", inReplyTo: null });
    t.lockSlot(new Date(Date.now() + 86400_000));

    t.requestReschedule();
    expect(t.status).toBe(ThreadStatus.NEGOTIATING);
    expect(t.negotiation.currentRate).toBe(90); // rate survives the loop
    expect(t.messages).toHaveLength(1); // history survives the loop
    t.lockSlot(new Date(Date.now() + 2 * 86400_000));

    t.requestReschedule(); // loop runs more than once
    expect(t.negotiation.rescheduleCount).toBe(2);
    t.lockSlot(new Date(Date.now() + 3 * 86400_000));
    expect(t.status).toBe(ThreadStatus.SCHEDULED);
  });
});

describe("evaluateOffer", () => {
  it("accepts an offer within budget", () => {
    const outcome = evaluateOffer(makeGig({ budgetMax: 100 }), 90, 0);
    expect(outcome).toEqual({ decision: OfferDecision.ACCEPT, rate: 90 });
  });

  it("counters at the ceiling when over budget", () => {
    const outcome = evaluateOffer(makeGig({ budgetMax: 100 }), 140, 0);
    expect(outcome).toEqual({ decision: OfferDecision.COUNTER, rate: 100 });
  });

  it("never counters above the ceiling even on later rounds", () => {
    const outcome = evaluateOffer(makeGig({ budgetMax: 100 }), 140, 1);
    expect(outcome.rate).toBeLessThanOrEqual(100);
  });

  it("walks away after the max counter rounds", () => {
    const outcome = evaluateOffer(makeGig({ budgetMax: 100 }), 140, 2);
    expect(outcome).toEqual({ decision: OfferDecision.WALK_AWAY, rate: null });
  });
});
