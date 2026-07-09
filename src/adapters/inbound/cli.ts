/**
 * A second inbound "controller" adapter alongside the HTTP API — mainly
 * for the demo/verification workflow (seeding a prospect, inspecting a
 * thread) without needing curl. Delegates to the exact same use cases as
 * the API layer; no logic duplicated here.
 */

import { parseArgs } from "node:util";
import { buildContainer } from "../../bootstrap.js";
import { loadConfig } from "../../config.js";
import { initiateOutreach } from "../../application/useCases/initiateOutreach.js";
import { followUpOnSilence } from "../../application/useCases/followUpOnSilence.js";
import { runPollCycle } from "./pollCycle.js";

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const config = loadConfig(process.env.CONFIG_PATH ?? "config/config.yaml");
  const container = buildContainer(config);

  switch (command) {
    case "outreach": {
      const { values } = parseArgs({
        args: rest,
        options: {
          id: { type: "string" },
          name: { type: "string" },
          email: { type: "string" },
        },
      });
      if (!values.id || !values.name || !values.email) {
        console.error("Usage: cli outreach --id <id> --name <name> --email <email>");
        process.exit(1);
      }
      const thread = await initiateOutreach({
        gig: container.gig,
        prospect: { id: values.id, name: values.name, email: values.email },
        llm: container.llm,
        email: container.email,
        memory: container.memory,
      });
      console.log(JSON.stringify(thread, null, 2));
      break;
    }
    case "poll": {
      const result = await runPollCycle(container);
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case "check-silence": {
      // --threshold-ms lets a demo skip waiting out the real 3-day
      // default (see config/config.yaml's followUp section).
      const { values } = parseArgs({ args: rest, options: { "threshold-ms": { type: "string" } } });
      const thresholdMs = values["threshold-ms"] ? Number(values["threshold-ms"]) : container.followUpThresholdMs;
      const result = await followUpOnSilence({
        llm: container.llm,
        email: container.email,
        memory: container.memory,
        thresholdMs,
        maxNudges: container.followUpMaxNudges,
      });
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case "threads": {
      const ids = await container.memory.allThreadIds();
      for (const id of ids) {
        const t = await container.memory.load(id);
        console.log(`${id}\t${t?.status}\t${t?.prospect.email}`);
      }
      break;
    }
    case "thread": {
      const id = rest[0];
      if (!id) {
        console.error("Usage: cli thread <id>");
        process.exit(1);
      }
      const t = await container.memory.load(id);
      console.log(JSON.stringify(t, null, 2));
      break;
    }
    default:
      console.error("Usage: cli <outreach|poll|check-silence|threads|thread> [...args]");
      process.exit(1);
  }
}

await main();
