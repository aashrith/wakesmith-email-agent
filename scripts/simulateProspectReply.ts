/**
 * Stands in for the prospect's email client during the real live demo
 * (see README's "Live demo runbook"). Sends a real SMTP message from
 * GreenMail's prospect@wakesmith.test mailbox into the agent's inbox —
 * a genuine protocol-level email, not a mocked call — so the whole
 * round-trip the brief asks for (real inbound + outbound) can actually
 * be exercised without needing a second human or a real prospect.
 *
 * Deliberately a standalone script, not part of src/: this plays the
 * *other side* of the conversation for demo purposes, it isn't part of
 * the agent itself.
 */

import { parseArgs } from "node:util";
import nodemailer from "nodemailer";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    to: { type: "string", default: "agent@wakesmith.test" },
    from: { type: "string", default: "prospect@wakesmith.test" },
    body: { type: "string" },
    subject: { type: "string", default: "Re: Contract Backend Engineer" },
    host: { type: "string", default: "localhost" },
    port: { type: "string", default: "3025" },
    password: { type: "string", default: process.env.EMAIL_PASSWORD ?? "agent-pass" },
  },
});

if (!values.body) {
  console.error('Usage: simulate-reply --to <agent-address> --body "<reply text>" [--from <prospect-address>]');
  process.exit(1);
}

const transporter = nodemailer.createTransport({
  host: values.host,
  port: Number(values.port),
  secure: false,
  auth: { user: values.from, pass: values.password },
  tls: { rejectUnauthorized: false },
});

const info = await transporter.sendMail({
  from: values.from,
  to: values.to,
  subject: values.subject,
  text: values.body,
});

console.log(`Sent as ${values.from} -> ${values.to}: "${values.body}" (${info.messageId})`);
console.log("Now run: pnpm poll");
