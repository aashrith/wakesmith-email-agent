/**
 * The tool-call contract with the model, both directions:
 *  - the OpenAI-style JSON schema sent to OpenRouter so the model knows
 *    what it can call and with what shape;
 *  - the TypeBox schema used to validate the arguments the model sends
 *    back, since that JSON is untrusted external input the moment it
 *    leaves the model — a hallucinated or malformed argument must be
 *    caught here, not crash the adapter loop three layers down.
 */

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const ProposeTermsArgs = Type.Object({ rate: Type.Number() });
export const ProposeSlotsArgs = Type.Object({ n: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })) });
export const BookSlotArgs = Type.Object({ slotIso: Type.String({ minLength: 1 }) });
export const NoArgs = Type.Object({});

export type ProposeTermsArgs = Static<typeof ProposeTermsArgs>;
export type ProposeSlotsArgs = Static<typeof ProposeSlotsArgs>;
export type BookSlotArgs = Static<typeof BookSlotArgs>;

export const TOOL_ARG_SCHEMAS = {
  get_thread_state: NoArgs,
  propose_terms: ProposeTermsArgs,
  propose_slots: ProposeSlotsArgs,
  book_slot: BookSlotArgs,
  cancel_slot: NoArgs,
  decline: NoArgs,
} as const;

export type ToolName = keyof typeof TOOL_ARG_SCHEMAS;

export class ToolArgumentError extends Error {
  constructor(
    readonly toolName: string,
    readonly issues: string,
  ) {
    super(`Invalid arguments for tool '${toolName}': ${issues}`);
    this.name = "ToolArgumentError";
  }
}

/** Parse + validate raw JSON-from-the-model against the tool's schema.
 * Throws ToolArgumentError (caller turns this into a tool-result error
 * fed back to the model, rather than crashing the loop) on mismatch. */
export function parseToolArgs<T extends ToolName>(toolName: T, rawJson: string): Static<(typeof TOOL_ARG_SCHEMAS)[T]> {
  let parsed: unknown;
  try {
    parsed = rawJson.trim() === "" ? {} : JSON.parse(rawJson);
  } catch (err) {
    throw new ToolArgumentError(toolName, `not valid JSON: ${(err as Error).message}`);
  }
  const schema = TOOL_ARG_SCHEMAS[toolName];
  if (!Value.Check(schema, parsed)) {
    const issues = [...Value.Errors(schema, parsed)].map((e) => `${e.path} ${e.message}`).join("; ");
    throw new ToolArgumentError(toolName, issues || "shape mismatch");
  }
  return parsed as Static<(typeof TOOL_ARG_SCHEMAS)[T]>;
}

/** The JSON-schema-as-OpenAI-function-spec side, sent in the request. */
export const OPENAI_TOOL_SPECS = [
  {
    type: "function",
    function: {
      name: "get_thread_state",
      description: "Read the current authoritative state of this thread: status, agreed rate, booked slot, budget range, and recent messages.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_terms",
      description: "Evaluate a rate the prospect proposed against our budget ceiling. Returns accept / counter / walk_away and the rate to use. Never invent this decision yourself — always call this tool.",
      parameters: {
        type: "object",
        properties: { rate: { type: "number", description: "The hourly/rate figure the prospect proposed." } },
        required: ["rate"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_slots",
      description: "Get up to n available call slots to offer the prospect.",
      parameters: {
        type: "object",
        properties: { n: { type: "integer", description: "How many slots to fetch (default 3)." } },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "book_slot",
      description: "Lock in a specific slot (ISO 8601 datetime) once the prospect has agreed to it.",
      parameters: {
        type: "object",
        properties: { slotIso: { type: "string", description: "ISO 8601 datetime of the chosen slot, exactly as returned by propose_slots." } },
        required: ["slotIso"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_slot",
      description: "The prospect can no longer make the currently booked slot. Releases it and re-opens negotiation so a new time can be proposed — this is the reschedule loop.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "decline",
      description: "The prospect has explicitly declined and there is no further fit. Closes the thread.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
] as const;
