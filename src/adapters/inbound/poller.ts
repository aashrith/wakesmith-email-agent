/**
 * Background job: poll the mailbox on an interval and run whatever's new
 * through the same pollCycle the API's manual /poll route uses. A plain
 * setInterval is the right level of infrastructure here — one mailbox,
 * one agent instance, no distributed workers to coordinate, so a job
 * queue would be solving a scale problem this project doesn't have.
 */

import { followUpOnSilence } from "../../application/useCases/followUpOnSilence.js";
import { logger } from "../../lib/logger.js";
import { runPollCycle } from "./pollCycle.js";
import type { Container } from "../../bootstrap.js";

export function startPolling(container: Container): () => void {
  let inFlight = false;

  const tick = async () => {
    if (inFlight) return; // don't overlap polls if one is still running
    inFlight = true;
    try {
      const result = await runPollCycle(container);
      if (result.processed > 0 || result.skipped.length > 0) {
        logger.info("poll cycle complete", { processed: result.processed, skipped: result.skipped });
      }

      // Same cadence as the mail poll — silence detection doesn't need
      // its own interval, it's just a scan over thread.updatedAt.
      const silence = await followUpOnSilence({
        llm: container.llm,
        email: container.email,
        memory: container.memory,
        thresholdMs: container.followUpThresholdMs,
        maxNudges: container.followUpMaxNudges,
      });
      if (silence.nudged.length > 0 || silence.closed.length > 0) {
        logger.info("silence check complete", { nudged: silence.nudged, closed: silence.closed });
      }
    } catch (err) {
      // A poll cycle failing (e.g. mailbox unreachable) must not kill the
      // interval — we log and simply try again next tick.
      logger.error("poll cycle failed", { error: String(err) });
    } finally {
      inFlight = false;
    }
  };

  const handle = setInterval(tick, container.pollingIntervalMs);
  void tick(); // run once immediately rather than waiting a full interval
  return () => clearInterval(handle);
}

// Allows `pnpm run poll` (tsx, .ts) or the built `dist/poller.js` (vite
// build, .js) to run the poller standalone, without the API.
if (process.argv[1] && /poller\.(ts|js)$/.test(process.argv[1])) {
  const { loadConfig } = await import("../../config.js");
  const { buildContainer } = await import("../../bootstrap.js");
  const config = loadConfig(process.env.CONFIG_PATH ?? "config/config.yaml");
  const container = buildContainer(config);
  logger.info("poller starting", { intervalMs: container.pollingIntervalMs });
  startPolling(container);
}
