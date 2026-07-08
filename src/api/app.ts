/**
 * API/controller layer. Thin on purpose: every route just validates its
 * input against a TypeBox schema (via Elysia's `t`, which re-exports
 * TypeBox) and delegates straight to a use case or the shared poll
 * cycle — no business logic lives here. Exported as a builder function
 * (rather than a module-level singleton) so tests can construct it
 * against a fake Container without booting real IO.
 */

import { node } from "@elysiajs/node";
import { Elysia, t } from "elysia";
import { runPollCycle } from "../adapters/inbound/pollCycle.js";
import { initiateOutreach } from "../application/useCases/initiateOutreach.js";
import type { Container } from "../bootstrap.js";
import type { Thread } from "../domain/models.js";
import { logger } from "../lib/logger.js";

function summarize(thread: Thread) {
  return {
    id: thread.id,
    status: thread.status,
    prospectEmail: thread.prospect.email,
    currentRate: thread.negotiation.currentRate,
    currentSlot: thread.negotiation.currentSlot?.toISOString() ?? null,
    rescheduleCount: thread.negotiation.rescheduleCount,
    messageCount: thread.messages.length,
    updatedAt: thread.updatedAt.toISOString(),
  };
}

export function buildApp(container: Container) {
  return new Elysia({ adapter: node() })
    // Centralized error handling: TypeBox validation failures already
    // become 422s automatically (Elysia's `validation` error code) with
    // the schema mismatch details, which is safe to expose. Anything
    // else is unexpected — log it server-side with a correlation id but
    // return a generic message, never a raw stack trace, to the caller.
    .onError(({ code, error, set }) => {
      if (code === "VALIDATION") {
        set.status = 422;
        return { error: "validation_failed", message: error.message };
      }
      const incidentId = crypto.randomUUID();
      logger.error("unhandled request error", { incidentId, code, error: String(error) });
      set.status = 500;
      return { error: "internal_error", incidentId };
    })

    .get("/health", () => ({ status: "ok" }))

    .get("/threads", async () => {
      const ids = await container.memory.allThreadIds();
      const threads = await Promise.all(ids.map((id) => container.memory.load(id)));
      return threads.filter((t): t is Thread => t !== null).map(summarize);
    })

    .get(
      "/threads/:id",
      async ({ params, set }) => {
        const thread = await container.memory.load(params.id);
        if (!thread) {
          set.status = 404;
          return { error: `No thread with id ${params.id}` };
        }
        return {
          ...summarize(thread),
          messages: thread.messages.map((m) => ({
            direction: m.direction,
            body: m.body,
            timestamp: m.timestamp.toISOString(),
          })),
        };
      },
      { params: t.Object({ id: t.String() }) },
    )

    .post(
      "/outreach",
      async ({ body }) => {
        const thread = await initiateOutreach({
          gig: container.gig,
          prospect: { id: body.prospectId, name: body.prospectName, email: body.prospectEmail },
          llm: container.llm,
          email: container.email,
          memory: container.memory,
        });
        return summarize(thread);
      },
      {
        body: t.Object({
          prospectId: t.String(),
          prospectName: t.String(),
          prospectEmail: t.String({ format: "email" }),
        }),
      },
    )

    .post("/poll", async () => runPollCycle(container));
}

export type App = ReturnType<typeof buildApp>;
