/**
 * Small data-transfer shapes passed across port boundaries.
 * Application-layer shapes only — no IMAP/SMTP/OpenRouter wire types
 * leak in here.
 */

export interface InboundEmail {
  readonly fromAddress: string;
  readonly subject: string;
  readonly body: string;
  readonly messageId: string;
  readonly inReplyTo: string | null;
  readonly receivedAt: Date;
}

export interface SentEmail {
  readonly messageId: string;
  readonly sentAt: Date;
}

/**
 * Perception-layer classification, kept for logging/observability — the
 * reasoning loop itself doesn't branch on this, it lets the model reach
 * the right tool calls directly. See application/tools.ts.
 */
export const AgentIntent = {
  INTERESTED: "interested",
  OBJECTING: "objecting",
  DECLINING: "declining",
  RESCHEDULING: "rescheduling",
  OTHER: "other",
} as const;

export type AgentIntent = (typeof AgentIntent)[keyof typeof AgentIntent];

export interface AgentTurnResult {
  readonly intent: AgentIntent;
  readonly replyBody: string;
  readonly toolCallsMade: readonly string[];
}
