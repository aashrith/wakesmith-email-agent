/**
 * OpenRouter adapter — plain `fetch` against OpenRouter's OpenAI-compatible
 * chat-completions endpoint, so the model behind the agent loop is a
 * config value (see SYSTEM_DESIGN.md §6, assumption 1), not a hardcoded
 * SDK integration.
 *
 * This is where "perception → reasoning → action" actually happens as a
 * loop: the model calls a tool, we execute it against AgentTools (which
 * only ever mutates the in-memory Thread aggregate — see
 * application/tools.ts), feed the result back, and repeat until the
 * model returns plain text with no further tool calls. That text is the
 * only "action" the use case takes on trust from the LLM: everything
 * state-changing already happened, guarded, before the email is sent.
 */

import { AgentIntent } from "../../application/dto.js";
import type { AgentTurnResult } from "../../application/dto.js";
import type { AgentTools, LLMAgent } from "../../application/ports.js";
import type { Gig, Prospect, Thread } from "../../domain/models.js";
import { logger } from "../../lib/logger.js";
import { isTransientNetworkError, withRetry } from "../../lib/retry.js";
import { OPENAI_TOOL_SPECS, parseToolArgs, ToolArgumentError, type ToolName } from "./toolSchemas.js";

export interface OpenRouterConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

const MAX_TOOL_ITERATIONS = 6;

export class OpenRouterAgent implements LLMAgent {
  private readonly baseUrl: string;

  constructor(private readonly config: OpenRouterConfig) {
    this.baseUrl = config.baseUrl ?? "https://openrouter.ai/api/v1";
  }

  private async chatCompletion(messages: ChatMessage[], useTools: boolean): Promise<any> {
    return withRetry(
      async () => {
        const res = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: this.config.model,
            messages,
            ...(useTools ? { tools: OPENAI_TOOL_SPECS, tool_choice: "auto" } : {}),
          }),
        });
        if (!res.ok) {
          const body = await res.text();
          throw new Error(`OpenRouter request failed (${res.status}): ${body}`);
        }
        return res.json();
      },
      {
        retries: 2,
        isRetryable: (err) => {
          const retryable = isTransientNetworkError(err);
          if (retryable) logger.warn("openrouter request failed, retrying", { error: String(err) });
          return retryable;
        },
      },
    );
  }

  async draftOutreach(gig: Gig, prospect: Prospect): Promise<string> {
    const system = [
      `You are writing a first-contact email on behalf of a hiring team about a work opportunity.`,
      `Gig: ${gig.title} — ${gig.description}`,
      `Tone: ${gig.tone}. Natural, non-salesy, a few sentences. No subject line, body text only.`,
      `Address the recipient by name and invite a reply if they're interested.`,
    ].join("\n");
    const messages: ChatMessage[] = [
      { role: "system", content: system },
      { role: "user", content: `Write the cold-open email to ${prospect.name}.` },
    ];
    const response = await this.chatCompletion(messages, false);
    return response.choices[0].message.content ?? "";
  }

  async classifyIntent(latestInboundBody: string): Promise<AgentIntent> {
    const labels = Object.values(AgentIntent);
    const system = `Classify the reply's intent as exactly one of: ${labels.join(", ")}. Respond with only the label, nothing else.`;
    const messages: ChatMessage[] = [
      { role: "system", content: system },
      { role: "user", content: latestInboundBody },
    ];
    const response = await this.chatCompletion(messages, false);
    const label = (response.choices[0].message.content ?? "").trim().toLowerCase();
    return (labels as string[]).includes(label) ? (label as AgentIntent) : AgentIntent.OTHER;
  }

  async handleTurn(thread: Thread, _latestInboundBody: string, tools: AgentTools): Promise<AgentTurnResult> {
    const system = [
      `You are emailing on behalf of a hiring team about: ${thread.gig.title}.`,
      `Tone: ${thread.gig.tone}.`,
      `Budget ceiling (internal — never state this number to the prospect): ${thread.gig.budgetMax}.`,
      `Rules: never agree to a rate above the ceiling. Always call propose_terms to evaluate a rate rather than deciding yourself.`,
      `Always call propose_slots before offering times, and book_slot once the prospect agrees to one.`,
      `If the prospect says they can no longer make a booked time, call cancel_slot, then propose_slots again and book_slot on the new time — do not restart the conversation or re-litigate the rate.`,
      `If there's no fit or the prospect declines outright, call decline.`,
      `Once you've taken whatever tool actions are needed, respond with ONLY the plain-text email body to send — no tool call, no commentary.`,
    ].join("\n");

    const messages: ChatMessage[] = [
      { role: "system", content: system },
      ...thread.messages.map((m) => ({
        role: (m.direction === "in" ? "user" : "assistant") as "user" | "assistant",
        content: m.body,
      })),
    ];

    const toolCallsMade: string[] = [];

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const response = await this.chatCompletion(messages, true);
      const message = response.choices[0].message;

      if (!message.tool_calls || message.tool_calls.length === 0) {
        const intent = await this.classifyIntent(_latestInboundBody);
        logger.info("agent turn resolved", { threadId: thread.id, iteration, toolCallsMade, intent });
        return { intent, replyBody: message.content ?? "", toolCallsMade };
      }

      messages.push({ role: "assistant", content: message.content ?? null, tool_calls: message.tool_calls });

      for (const call of message.tool_calls) {
        const name = call.function.name as ToolName;
        let resultPayload: unknown;
        try {
          resultPayload = await this.dispatch(name, call.function.arguments, tools);
          toolCallsMade.push(name);
        } catch (err) {
          // A bad tool call (malformed args, hallucinated slot) is fed
          // back to the model as a tool-result error so it can course
          // correct on the next iteration, rather than crashing the turn.
          const errorMessage = err instanceof ToolArgumentError ? err.message : String(err);
          logger.warn("tool call failed, returning error to model", { threadId: thread.id, tool: name, error: errorMessage });
          resultPayload = { error: errorMessage };
        }
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(resultPayload) });
      }
    }

    logger.error("agent loop did not converge", { threadId: thread.id, maxIterations: MAX_TOOL_ITERATIONS });
    throw new Error(`Agent loop did not converge within ${MAX_TOOL_ITERATIONS} tool-call iterations for thread ${thread.id}`);
  }

  private async dispatch(name: ToolName, rawArgs: string, tools: AgentTools): Promise<unknown> {
    switch (name) {
      case "get_thread_state":
        parseToolArgs("get_thread_state", rawArgs);
        return tools.getThreadState();
      case "propose_terms": {
        const args = parseToolArgs("propose_terms", rawArgs);
        return tools.proposeTerms(args.rate);
      }
      case "propose_slots": {
        const args = parseToolArgs("propose_slots", rawArgs);
        return tools.proposeSlots(args.n);
      }
      case "book_slot": {
        const args = parseToolArgs("book_slot", rawArgs);
        return tools.bookSlot(args.slotIso);
      }
      case "cancel_slot":
        parseToolArgs("cancel_slot", rawArgs);
        return tools.cancelSlot();
      case "decline":
        parseToolArgs("decline", rawArgs);
        return tools.decline();
      default: {
        const _exhaustive: never = name;
        throw new Error(`Unknown tool: ${_exhaustive}`);
      }
    }
  }
}
