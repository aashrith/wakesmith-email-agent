# Email Wake-Up Agent — System Design

## 1. Goal

An agent that emails a prospect about a gig, carries on the negotiation, and drives toward a booked call — without ever losing context, even across cancellations and reschedules.

## 2. Architecture

Four layers, matching the assignment's own framing (perception → reasoning → action) plus a persistent memory layer everything else reads/writes through.

```
 Trigger/Scheduler
        |
        v
 PERCEPTION                REASONING                    ACTION
 ------------              -------------------          ------------------
 IMAP poller     ----->    Agent loop (OpenRouter,       SMTP sender  -----> Prospect
 Intent classifier         chat-completions + tools)     inbox (Docker mail
 (interested/curious/       Toolbelt:                     container)
  objecting/declining/      - get_thread_state
  rescheduling/other)       - propose_terms(rate)
                            - propose_slots(n)
 Silence check (elapsed     - book_slot / cancel_slot    Calendar (stubbed
 time, not content) ---->   - decline                     slot picker)
 followUpOnSilence
        ^                          |
        |                          v
        +------------------  MEMORY (markdown ledger
   Prospect reply lands       + structured state header)
   in Docker test inbox       per-thread .md file

                    CONFIG (yaml): gig description,
                    budget ceiling, tone, slots
```

Perception, reasoning and action are separate functions/modules — the LLM only ever sees a structured `ThreadState` object built by perception, and only ever emits tool calls; it never touches SMTP/IMAP directly. This keeps the "clean tool-use, clear separation" bonus in reach and makes each layer independently testable.

## 3. State machine (per thread)

```
initiated -> negotiating -> scheduled -> completed
   |              ^              |
   |              |              v
   |              +----- reschedule_requested
   |              |              |
   |              +--------------+
   |              |
   +--------------+-> declined / walked_away / no_response   (terminal)
```

- Every inbound message re-hydrates the thread's full history + current state from its markdown file before the LLM is called — nothing lives only in the LLM's context window.
- `reschedule_requested` re-enters `negotiating` with all prior terms/history intact, so the loop can run N times without the agent "forgetting" it already has a relationship with this prospect or re-negotiating rate from scratch.
- Transitions are enforced in code, not by the LLM — e.g. `book_slot` is only a legal tool call from `negotiating`, so the agent can't double-book or reopen a `declined` thread on its own.
- **`no_response`** is distinct from `declined` (explicit rejection) and `walked_away` (a budget decision): the prospect simply stopped replying. It's reached by `followUpOnSilence`, a use case triggered on elapsed time rather than message content — "silent" isn't something you classify from a reply, it's the absence of one. A quiet `initiated`/`negotiating` thread gets one nudge past a configurable threshold (default 3 days); after `maxNudges` (default 2) unanswered nudges, the thread closes as `no_response` — deliberately without sending a third email into the void.

## 4. Data model (file-based memory)

One markdown file per thread (`memory/threads/<thread_id>.md`) — the source of truth, git-diffable and human-auditable:

- **YAML frontmatter (structured state header)** — the *only* thing that's mutated in place: `status`, `current_rate`, `current_slot`, `prospect`, `gig_id`, `updated_at`. The agent reads this first for "what's true right now."
- **Body (append-only episodic log)** — every inbound/outbound email verbatim, in order, with timestamps and message-ids. Never edited, only appended to. This is "how did we get here" and is what makes the reschedule loop defensible — nothing is ever summarized away.

A thin `calendar_slots.json` (or one SQLite table, if a real query becomes useful) tracks held/free slots across threads — the only piece of state that isn't naturally per-thread.

### Why file-based over vector/graph/decay

Full reasoning in the assumptions section below, short version: the brief's memory problem is small and bounded (one thread per prospect, a few dozen turns max) and demands *completeness* ("never contradict a prior commitment"), not large-corpus *retrieval*. Vector search trades in probabilistic recall — wrong tool when a missed commitment is a correctness bug, not a UX nit. A graph DB and decay/TTL solve for unbounded, evolving, multi-entity corpora and time-based forgetting — none of which exist here, and decay is actively counter to "an agreed rate from two weeks ago is still binding." File-based (Claude Code/Codex CLI's own pattern) plus one mutable state header gives full-fidelity recall for free and eliminates stale-pollution without needing decay, at zero infra cost.

## 5. Config-driven (not hard-coded)

`config.yaml`: gig description, tone, budget ceiling (min/max rate), available calendar slots, polling interval. Swapping gigs or budgets means editing config, not code.

## 6. Assumptions (to confirm with MarseerAI before/while building)

1. **LLM**: OpenRouter, using the OpenAI-compatible chat-completions schema (tools/function-calling included), so the model behind the agent loop is a config value, not a hardcoded provider integration.
2. **Email transport**: a self-hosted Docker mail container (GreenMail — real SMTP + IMAP, unlike Mailpit which lacks IMAP) hosting two mailboxes on the `wakesmith.test` domain: `agent@` (the agent's own inbox) and `prospect@` (stands in for the prospect's, used by `pnpm simulate-reply`). Real protocol send/receive, fully reproducible via `docker compose up` — no external credentials needed to re-run the demo. GreenMail defaults to local-part-only login for `logon:pwd@domain`-style users, so `docker-compose.yml` sets `-Dgreenmail.users.login=email` to accept the full addresses used everywhere else in config.
3. **Calendar**: stubbed slot picker (config-driven available times), not live Google Calendar. The assignment explicitly allows this; keeping it stubbed to stay inside the 3–5 day box, with the interface written so a real Calendar API could drop in later.
4. **Memory store**: per-thread markdown file (YAML state header + append-only episodic body) rather than Postgres/SQLite/Redis/vector DB — see §4 for the full rationale against vector/graph/decay approaches.
5. **Gig + prospect persona**: I'll invent a plausible sample gig/prospect for the demo unless MarseerAI wants a specific persona used.

## 7. Deliverables mapping

- GitHub repo + README (setup, architecture diagram, trade-offs) — this doc becomes the README's design section.
- Loom (3–5 min): live demo walking the reschedule loop specifically.
- Sample transcripts: (a) successful negotiation + booking, (b) cancellation + re-booking, (c) graceful walk-away when no fit, plus (d) a silent prospect nudged twice then closed — not a required transcript, but "silent" is one of the five intents the brief names, so it gets the same real-code proof as the other three.
