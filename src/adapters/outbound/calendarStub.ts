/**
 * Stubbed calendar adapter — explicitly not a real Google Calendar
 * integration (see SYSTEM_DESIGN.md §6, assumption 3). Available slots
 * come from config; which ones are held is the one piece of state that
 * spans threads, so it lives in a small JSON file rather than a
 * per-thread markdown file (see SYSTEM_DESIGN.md §4).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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
    this.held[threadId] = slotTime.toISOString();
    await this.persist();
  }

  async release(threadId: string): Promise<void> {
    await this.ensureLoaded();
    delete this.held[threadId];
    await this.persist();
  }
}
