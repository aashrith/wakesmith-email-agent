/**
 * Config loading — the other real external boundary besides LLM tool
 * calls (see adapters/outbound/toolSchemas.ts), so it gets the same
 * TypeBox treatment: parse the YAML, validate its shape, fail loudly
 * and specifically if it doesn't match, rather than letting a typo
 * surface three layers down as a cryptic runtime error.
 *
 * Secrets (API keys, mailbox password) are deliberately NOT in
 * config.yaml — they come from the environment so the config file stays
 * safe to commit. See .env.example.
 */

import { readFileSync } from "node:fs";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import yaml from "js-yaml";

const RawConfigSchema = Type.Object({
  gig: Type.Object({
    id: Type.String(),
    title: Type.String(),
    description: Type.String(),
    budgetMin: Type.Number(),
    budgetMax: Type.Number(),
    tone: Type.String(),
  }),
  llm: Type.Object({
    model: Type.String(),
    baseUrl: Type.Optional(Type.String()),
  }),
  email: Type.Object({
    smtpHost: Type.String(),
    smtpPort: Type.Integer(),
    imapHost: Type.String(),
    imapPort: Type.Integer(),
    username: Type.String(),
    fromAddress: Type.String(),
    secure: Type.Optional(Type.Boolean()),
  }),
  calendar: Type.Object({
    availableSlots: Type.Array(Type.String()),
  }),
  memory: Type.Object({
    threadsDir: Type.String(),
    calendarStatePath: Type.String(),
  }),
  polling: Type.Object({
    intervalMs: Type.Integer({ minimum: 1000 }),
  }),
});

type RawConfig = Static<typeof RawConfigSchema>;

export interface AppConfig {
  gig: RawConfig["gig"];
  llm: { model: string; baseUrl?: string; apiKey: string };
  email: RawConfig["email"] & { password: string };
  calendar: { availableSlots: Date[] };
  memory: { threadsDir: string; calendarStatePath: string };
  polling: { intervalMs: number };
}

export class ConfigError extends Error {}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new ConfigError(`Missing required environment variable: ${name}`);
  return value;
}

export function loadConfig(path: string): AppConfig {
  let raw: unknown;
  try {
    raw = yaml.load(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new ConfigError(`Could not read/parse config at ${path}: ${(err as Error).message}`);
  }

  if (!Value.Check(RawConfigSchema, raw)) {
    const issues = [...Value.Errors(RawConfigSchema, raw)].map((e) => `${e.path}: ${e.message}`).join("\n");
    throw new ConfigError(`Invalid config at ${path}:\n${issues}`);
  }
  const config = raw as RawConfig;

  const parsedSlots = config.calendar.availableSlots.map((iso) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) throw new ConfigError(`calendar.availableSlots contains an invalid ISO datetime: '${iso}'`);
    return d;
  });

  return {
    gig: config.gig,
    llm: { model: config.llm.model, baseUrl: config.llm.baseUrl, apiKey: requireEnv("OPENROUTER_API_KEY") },
    email: { ...config.email, password: process.env.EMAIL_PASSWORD ?? "" },
    calendar: { availableSlots: parsedSlots },
    memory: config.memory,
    polling: config.polling,
  };
}
