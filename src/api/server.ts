/**
 * Process entrypoint: load config, wire the composition root, start the
 * HTTP server and the background poller side by side (see
 * adapters/inbound/poller.ts for the polling loop itself).
 */

import { buildContainer } from "../bootstrap.js";
import { loadConfig } from "../config.js";
import { startPolling } from "../adapters/inbound/poller.js";
import { buildApp } from "./app.js";

const configPath = process.env.CONFIG_PATH ?? "config/config.yaml";
const config = loadConfig(configPath);
const container = buildContainer(config);

const app = buildApp(container);
const port = Number(process.env.PORT ?? 3000);
app.listen(port);
console.log(`[wakesmith] API listening on :${port}`);

const stopPolling = startPolling(container);
process.on("SIGINT", () => {
  stopPolling();
  process.exit(0);
});
