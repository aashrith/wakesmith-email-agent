/**
 * Generates the three sample thread transcripts the brief asks for:
 *  1. a successful negotiation + booking
 *  2. a cancellation + re-booking (the reschedule loop)
 *  3. a graceful walk-away when there's no budget fit
 *
 * These run through the REAL domain, application, and persistence
 * layers (MarkdownMemoryRepository + StubCalendarGateway) — only the
 * LLM and outbound mail transport are scripted, since neither an
 * OpenRouter key nor a Docker mailbox is available in this generation
 * environment. The resulting .md files under transcripts/ are exactly
 * what MarkdownMemoryRepository would have written from a real run:
 * same frontmatter, same append-only body.
 *
 * Each scenario is given a fixed, descriptive thread id (rather than
 * going through initiateOutreach's uuid) purely so the output filename
 * is self-explanatory — everything else runs through the real use cases.
 */

import { rmSync } from "node:fs";
import type { AgentIntent, AgentTurnResult, InboundEmail, SentEmail } from "../src/application/dto.js";
import type { AgentTools, CalendarGateway, EmailGateway, LLMAgent, SendEmailArgs } from "../src/application/ports.js";
import { handleInboundMessage } from "../src/application/useCases/handleInboundMessage.js";
import { StubCalendarGateway } from "../src/adapters/outbound/calendarStub.js";
import { MarkdownMemoryRepository } from "../src/adapters/outbound/memoryMarkdown.js";
import type { Gig, Prospect } from "../src/domain/models.js";
import { Thread } from "../src/domain/models.js";

const TRANSCRIPTS_DIR = new URL("../transcripts/", import.meta.url).pathname;
const CALENDAR_STATE_PATH = new URL("../transcripts/.calendar_slots.json", import.meta.url).pathname;

const gig: Gig = {
  id: "sample-gig",
  title: "Contract Backend Engineer",
  description: "4-week contract building out a billing pipeline.",
  budgetMin: 60,
  budgetMax: 100,
  tone: "warm, concise, non-salesy",
};

class ScriptedEmailGateway implements EmailGateway {
  private counter = 0;
  async send(_args: SendEmailArgs): Promise<SentEmail> {
    return { messageId: `<sample-${++this.counter}@wakesmith>`, sentAt: new Date() };
  }
  async fetchNew(): Promise<InboundEmail[]> {
    return [];
  }
}

type HandleTurnFn = (thread: Thread, latestBody: string, tools: AgentTools) => Promise<AgentTurnResult> | AgentTurnResult;

class ScriptedLLM implements LLMAgent {
  constructor(
    private handleTurnFn: HandleTurnFn,
    private outreachBody: string,
  ) {}
  async draftOutreach(): Promise<string> {
    return this.outreachBody;
  }
  async classifyIntent(): Promise<AgentIntent> {
    return "other" as AgentIntent;
  }
  async handleTurn(thread: Thread, body: string, tools: AgentTools): Promise<AgentTurnResult> {
    return this.handleTurnFn(thread, body, tools);
  }
}

function inboundMessage(from: string, body: string): InboundEmail {
  return {
    fromAddress: from,
    subject: "Re: Contract Backend Engineer",
    body,
    messageId: `<in-${Date.now()}-${Math.random()}@prospect>`,
    inReplyTo: null,
    receivedAt: new Date(),
  };
}

/** The same three lines initiateOutreach performs, but with a fixed
 * thread id so the fixture's filename is descriptive. */
async function seedOutreach(
  threadId: string,
  prospect: Prospect,
  llm: LLMAgent,
  email: EmailGateway,
  memory: MarkdownMemoryRepository,
): Promise<void> {
  const thread = new Thread({ id: threadId, prospect, gig });
  const body = await llm.draftOutreach(gig, prospect);
  const sent = await email.send({ toAddress: prospect.email, subject: `Quick opportunity: ${gig.title}`, body });
  thread.recordMessage({ direction: "out", body, timestamp: sent.sentAt, messageId: sent.messageId, inReplyTo: null });
  await memory.save(thread);
}

