import { beforeEach, describe, expect, it } from "vitest";
import { AgentIntent } from "../src/application/dto.js";
import type { AgentTurnResult } from "../src/application/dto.js";
import type { AgentTools } from "../src/application/ports.js";
import { handleInboundMessage } from "../src/application/useCases/handleInboundMessage.js";
import { initiateOutreach } from "../src/application/useCases/initiateOutreach.js";
import type { Gig, Prospect, Thread } from "../src/domain/models.js";
import { ThreadStatus } from "../src/domain/stateMachine.js";
import { FakeCalendarGateway, FakeEmailGateway, FakeMemoryRepository, ScriptedLLMAgent } from "./fakes.js";

function makeGig(overrides: Partial<Gig> = {}): Gig {
  return { id: "gig-1", title: "Backend contract", description: "...", budgetMin: 60, budgetMax: 100, tone: "warm", ...overrides };
}

function makeProspect(email = "sam@example.com"): Prospect {
  return { id: "p-1", name: "Sam", email };
}

function makeInbound(body: string, inReplyTo: string | null = null) {
  return {
    fromAddress: "sam@example.com",
    subject: "Re: Backend contract",
    body,
    messageId: `in-${Date.now()}-${Math.random()}`,
    inReplyTo,
    receivedAt: new Date(),
  };
}

async function negotiateAndBook(_thread: Thread, _body: string, tools: AgentTools): Promise<AgentTurnResult> {
  tools.proposeTerms(85);
  const { slots } = await tools.proposeSlots(3);
  await tools.bookSlot(slots[0]!);
  return { intent: AgentIntent.INTERESTED, replyBody: "Great, locked in.", toolCallsMade: ["proposeTerms", "proposeSlots", "bookSlot"] };
}

async function cancelThenRebook(_thread: Thread, _body: string, tools: AgentTools): Promise<AgentTurnResult> {
  await tools.cancelSlot();
  const { slots } = await tools.proposeSlots(3);
  await tools.bookSlot(slots[slots.length - 1]!);
  return { intent: AgentIntent.RESCHEDULING, replyBody: "No problem, how about this time instead?", toolCallsMade: ["cancelSlot", "proposeSlots", "bookSlot"] };
}

async function overBudgetWalkAway(_thread: Thread, _body: string, tools: AgentTools): Promise<AgentTurnResult> {
  tools.proposeTerms(200); // round 0 -> counter
  tools.proposeTerms(200); // round 1 -> counter
  tools.proposeTerms(200); // round 2 -> walk away
  return { intent: AgentIntent.OBJECTING, replyBody: "Unfortunately that's outside our budget — wishing you the best.", toolCallsMade: ["proposeTerms", "proposeTerms", "proposeTerms"] };
}

describe("initiateOutreach", () => {
  it("sends the first email and persists the thread", async () => {
    const email = new FakeEmailGateway();
    const memory = new FakeMemoryRepository();
    const llm = new ScriptedLLMAgent();
    const thread = await initiateOutreach({ gig: makeGig(), prospect: makeProspect(), llm, email, memory });

    expect(email.sent).toHaveLength(1);
    expect(thread.status).toBe(ThreadStatus.INITIATED);
    expect(await memory.findByProspectEmail("sam@example.com")).toBe(thread);
  });

  it("is idempotent — no re-pitch to an existing thread", async () => {
    const email = new FakeEmailGateway();
    const memory = new FakeMemoryRepository();
    const llm = new ScriptedLLMAgent();
    const gig = makeGig();
    const prospect = makeProspect();
    const t1 = await initiateOutreach({ gig, prospect, llm, email, memory });
    const t2 = await initiateOutreach({ gig, prospect, llm, email, memory });
    expect(t1.id).toBe(t2.id);
    expect(email.sent).toHaveLength(1);
  });
});

describe("handleInboundMessage", () => {
  let email: FakeEmailGateway;
  let calendar: FakeCalendarGateway;
  let memory: FakeMemoryRepository;

  beforeEach(() => {
    email = new FakeEmailGateway();
    calendar = new FakeCalendarGateway();
    memory = new FakeMemoryRepository();
  });

  it("negotiates within budget and books a call", async () => {
    const llm = new ScriptedLLMAgent(negotiateAndBook);
    const gig = makeGig();
    const prospect = makeProspect();
    await initiateOutreach({ gig, prospect, llm, email, memory });

    const thread = await handleInboundMessage({
      inbound: makeInbound("Sounds interesting, I'd want $85/hr"),
      llm, email, calendar, memory,
    });

    expect(thread.status).toBe(ThreadStatus.SCHEDULED);
    expect(thread.negotiation.currentRate).toBe(85);
    expect(thread.negotiation.currentSlot).not.toBeNull();
    expect(email.sent).toHaveLength(2); // outreach + negotiation reply
  });

  it("runs the reschedule loop N times without losing history or re-litigating rate", async () => {
    const llm = new ScriptedLLMAgent(negotiateAndBook);
    const gig = makeGig();
    const prospect = makeProspect();
    await initiateOutreach({ gig, prospect, llm, email, memory });
    let thread = await handleInboundMessage({ inbound: makeInbound("Works for me at $85/hr"), llm, email, calendar, memory });
    expect(thread.status).toBe(ThreadStatus.SCHEDULED);

    llm.setHandleTurnFn(cancelThenRebook);
    for (let i = 0; i < 3; i++) {
      thread = await handleInboundMessage({
        inbound: makeInbound("Something came up, can we reschedule?"),
        llm, email, calendar, memory,
      });
      expect(thread.status).toBe(ThreadStatus.SCHEDULED);
      expect(thread.negotiation.currentRate).toBe(85); // rate never re-litigated
    }

    expect(thread.negotiation.rescheduleCount).toBe(3);
    expect(thread.messages).toHaveLength(1 + 2 + 2 * 3); // outreach + 1st negotiate round + 3 reschedule rounds
    expect(email.sent).toHaveLength(5);
  });

  it("walks away gracefully when there's no budget fit", async () => {
    const llm = new ScriptedLLMAgent(overBudgetWalkAway);
    const gig = makeGig({ budgetMax: 100 });
    const prospect = makeProspect();
    await initiateOutreach({ gig, prospect, llm, email, memory });

    const thread = await handleInboundMessage({
      inbound: makeInbound("I need $200/hr, non-negotiable"),
      llm, email, calendar, memory,
    });
    expect(thread.status).toBe(ThreadStatus.WALKED_AWAY);
  });

  it("never re-engages a terminal thread", async () => {
    const llm = new ScriptedLLMAgent(overBudgetWalkAway);
    const gig = makeGig({ budgetMax: 100 });
    const prospect = makeProspect();
    await initiateOutreach({ gig, prospect, llm, email, memory });
    await handleInboundMessage({ inbound: makeInbound("I need $200/hr"), llm, email, calendar, memory });

    const callsBefore = llm.handleTurnCalls;
    const thread = await handleInboundMessage({ inbound: makeInbound("Actually reconsider?"), llm, email, calendar, memory });
    expect(thread.status).toBe(ThreadStatus.WALKED_AWAY);
    expect(llm.handleTurnCalls).toBe(callsBefore); // reasoning never invoked on a closed thread
  });
});
