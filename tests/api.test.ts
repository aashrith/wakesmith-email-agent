import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/api/app.js";
import type { Container } from "../src/bootstrap.js";
import type { Gig } from "../src/domain/models.js";
import { FakeCalendarGateway, FakeEmailGateway, FakeMemoryRepository, ScriptedLLMAgent } from "./fakes.js";

const gig: Gig = { id: "gig-1", title: "Backend contract", description: "...", budgetMin: 60, budgetMax: 100, tone: "warm" };

function makeContainer(): Container {
  return {
    gig,
    llm: new ScriptedLLMAgent(),
    email: new FakeEmailGateway(),
    calendar: new FakeCalendarGateway(),
    memory: new FakeMemoryRepository(),
    pollingIntervalMs: 60_000,
    followUpThresholdMs: 3 * 86_400_000,
    followUpMaxNudges: 2,
  };
}

describe("API", () => {
  let container: Container;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    container = makeContainer();
    app = buildApp(container);
  });

  it("GET /health", async () => {
    const res = await app.handle(new Request("http://localhost/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("POST /outreach creates a thread and GET /threads lists it", async () => {
    const res = await app.handle(
      new Request("http://localhost/outreach", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prospectId: "p-1", prospectName: "Sam", prospectEmail: "sam@example.com" }),
      }),
    );
    expect(res.status).toBe(200);
    const created = (await res.json()) as { status: string };
    expect(created.status).toBe("initiated");

    const listRes = await app.handle(new Request("http://localhost/threads"));
    const list = (await listRes.json()) as Array<{ prospectEmail: string }>;
    expect(list).toHaveLength(1);
    expect(list[0]!.prospectEmail).toBe("sam@example.com");
  });

  it("POST /outreach rejects an invalid email via the TypeBox schema", async () => {
    const res = await app.handle(
      new Request("http://localhost/outreach", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prospectId: "p-1", prospectName: "Sam", prospectEmail: "not-an-email" }),
      }),
    );
    expect(res.status).toBe(422);
  });

  it("GET /threads/:id returns 404 for an unknown thread", async () => {
    const res = await app.handle(new Request("http://localhost/threads/does-not-exist"));
    expect(res.status).toBe(404);
  });

  it("returns a generic 500 (no stack trace) when a dependency throws unexpectedly", async () => {
    container.memory.load = async () => {
      throw new Error("disk on fire");
    };
    app = buildApp(container);

    const res = await app.handle(new Request("http://localhost/threads/whatever"));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; incidentId: string };
    expect(body.error).toBe("internal_error");
    expect(body.incidentId).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain("disk on fire"); // internals never leak to the caller
  });

  it("GET /threads/:id returns full message history for a known thread", async () => {
    await app.handle(
      new Request("http://localhost/outreach", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prospectId: "p-1", prospectName: "Sam", prospectEmail: "sam@example.com" }),
      }),
    );
    const listRes = await app.handle(new Request("http://localhost/threads"));
    const threads = (await listRes.json()) as Array<{ id: string }>;
    const id = threads[0]!.id;

    const res = await app.handle(new Request(`http://localhost/threads/${id}`));
    const detail = (await res.json()) as { messages: Array<{ direction: string }> };
    expect(detail.messages).toHaveLength(1);
    expect(detail.messages[0]!.direction).toBe("out");
  });

  it("POST /check-silence accepts a threshold override for demo purposes", async () => {
    await app.handle(
      new Request("http://localhost/outreach", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prospectId: "p-1", prospectName: "Sam", prospectEmail: "sam@example.com" }),
      }),
    );

    const res = await app.handle(
      new Request("http://localhost/check-silence", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ thresholdMs: 0 }), // force it to look "quiet" immediately
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nudged: string[]; closed: string[] };
    expect(body.nudged.length + body.closed.length).toBeGreaterThan(0);
  });
});