async function scenario1(memory: MarkdownMemoryRepository, calendar: CalendarGateway) {
  const email = new ScriptedEmailGateway();
  const llm = new ScriptedLLM(
    async (_t, _b, tools) => {
      tools.proposeTerms(85);
      const { slots } = await tools.proposeSlots(3);
      await tools.bookSlot(slots[0]!);
      return {
        intent: "interested" as AgentIntent,
        replyBody: "That works — $85/hr sounds great. I've locked in Thursday at 3pm, looking forward to it!",
        toolCallsMade: ["propose_terms", "propose_slots", "book_slot"],
      };
    },
    "Hi Priya, we have a 4-week backend contract building a billing pipeline — thought of you given your FinOps background. Rate is flexible within reason. Interested in a quick call?",
  );

  const prospect: Prospect = { id: "priya", name: "Priya", email: "priya@example.com" };
  await seedOutreach("scenario-1-successful-negotiation-and-booking", prospect, llm, email, memory);
  await handleInboundMessage({
    inbound: inboundMessage("priya@example.com", "Hi! Yes, I'm interested. My rate is $85/hr — does that work for the budget?"),
    llm, email, calendar, memory,
  });
}

async function scenario2(memory: MarkdownMemoryRepository, calendar: CalendarGateway) {
  const email = new ScriptedEmailGateway();
  let turn = 0;
  const llm = new ScriptedLLM(
    async (_t, _b, tools) => {
      turn += 1;
      if (turn === 1) {
        tools.proposeTerms(90);
        const { slots } = await tools.proposeSlots(3);
        await tools.bookSlot(slots[0]!);
        return {
          intent: "interested" as AgentIntent,
          replyBody: "$90/hr works for us. Let's do Tuesday at 10am — I'll send an invite.",
          toolCallsMade: ["propose_terms", "propose_slots", "book_slot"],
        };
      }
      // Every subsequent turn is a reschedule: cancel, re-offer, re-book —
      // rate is never re-asked, history is never restated from scratch.
      await tools.cancelSlot();
      const { slots } = await tools.proposeSlots(3);
      await tools.bookSlot(slots[slots.length - 1]!);
      return {
        intent: "rescheduling" as AgentIntent,
        replyBody: "No problem at all — how about later in the week instead? I've moved you to the new slot.",
        toolCallsMade: ["cancel_slot", "propose_slots", "book_slot"],
      };
    },
    "Hi Marcus, we have a 4-week backend contract building a billing pipeline. Rate is flexible within reason. Interested in a quick call?",
  );

  const prospect: Prospect = { id: "marcus", name: "Marcus", email: "marcus@example.com" };
  await seedOutreach("scenario-2-cancellation-and-rebooking", prospect, llm, email, memory);
  await handleInboundMessage({ inbound: inboundMessage("marcus@example.com", "Sounds good, $90/hr works for me."), llm, email, calendar, memory });
  await handleInboundMessage({ inbound: inboundMessage("marcus@example.com", "Ah, something came up Tuesday — any chance we could push this?"), llm, email, calendar, memory });
  await handleInboundMessage({ inbound: inboundMessage("marcus@example.com", "Sorry again — could we move once more? This week is a mess."), llm, email, calendar, memory }); // loop runs a 2nd time
}

async function scenario3(memory: MarkdownMemoryRepository, calendar: CalendarGateway) {
  const email = new ScriptedEmailGateway();
  const llm = new ScriptedLLM(
    (_t, _b, tools) => {
      tools.proposeTerms(180); // round 0: over budget -> counter at ceiling
      tools.proposeTerms(180); // round 1: still over -> counter at ceiling
      tools.proposeTerms(180); // round 2: still over -> walk away
      return {
        intent: "objecting" as AgentIntent,
        replyBody:
          "I hear you, and I really appreciate you being upfront. $180/hr is outside what we can flex to on this one, so I don't think it's a fit right now — but I'd genuinely love to stay in touch for future gigs. Wishing you the best!",
        toolCallsMade: ["propose_terms", "propose_terms", "propose_terms"],
      };
    },
    "Hi Jordan, we have a 4-week backend contract building a billing pipeline. Rate is flexible within reason. Interested in a quick call?",
  );

  const prospect: Prospect = { id: "jordan", name: "Jordan", email: "jordan@example.com" };
  await seedOutreach("scenario-3-graceful-walk-away", prospect, llm, email, memory);
  await handleInboundMessage({
    inbound: inboundMessage("jordan@example.com", "Thanks for reaching out — my rate is $180/hr, non-negotiable given my experience level."),
    llm, email, calendar, memory,
  });
}

async function main() {
  rmSync(CALENDAR_STATE_PATH, { force: true });
  const calendar = new StubCalendarGateway(
    Array.from({ length: 10 }, (_, i) => new Date(Date.now() + (i + 1) * 86_400_000)),
    CALENDAR_STATE_PATH,
  );
  const memory = new MarkdownMemoryRepository(TRANSCRIPTS_DIR, gig);

  await scenario1(memory, calendar);
  await scenario2(memory, calendar);
  await scenario3(memory, calendar);

  console.log(`Wrote 3 sample transcripts to ${TRANSCRIPTS_DIR}`);
}

await main();
