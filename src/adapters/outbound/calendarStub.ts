/**
 * Stubbed calendar adapter — explicitly not a real Google Calendar
 * integration, just a config-driven slot picker good enough to exercise
 * the reschedule loop end to end. Available slots come from config;
 * which ones are held is the one piece of state that spans threads, so
 * it lives in a small JSON file rather than a per-thread markdown file
 * (see SYSTEM_DESIGN.md §4).
 *
 * Known limitation: holds are keyed by threadId with no expiry, so a
 * thread whose own record is deleted/lost without going through
 * cancelSlot() leaves an orphaned hold on its slot forever. Out of scope
 * to fix properly (would need a TTL or a reconciliation pass against
 * memory/threads/) for a stubbed adapter, but worth knowing about before
 * a demo — clear memory/calendar_slots.json to reset.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { SlotUnavailableError } from "../../domain/errors.js";
import type { CalendarGateway } from "../../application/ports.js";

export class StubCalendarGateway implements CalendarGateway {
  private readonly available: Date[];
  private held: Record<string, string> = {};
  private loaded = false;

  constructor(
    availableSlots: Date[],
    private readonly statePath: string,
  ) {
    this.available = [...availableSlots].sort((a, b) => a.getTime() - b.getTime());
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.statePath, "utf-8");
      this.held = JSON.parse(raw);
    } catch {
      this.held = {};
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    await writeFile(this.statePath, JSON.stringify(this.held, null, 2));
  }

  async listAvailableSlots(n = 3): Promise<Date[]> {
    await this.ensureLoaded();
    const heldIsos = new Set(Object.values(this.held));
    return this.available.filter((s) => !heldIsos.has(s.toISOString())).slice(0, n);
  }

  async hold(slotTime: Date, threadId: string): Promise<void> {
    await this.ensureLoaded();
    const iso = slotTime.toISOString();
    const heldBy = Object.entries(this.held).find(([id, slot]) => slot === iso && id !== threadId);
    if (heldBy) throw new SlotUnavailableError(iso);
    this.held[threadId] = iso;
    await this.persist();
  }

  async release(threadId: string): Promise<void> {
    await this.ensureLoaded();
    delete this.held[threadId];
    await this.persist();
  }
}
