/** Domain-level errors: a violated invariant, never an IO failure. */

export class IllegalTransitionError extends Error {
  readonly fromStatus: string;
  readonly toStatus: string;

  constructor(fromStatus: string, toStatus: string) {
    super(`Cannot transition thread from '${fromStatus}' to '${toStatus}'`);
    this.name = "IllegalTransitionError";
    this.fromStatus = fromStatus;
    this.toStatus = toStatus;
  }
}

export class BudgetViolationError extends Error {
  readonly rate: number;
  readonly ceiling: number;

  constructor(rate: number, ceiling: number) {
    super(`Rate ${rate} exceeds budget ceiling ${ceiling}`);
    this.name = "BudgetViolationError";
    this.rate = rate;
    this.ceiling = ceiling;
  }
}

/** Thrown when a calendar hold is requested for a slot another thread
 * already holds — see adapters/outbound/calendarStub.ts. A TOCTOU gap
 * always exists between propose_slots (read) and book_slot (write); this
 * turns a would-be silent double-booking into a catchable error instead
 * of two threads believing they both own the same time. */
export class SlotUnavailableError extends Error {
  readonly slotIso: string;

  constructor(slotIso: string) {
    super(`Slot ${slotIso} is already held by another thread`);
    this.name = "SlotUnavailableError";
    this.slotIso = slotIso;
  }
}
