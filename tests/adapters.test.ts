import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StubCalendarGateway } from "../src/adapters/outbound/calendarStub.js";
import { parseToolArgs, ToolArgumentError } from "../src/adapters/outbound/toolSchemas.js";

describe("StubCalendarGateway", () => {
  let dir: string;
  let statePath: string;
  let slots: Date[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wakesmith-cal-"));
    statePath = join(dir, "calendar_slots.json");
    slots = [0, 1, 2, 3].map((d) => new Date(Date.now() + d * 86400_000));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns available slots up to n", async () => {
    const cal = new StubCalendarGateway(slots, statePath);
    const available = await cal.listAvailableSlots(2);
    expect(available).toHaveLength(2);
  });

  it("excludes held slots and persists holds across instances (survives a restart)", async () => {
    const cal1 = new StubCalendarGateway(slots, statePath);
    const [first] = await cal1.listAvailableSlots(1);
    await cal1.hold(first!, "thread-1");

    const cal2 = new StubCalendarGateway(slots, statePath); // simulates process restart
    const available = await cal2.listAvailableSlots(4);
    expect(available.some((s) => s.getTime() === first!.getTime())).toBe(false);
  });

  it("release frees a held slot back up", async () => {
    const cal = new StubCalendarGateway(slots, statePath);
    const [first] = await cal.listAvailableSlots(1);
    await cal.hold(first!, "thread-1");
    await cal.release("thread-1");
    const available = await cal.listAvailableSlots(4);
    expect(available.some((s) => s.getTime() === first!.getTime())).toBe(true);
  });
});

describe("parseToolArgs", () => {
  it("accepts valid propose_terms arguments", () => {
    expect(parseToolArgs("propose_terms", '{"rate": 85}')).toEqual({ rate: 85 });
  });

  it("rejects missing required fields", () => {
    expect(() => parseToolArgs("propose_terms", "{}")).toThrow(ToolArgumentError);
  });

  it("rejects malformed JSON", () => {
    expect(() => parseToolArgs("book_slot", "{not json")).toThrow(ToolArgumentError);
  });

  it("treats empty string as {} for no-arg tools", () => {
    expect(parseToolArgs("decline", "")).toEqual({});
  });
});
