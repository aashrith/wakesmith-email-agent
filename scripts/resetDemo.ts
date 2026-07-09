/**
 * Wipes local runtime state (memory/threads/*.md and
 * memory/calendar_slots.json) so a demo or test run starts from a clean
 * slate. Nothing here is source-controlled (see .gitignore) — this is
 * purely local convenience, not a data-loss risk to the repo.
 *
 * Why this exists: StubCalendarGateway's holds are keyed by threadId with
 * no expiry (see adapters/outbound/calendarStub.ts's docblock). Across
 * enough manual test runs, an old thread's hold can outlive the thread
 * itself and squat on a slot forever, which then surfaces as a confusing
 * "that time isn't available" reply in a later, unrelated thread. Running
 * this before a demo/recording avoids hitting stale state left over from
 * earlier testing.
 */

import { access, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

const memoryDir = new URL("../memory/", import.meta.url).pathname;
const threadsDir = join(memoryDir, "threads");
const calendarPath = join(memoryDir, "calendar_slots.json");

const threadFiles = await readdir(threadsDir).catch(() => [] as string[]);
const removed: string[] = [];

for (const file of threadFiles) {
  if (!file.endsWith(".md")) continue; // keep .gitkeep
  await rm(join(threadsDir, file));
  removed.push(`memory/threads/${file}`);
}

const calendarExisted = await access(calendarPath)
  .then(() => true)
  .catch(() => false);
if (calendarExisted) {
  await rm(calendarPath, { force: true });
  removed.push("memory/calendar_slots.json");
}

if (removed.length === 0) {
  console.log("Nothing to reset — memory/ is already clean.");
} else {
  console.log(`Reset complete, removed:\n${removed.map((f) => `  - ${f}`).join("\n")}`);
}
