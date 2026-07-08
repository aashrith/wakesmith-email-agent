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
