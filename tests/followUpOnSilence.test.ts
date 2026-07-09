import { describe, expect, it } from "vitest";
import { followUpOnSilence } from "../src/application/useCases/followUpOnSilence.js";
import type { Gig, Prospect } from "../src/domain/models.js";
import { Thread } from "../src/domain/models.js";
import { ThreadStatus } from "../src/domain/stateMachine.js";
import { FakeEmailGateway, FakeMemoryRepository, ScriptedLLMAgent } from "./fakes.js";

const gig: Gig = { id: "gig-1", title: "Backend contract", description: "...", budgetMin: 60, budgetMax: 100, tone: "warm" };
const prospect: Prospect = { id: "p-1", name: "Sam", email: "sam@example.com" };
const THRESHOLD_MS = 3 * 86_400_000;

function ageThread(thread: Thread, msAgo: number): Thread {
  thread.updatedAt = new Date(Date.now() - msAgo);
  return thread;
}

describe("followUpOnSilence", () => {
  it("leaves a thread alone if it hasn't gone quiet long enough", async () => {
    const memory = new FakeMemoryRepository();
    const thread = ageThread(new Thread({ id: "t-1", prospect, gig }), THRESHOLD_MS / 2);
    await memory.save(thread);
    const llm = new ScriptedLLMAgent();
    const email = new FakeEmailGateway();

    const result = await followUpOnSilence({ llm, email, memory, thresholdMs: THRESHOLD_MS, maxNudges: 2 });

    expect(result).toEqual({ nudged: [], closed: [] });
    expect(email.sent).toHaveLength(0);
  });

  it("nudges a thread that has gone quiet past the threshold", async () => {
    const memory = new FakeMemoryRepository();
    const thread = ageThread(new Thread({ id: "t-1", prospect, gig, status: ThreadStatus.NEGOTIATING }), THRESHOLD_MS + 1000);
    await memory.save(thread);
    const llm = new ScriptedLLMAgent();
    const email = new FakeEmailGateway();

    const result = await followUpOnSilence({ llm, email, memory, thresholdMs: THRESHOLD_MS, maxNudges: 2 });

    expect(result.nudged).toEqual(["t-1"]);
    expect(email.sent).toHaveLength(1);
    const saved = await memory.load("t-1");
    expect(saved!.negotiation.nudgeCount).toBe(1);
    expect(saved!.messages).toHaveLength(1);
    expect(saved!.status).toBe(ThreadStatus.NEGOTIATING); // status untouched, only nudgeCount + history change
  });

  it("closes as NO_RESPONSE without sending another email once nudges are exhausted", async () => {
    const memory = new FakeMemoryRepository();
    const thread = new Thread({ id: "t-1", prospect, gig, status: ThreadStatus.NEGOTIATING });
    thread.registerNudgeSent();
    thread.registerNudgeSent();
    ageThread(thread, THRESHOLD_MS + 1000);
    await memory.save(thread);
    const llm = new ScriptedLLMAgent();
    const email = new FakeEmailGateway();

    const result = await followUpOnSilence({ llm, email, memory, thresholdMs: THRESHOLD_MS, maxNudges: 2 });

    expect(result.closed).toEqual(["t-1"]);
    expect(email.sent).toHaveLength(0); // no third email into the void
    const saved = await memory.load("t-1");
    expect(saved!.status).toBe(ThreadStatus.NO_RESPONSE);
  });

  it("ignores threads that are scheduled or already terminal", async () => {
    const memory = new FakeMemoryRepository();
    const scheduled = new Thread({ id: "scheduled", prospect: { ...prospect, email: "a@x.com" }, gig, status: ThreadStatus.SCHEDULED });
    const declined = new Thread({ id: "declined", prospect: { ...prospect, email: "b@x.com" }, gig, status: ThreadStatus.DECLINED });
    ageThread(scheduled, THRESHOLD_MS + 1000);
    ageThread(declined, THRESHOLD_MS + 1000);
    await memory.save(scheduled);
    await memory.save(declined);
    const llm = new ScriptedLLMAgent();
    const email = new FakeEmailGateway();

    const result = await followUpOnSilence({ llm, email, memory, thresholdMs: THRESHOLD_MS, maxNudges: 2 });

    expect(result).toEqual({ nudged: [], closed: [] });
  });

  it("only touches the threads that are actually past the threshold", async () => {
    const memory = new FakeMemoryRepository();
    const quiet = ageThread(
      new Thread({ id: "quiet", prospect: { ...prospect, email: "quiet@x.com" }, gig, status: ThreadStatus.NEGOTIATING }),
      THRESHOLD_MS + 1000,
    );
    const fresh = ageThread(
      new Thread({ id: "fresh", prospect: { ...prospect, email: "fresh@x.com" }, gig, status: ThreadStatus.NEGOTIATING }),
      1000,
    );
    await memory.save(quiet);
    await memory.save(fresh);
    const llm = new ScriptedLLMAgent();
    const email = new FakeEmailGateway();

    const result = await followUpOnSilence({ llm, email, memory, thresholdMs: THRESHOLD_MS, maxNudges: 2 });

    expect(result.nudged).toEqual(["quiet"]);
  });
});
