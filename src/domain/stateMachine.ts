/**
 * The thread lifecycle. Single source of truth for which status
 * transitions are legal — enforced in code, never left to the LLM's
 * judgment (see SYSTEM_DESIGN.md §3).
 */

export const ThreadStatus = {
  INITIATED: "initiated",
  NEGOTIATING: "negotiating",
  SCHEDULED: "scheduled",
  RESCHEDULE_REQUESTED: "reschedule_requested",
  COMPLETED: "completed",
  DECLINED: "declined",
  WALKED_AWAY: "walked_away",
  // Distinct from WALKED_AWAY (a budget decision) and DECLINED (an
  // explicit rejection): the prospect simply stopped replying. Reached
  // only after the follow-up use case has nudged them and given up —
  // see application/useCases/followUpOnSilence.ts.
  NO_RESPONSE: "no_response",
} as const;

export type ThreadStatus = (typeof ThreadStatus)[keyof typeof ThreadStatus];

export const TERMINAL_STATUSES: ReadonlySet<ThreadStatus> = new Set([
  ThreadStatus.COMPLETED,
  ThreadStatus.DECLINED,
  ThreadStatus.WALKED_AWAY,
  ThreadStatus.NO_RESPONSE,
]);

// Adjacency list of legal transitions. Anything not listed here is illegal.
const ALLOWED: Readonly<Record<ThreadStatus, ReadonlySet<ThreadStatus>>> = {
  [ThreadStatus.INITIATED]: new Set([ThreadStatus.NEGOTIATING, ThreadStatus.DECLINED, ThreadStatus.NO_RESPONSE]),
  [ThreadStatus.NEGOTIATING]: new Set([
    ThreadStatus.SCHEDULED,
    ThreadStatus.DECLINED,
    ThreadStatus.WALKED_AWAY,
    ThreadStatus.NO_RESPONSE,
  ]),
  [ThreadStatus.SCHEDULED]: new Set([
    ThreadStatus.RESCHEDULE_REQUESTED,
    ThreadStatus.COMPLETED,
    ThreadStatus.DECLINED,
  ]),
  // This is the reschedule loop: RESCHEDULE_REQUESTED always re-enters
  // NEGOTIATING (never a fresh INITIATED), so prior rate/history/tone
  // carries forward. It can cycle SCHEDULED <-> RESCHEDULE_REQUESTED <->
  // NEGOTIATING an unbounded number of times.
  [ThreadStatus.RESCHEDULE_REQUESTED]: new Set([ThreadStatus.NEGOTIATING]),
  [ThreadStatus.COMPLETED]: new Set(),
  [ThreadStatus.DECLINED]: new Set(),
  [ThreadStatus.WALKED_AWAY]: new Set(),
  [ThreadStatus.NO_RESPONSE]: new Set(),
};

export function canTransition(from: ThreadStatus, to: ThreadStatus): boolean {
  if (from === to) return false;
  return ALLOWED[from].has(to);
}

export function isTerminal(status: ThreadStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}
