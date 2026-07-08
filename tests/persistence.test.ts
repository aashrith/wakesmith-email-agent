import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MarkdownMemoryRepository } from "../src/adapters/outbound/memoryMarkdown.js";
import type { Gig } from "../src/domain/models.js";
import { Thread } from "../src/domain/models.js";
import { ThreadStatus } from "../src/domain/stateMachine.js";

const gig: Gig = { id: "gig-1", title: "Backend contract", description: "...", budgetMin: 60, budgetMax: 100, tone: "warm" };

function makeThread(): Thread {
  const t = new Thread({ id: "t-1", prospect: { id: "p-1", name: "Sam", email: "sam@example.com" }, gig });
  t.transitionTo(ThreadStatus.NEGOTIATING);
  t.recordMessage({ direction: "in", body: "Interested — what's the rate?", timestamp: new Date("2026-07-08T10:00:00Z"), messageId: "<in-1@x>", inReplyTo: null });
  t.agreeRate(85);
  t.recordMessage({ direction: "out", body: "How about $85/hr?\n\nLet me know!", timestamp: new Date("2026-07-08T10:05:00Z"), messageId: "<out-1@x>", inReplyTo: "<in-1@x>" });
  t.lockSlot(new Date("2026-07-10T15:00:00Z"));
  return t;
}

describe("MarkdownMemoryRepository", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wakesmith-mem-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a thread through save/load with full fidelity", async () => {
    const repo = new MarkdownMemoryRepository(dir, gig);
    const original = makeThread();
    await repo.save(original);

    const loaded = await repo.load(original.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.status).toBe(ThreadStatus.SCHEDULED);
    expect(loaded!.negotiation.currentRate).toBe(85);
    expect(loaded!.negotiation.currentSlot?.toISOString()).toBe(new Date("2026-07-10T15:00:00Z").toISOString());
    expect(loaded!.messages).toHaveLength(2);
    expect(loaded!.messages[1]!.body).toBe("How about $85/hr?\n\nLet me know!"); // multi-line body preserved
    expect(loaded!.prospect.email).toBe("sam@example.com");
  });

  it("finds a thread by prospect email across multiple files", async () => {
    const repo = new MarkdownMemoryRepository(dir, gig);
    await repo.save(makeThread());
    const other = new Thread({ id: "t-2", prospect: { id: "p-2", name: "Alex", email: "alex@example.com" }, gig });
    await repo.save(other);

    const found = await repo.findByProspectEmail("alex@example.com");
    expect(found?.id).toBe("t-2");
  });

  it("writes are atomic: no .tmp file left behind after save", async () => {
    const repo = new MarkdownMemoryRepository(dir, gig);
    await repo.save(makeThread());
    await expect(readFile(join(dir, "t-1.md.tmp"))).rejects.toThrow();
    await expect(readFile(join(dir, "t-1.md"), "utf-8")).resolves.toContain("threadId: t-1");
  });

  it("returns null for a thread that doesn't exist", async () => {
    const repo = new MarkdownMemoryRepository(dir, gig);
    expect(await repo.load("does-not-exist")).toBeNull();
  });

  it("rejects a thread file belonging to a different gig", async () => {
    const repo = new MarkdownMemoryRepository(dir, gig);
    await repo.save(makeThread());
    const otherGig: Gig = { ...gig, id: "different-gig" };
    const wrongRepo = new MarkdownMemoryRepository(dir, otherGig);
    await expect(wrongRepo.load("t-1")).rejects.toThrow(/belongs to gig/);
  });
});
