# Wakesmith — Email Wake-Up Agent

An autonomous agent that emails a prospect about a gig, negotiates within a budget ceiling, books a call, and handles the reschedule loop — without ever losing thread context. Built for the MarseerAI take-home.

Full design rationale lives in [`SYSTEM_DESIGN.md`](./SYSTEM_DESIGN.md) and [`architecture.excalidraw`](./architecture.excalidraw) (open at excalidraw.com). This README is the short version.

## Setup

Requires Node ≥24 (LTS), pnpm (`corepack enable` if you don't have it), and Docker.

```bash
cp .env.example .env        # add your OPENROUTER_API_KEY
pnpm install
docker compose up --build   # starts GreenMail (real SMTP+IMAP test mailbox) + the agent
```

The agent's API comes up on `:3000`; the background poller starts alongside it automatically.

For local dev without Docker: run `docker compose up mailserver` for just the mailbox, point `config/config.yaml`'s `email.smtpHost`/`imapHost` at `localhost`, then `pnpm dev` — `dev`/`start`/`poll`/`cli` all load `.env` automatically via Node's `--env-file-if-exists`. Inside Docker there's just an empty placeholder `.env` (the real one is excluded via `.dockerignore`); the actual secrets come from `docker-compose.yml`'s `environment:` block instead.

Seed a prospect and drive the demo via CLI. Since `config/config.yaml` points `smtpHost`/`imapHost` at `mailserver` — a hostname that only resolves *inside* Docker's network — run the CLI inside the already-running `agent` container rather than bare on the host:

```bash
docker compose exec agent pnpm cli outreach --id p-1 --name Sam --email sam@wakesmith.test
# simulate the prospect replying via GreenMail's prospect@wakesmith.test mailbox, then:
docker compose exec agent pnpm cli poll
docker compose exec agent pnpm cli threads
docker compose exec agent pnpm cli thread <id>
docker compose exec agent pnpm cli check-silence --threshold-ms 0   # force-nudge a quiet thread for a demo
```

(Running the local-dev-without-Docker setup above instead? Drop `docker compose exec agent` and use bare `pnpm cli ...` — that's the mode it's for.)

## Architecture

Hexagonal / DDD, four layers:

- **`src/domain`** — pure business logic, zero IO. `Thread` aggregate owns its own state machine (`initiated → negotiating → scheduled ⇄ reschedule_requested → completed / declined / walked_away / no_response`); `policies.ts` is the deterministic accept/counter/walk-away decision the brief's budget rule requires.
- **`src/application`** — use cases (`initiateOutreach`, `handleInboundMessage`, `followUpOnSilence`) and the ports they depend on (`EmailGateway`, `CalendarGateway`, `MemoryRepository`, `LLMAgent`), all as TypeScript interfaces. `tools.ts` is the LLM's toolbelt — it mutates the in-memory `Thread` via its guarded methods only; nothing external happens until the use case sends the resulting email. `followUpOnSilence` handles the "silent" intent the brief names — triggered by elapsed time on `Thread.updatedAt`, not message content, since silence isn't something you classify from a reply.
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

- **tsx at runtime, Vite as a hygiene gate, not a rewrite.** The container still runs TypeScript directly via `tsx` (right call at this scale — one process, one mailbox). `pnpm build` (Vite, Node/SSR target, `node_modules` kept external) exists purely as a second, independent check that the source graph actually resolves and bundles — `tsc --noEmit` catches type errors, this catches bundling/circular-import issues tsc alone can miss. `dist/` is a CI artifact; it's not what `docker compose` runs.
- **pnpm over npm.** Content-addressable store and a stricter `node_modules` layout (no phantom access to undeclared transitive deps) for negligible extra setup cost.
- **Node ≥24 (LTS), not ≥20.** Current pnpm (11.x, pinned via `packageManager`) requires Node ≥22.13 — it uses the `node:sqlite` built-in internally for its store index. Rather than pin pnpm back to the 10.x line to keep an older Node floor, the project's Node requirement moved up to 24 (current LTS) across `package.json` engines, the Dockerfile base image, and this README. Caught this by actually running `docker compose up --build` against `node:20-slim`, which failed with `ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite` — not something `pnpm install` on the host surfaces, since a host machine's own Node is usually newer than the container's pinned base image.
- **ESLint, type-aware rules off.** `typescript-eslint`'s `recommended` (not `recommended-type-checked`) — `tsc --noEmit` already owns type correctness; ESLint's job here is dead code and footguns (unused vars, shadowing — the exact bug class caught by hand once in `llmOpenRouter.ts` before this was automated).
- **Markdown memory over a database.** Trivial to inspect and git-diff; the cost is O(n) prospect lookup (scans thread files) — fine at dozens of threads, would need an index at thousands.
- **`setInterval` polling over a job queue.** No distributed workers to coordinate, so BullMQ/cron infra would be solving a scale problem this project doesn't have.
- **Structured JSON logging over pino/winston.** One process, no log-shipping pipeline to feed yet.
- **`exactOptionalPropertyTypes` left off.** Kept `strict` + `noUncheckedIndexedAccess`; the exact-optional variant fought config/env plumbing for marginal benefit.
- **`.dockerignore` matters here, not just for image size.** Missing it initially meant `COPY . .` (which runs after `pnpm install --frozen-lockfile`) copied the host's own `node_modules` — built for the host's OS/arch — straight on top of the container's correctly-installed Linux one. pnpm's automatic pre-run deps check noticed the mismatch and tried to purge + reinstall, which needs an interactive confirmation a container can't give, so the agent exited on start instead of running.
- **`-Dgreenmail.users.login=email` isn't cosmetic.** GreenMail's default (`-Dgreenmail.users.login=local_part`) only accepts the local part (`agent`) as an IMAP/SMTP login when users are configured as `login:pwd@domain`, not the full address (`agent@wakesmith.test`) this project uses as the username everywhere else. Without the flag, every poll cycle failed with imapflow's generic `Error('Command failed')` — confirmed against GreenMail's own documented CLI options, not guessed from the error alone.
- **No `--` with pnpm.** `pnpm cli -- outreach ...` (the npm-era convention for "everything after this is the script's, not the package manager's") doesn't do what it looks like under pnpm — pnpm forwards `--` through literally as an argv token instead of stripping it, so `cli.ts`'s `const [command, ...rest] = process.argv.slice(2)` saw `command === "--"` and always hit the usage/error branch. Every CLI example in this README used to include it; none of them had actually been run end-to-end until they were. Fixed by dropping the `--` everywhere — `pnpm cli outreach --id p-1 ...` forwards flags to the script just fine without it.
- **`.env` loading for the no-Docker path.** Nothing loaded `.env` into `process.env` outside of Docker Compose's `environment:` block, so `pnpm cli`/`pnpm dev` run directly on the host failed with `Missing required environment variable: OPENROUTER_API_KEY` even with a correctly filled-in `.env` file. Fixed with Node's built-in `--env-file-if-exists=.env` flag on the relevant scripts rather than adding a `dotenv` dependency. Inside Docker, the Dockerfile `touch`es an empty `.env` placeholder (the real one stays excluded via `.dockerignore`) purely so the flag finds a file and stays quiet instead of logging ".env not found" on every start — the container's actual secrets still come entirely from `docker-compose.yml`'s `environment:` block.
- **Known harmless test noise.** `pnpm test` prints an `[exact-mirror] TypeCompiler is required to use Union` stack trace to stderr on the `/check-silence` test — an upstream Elysia/TypeBox schema-compiler quirk on `Optional` fields with this dependency combination. It's caught internally and doesn't affect the response or fail the test (all 52 pass); left as-is rather than restructuring a working route schema to silence a third-party log line.
- **Calendar holds have no expiry, so orphaned holds are possible.** `StubCalendarGateway` keys holds by `threadId` in `memory/calendar_slots.json`, shared across every thread. If a thread's own record is ever deleted without going through `cancel_slot` (e.g. manually clearing test data), its hold on a slot is never released — a later, unrelated thread can be offered that slot by `propose_slots`, then told it's unavailable if the prospect picks it in the window before a `book_slot` re-check. Caught this during manual demo testing, not designed for upfront: added a same-slot collision check in `hold()` (`SlotUnavailableError`, surfaced through `book_slot` as `{ ok: false, error }` instead of silently double-booking) plus `pnpm reset-demo`, which clears `memory/threads/*.md` and `memory/calendar_slots.json` so a demo/recording starts from a clean slate. A real fix (hold TTL or reconciliation against `memory/threads/`) is out of scope for a stubbed adapter.

## API

| Route | Description |
|---|---|
| `GET /health` | liveness check |
| `GET /threads` | list all threads (status, rate, slot, message count) |
| `GET /threads/:id` | full thread detail incl. message history |
| `POST /outreach` | `{ prospectId, prospectName, prospectEmail }` — start a new thread |
| `POST /poll` | manually trigger one inbound-mail poll cycle |
| `POST /check-silence` | scan for quiet threads and nudge/close them; optional `{ thresholdMs, maxNudges }` body overrides config for a demo |

All request bodies are validated with TypeBox (via Elysia's `t`); a schema mismatch returns `422` with the specific validation error, not a stack trace. Unexpected errors return a generic `500` + `incidentId`, logged server-side.

## Verification

```bash
pnpm typecheck   # tsc --noEmit, strict
pnpm lint        # eslint, flat config — 0 errors, 0 warnings
pnpm build       # vite build — bundles cleanly to dist/ (CI-style check, not the runtime path)
pnpm test        # 52 tests: domain, application (fakes), adapters, persistence round-trip, API, retry
pnpm test:coverage
pnpm transcripts # regenerates transcripts/*.md from the real domain+application+persistence layers
```

`transcripts/` contains the three required sample threads plus one more, generated by actually running the code (only the LLM and mail transport are scripted, since neither an OpenRouter key nor Docker are available in this generation environment):

- `scenario-1-successful-negotiation-and-booking.md`
- `scenario-2-cancellation-and-rebooking.md` — the reschedule loop, run twice
- `scenario-3-graceful-walk-away.md`
- `scenario-4-silent-prospect-follow-up-and-close.md` — not brief-required, but "silent" is a named intent, so it gets the same real-code proof: nudged twice, then closed without a third email

These four are generated with a scripted LLM and mail transport (no OpenRouter key or Docker available in this generation environment) — see the **Live demo runbook** below for the real, end-to-end version against an actual model and mailbox.

## Live demo runbook

The steps above prove the logic; this proves the real round-trip the brief asks for, against a real OpenRouter model and a real (Dockerized) SMTP/IMAP mailbox. Run against the full `docker compose up --build` stack — it's what a reviewer would actually run themselves, so it's the strongest proof the repo works as shipped. CLI commands go through `docker compose exec agent` for the same reason as above (`mailserver` only resolves inside Docker's network); `pnpm simulate-reply` is the exception — it defaults to `localhost` and GreenMail's ports are published to the host, so it runs directly, full stack or not.

```bash
cp .env.example .env && # fill in OPENROUTER_API_KEY
pnpm reset-demo             # optional — clears memory/ for a clean slate (see Trade-offs)
docker compose up --build   # wait for both mailserver and agent to report healthy

# 1. Seed a prospect
docker compose exec agent pnpm cli outreach --id p-1 --name Sam --email prospect@wakesmith.test

# 2. Reply as the prospect (real SMTP into GreenMail's prospect mailbox)
pnpm simulate-reply --to agent@wakesmith.test --body "Interested! My rate is \$85/hr, does that work?"

# 3. Have the agent poll and react — this is the real OpenRouter tool-calling loop.
# The background poller already runs every 15s inside the container, so this
# step is optional (wait it out for a "the agent did this on its own" beat on
# camera) — or force it immediately for tighter pacing:
docker compose exec agent pnpm cli poll
docker compose exec agent pnpm cli threads      # should show status "scheduled"

# 4. Trigger the reschedule loop
pnpm simulate-reply --to agent@wakesmith.test --body "Something came up — can we push the call?"
docker compose exec agent pnpm cli poll
docker compose exec agent pnpm cli threads      # still "scheduled", but on a new slot; rescheduleCount incremented

# 5. Silent prospect: skip step 2/4 for a second seeded thread, then
docker compose exec agent pnpm cli check-silence --threshold-ms 0
```

`pnpm simulate-reply` (see `scripts/simulateProspectReply.ts`) sends real SMTP mail from GreenMail's `prospect@wakesmith.test` account into the agent's inbox — it's the human side of the round-trip, standing in for an actual prospect's email client.
