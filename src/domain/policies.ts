/**
 * Pure negotiation policy. Deliberately kept out of the LLM's hands: the
 * agent loop calls `evaluateOffer` as a tool and phrases the *email*
 * around its answer, but the *decision* (accept / counter / walk away)
 * is a deterministic function of the gig's budget ceiling. This is what
 * "negotiate within budget... never exceed it" means in code, not in a
 * prompt.
 */

import type { Gig } from "./models.js";

/** How many counters we'll make before concluding there's no fit. */
export const MAX_COUNTER_ROUNDS = 2;

export const OfferDecision = {
  ACCEPT: "accept",
  COUNTER: "counter",
  WALK_AWAY: "walk_away",
} as const;

export type OfferDecision = (typeof OfferDecision)[keyof typeof OfferDecision];

export interface OfferOutcome {
  readonly decision: OfferDecision;
  readonly rate: number | null; // the rate to accept/counter at; null for walk_away
}

/**
 * Given what the prospect is asking for, decide how to respond. Never
 * returns ACCEPT/COUNTER at a rate above gig.budgetMax — that's the
 * "never exceed the ceiling" rule, enforced structurally rather than
 * hoped for from a prompt.
 */
export function evaluateOffer(gig: Gig, proposedRate: number, roundsSoFar: number): OfferOutcome {
  if (proposedRate <= gig.budgetMax) {
    return { decision: OfferDecision.ACCEPT, rate: proposedRate };
  }
  if (roundsSoFar >= MAX_COUNTER_ROUNDS) {
    return { decision: OfferDecision.WALK_AWAY, rate: null };
  }
  return { decision: OfferDecision.COUNTER, rate: gig.budgetMax };
}
