/**
 * Composition root. This is the ONE file in the project allowed to know
 * about every concrete adapter class — it wires them behind the ports,
 * and everything downstream (use cases, API routes, the poller) only
 * ever sees the port interfaces from application/ports.ts.
 */

import { join } from "node:path";
import { StubCalendarGateway } from "./adapters/outbound/calendarStub.js";
import { SmtpImapEmailGateway } from "./adapters/outbound/emailSmtpImap.js";
import { OpenRouterAgent } from "./adapters/outbound/llmOpenRouter.js";
import { MarkdownMemoryRepository } from "./adapters/outbound/memoryMarkdown.js";
import type { CalendarGateway, EmailGateway, LLMAgent, MemoryRepository } from "./application/ports.js";
import type { AppConfig } from "./config.js";
import type { Gig } from "./domain/models.js";

export interface Container {
  gig: Gig;
  llm: LLMAgent;
  email: EmailGateway;
  calendar: CalendarGateway;
  memory: MemoryRepository;
  pollingIntervalMs: number;
}

export function buildContainer(config: AppConfig): Container {
  const gig: Gig = {
    id: config.gig.id,
    title: config.gig.title,
    description: config.gig.description,
    budgetMin: config.gig.budgetMin,
    budgetMax: config.gig.budgetMax,
    tone: config.gig.tone,
  };

  return {
    gig,
    llm: new OpenRouterAgent({ apiKey: config.llm.apiKey, model: config.llm.model, baseUrl: config.llm.baseUrl }),
    email: new SmtpImapEmailGateway({
      smtpHost: config.email.smtpHost,
      smtpPort: config.email.smtpPort,
      imapHost: config.email.imapHost,
      imapPort: config.email.imapPort,
      username: config.email.username,
      password: config.email.password,
      fromAddress: config.email.fromAddress,
      secure: config.email.secure,
    }),
    calendar: new StubCalendarGateway(config.calendar.availableSlots, config.memory.calendarStatePath),
    memory: new MarkdownMemoryRepository(join(config.memory.threadsDir), gig),
    pollingIntervalMs: config.polling.intervalMs,
  };
}
