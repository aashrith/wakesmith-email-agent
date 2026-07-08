# Wakesmith — Email Wake-Up Agent

An autonomous agent that emails a prospect about a gig, negotiates within a budget ceiling, books a call, and handles the reschedule loop — without ever losing thread context. Built for the MarseerAI take-home.

Full design rationale lives in [`SYSTEM_DESIGN.md`](./SYSTEM_DESIGN.md) and [`architecture.excalidraw`](./architecture.excalidraw) (open at excalidraw.com). This README is the short version.

## Setup

Requires Node ≥20 and Docker.

```bash
cp .env.example .env        # add your OPENROUTER_API_KEY
npm install
docker compose up --build   # starts GreenMail (real SMTP+IMAP test mailbox) + the agent
```

The agent's API comes up on `:3000`; the background poller starts alongside it automatically.

For local dev without Docker: run `docker compose up mailserver` for just the mailbox, point `config/config.yaml`'s `email.smtpHost`/`imapHost` at `localhost`, then `npm run dev`.

Seed a prospect and drive the demo via CLI:

```bash
npm run cli -- outreach --id p-1 --name Sam --email sam@wakesmith.test
# simulate the prospect replying via GreenMail's prospect@wakesmith.test mailbox, then:
npm run cli -- poll
npm run cli -- threads
npm run cli -- thread <id>
```

## Architecture

Hexagonal / DDD, four layers:

- **`src/domain`** — pure business logic, zero IO. `Thread` aggregate owns its own state machine (`initiated → negotiating → scheduled ⇄ reschedule_requested → completed / declined / walked_away`); `policies.ts` is the deterministic accept/counter/walk-away decision the brief's budget rule requires.
- **`src/application`** — use cases (`initiateOutreach`, `handleInboundMessage`) and the ports they depend on (`EmailGateway`, `CalendarGateway`, `MemoryRepository`, `LLMAgent`), all as TypeScript interfaces. `tools.ts` is the LLM's toolbelt — it mutates the in-memory `Thread` via its guarded methods only; nothing external happens until the use case sends the resulting email.
- **`src/adapters`** — outbound: OpenRouter (chat-completions + tool calling), SMTP/IMAP (nodemailer + imapflow), markdown-per-thread memory, stubbed calendar. Inbound: Elysia API, IMAP poller, CLI.
- **`src/api`**, **`src/bootstrap.ts`, `src/config.ts`** — the one composition root that knows every concrete adapter; everything else only sees ports.

Perception → reasoning → action is a real loop, not a metaphor: the model calls a tool (`propose_terms`, `propose_slots`, `book_slot`, `cancel_slot`, `decline`), the adapter executes it against the toolbelt, feeds the result back, and repeats until the model returns plain text — that text is the only thing the use case sends.

## Assumptions

1. **LLM**: OpenRouter, OpenAI-compatible chat-completions schema — model is a config value.
2. **Email**: GreenMail in Docker (real SMTP+IMAP), not a live mailbox — a reproducible test inbox anyone can `docker compose up`, per the brief's own allowance.
3. **Calendar**: stubbed slot picker (config-driven), explicitly not live Google Calendar — the brief allows this.
4. **Memory**: markdown file per thread (YAML state header + append-only body), not Postgres/SQLite/Redis/vector DB. Chosen because the problem is small and bounded (one thread per prospect) and demands completeness over retrieval sophistication — full reasoning in `SYSTEM_DESIGN.md` §4.
5. **Scope**: one running agent = one gig campaign.
6. **Elysia runtime**: the Node adapter (`@elysiajs/node`), not Bun — keeps the whole stack runnable with just Node, no functional difference to the API itself.

## Trade-offs

- **tsx, no build step.** The container runs TypeScript directly rather than compiling to JS first. Right call at this scale (one process, one mailbox); a real production deploy would add a `tsc` build stage.
- **Markdown memory over a database.** Trivial to inspect and git-diff; the cost is O(n) prospect lookup (scans thread files) — fine at dozens of threads, would need an index at thousands.
- **`setInterval` polling over a job queue.** No distributed workers to coordinate, so BullMQ/cron infra would be solving a scale problem this project doesn't have.
- **Structured JSON logging over pino/winston.** One process, no log-shipping pipeline to feed yet.
- **`exactOptionalPropertyTypes` left off.** Kept `strict` + `noUncheckedIndexedAccess`; the exact-optional variant fought config/env plumbing for marginal benefit.

## API

| Route | Description |
|---|---|
| `GET /health` | liveness check |
| `GET /threads` | list all threads (status, rate, slot, message count) |
| `GET /threads/:id` | full thread detail incl. message history |
| `POST /outreach` | `{ prospectId, prospectName, prospectEmail }` — start a new thread |
| `POST /poll` | manually trigger one inbound-mail poll cycle |

All request bodies are validated with TypeBox (via Elysia's `t`); a schema mismatch returns `422` with the specific validation error, not a stack trace. Unexpected errors return a generic `500` + `incidentId`, logged server-side.

## Verification

```bash
npm run typecheck   # tsc --noEmit, strict
npm test            # 42 tests: domain, application (fakes), adapters, persistence round-trip, API, retry
npm run test:coverage
npm run transcripts  # regenerates transcripts/*.md from the real domain+application+persistence layers
```

`transcripts/` contains the three required sample threads, generated by actually running the code (only the LLM and mail transport are scripted, since neither an OpenRouter key nor Docker are available in this generation environment):

- `scenario-1-successful-negotiation-and-booking.md`
- `scenario-2-cancellation-and-rebooking.md` — the reschedule loop, run twice
- `scenario-3-graceful-walk-away.md`

Loom walkthrough: _add link before submitting_.
