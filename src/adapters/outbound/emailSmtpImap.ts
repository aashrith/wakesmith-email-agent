/**
 * Real SMTP/IMAP adapter — nodemailer for sending, imapflow + mailparser
 * for reading. Points at a Docker-hosted GreenMail/smtp4dev mailbox for
 * the demo but works unmodified against any real IMAP/SMTP mailbox,
 * since it speaks the actual protocols rather than a provider-specific
 * API.
 */

import { randomUUID } from "node:crypto";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import type { EmailGateway, SendEmailArgs } from "../../application/ports.js";
import type { InboundEmail, SentEmail } from "../../application/dto.js";
import { describeError, logger } from "../../lib/logger.js";
import { isTransientNetworkError, withRetry } from "../../lib/retry.js";

export interface EmailConfig {
  smtpHost: string;
  smtpPort: number;
  imapHost: string;
  imapPort: number;
  username: string;
  password: string;
  fromAddress: string;
  secure?: boolean;
}

export class SmtpImapEmailGateway implements EmailGateway {
  private readonly transporter: nodemailer.Transporter;

  constructor(private readonly config: EmailConfig) {
    this.transporter = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.secure ?? false,
      auth: config.username ? { user: config.username, pass: config.password } : undefined,
      // Docker test mail servers (GreenMail/smtp4dev) commonly use
      // self-signed certs; real deployments should not set this.
      tls: { rejectUnauthorized: false },
    });
  }

  async send({ toAddress, subject, body, inReplyTo }: SendEmailArgs): Promise<SentEmail> {
    const messageId = `<${randomUUID()}@wakesmith>`;
    await withRetry(
      () =>
        this.transporter.sendMail({
          from: this.config.fromAddress,
          to: toAddress,
          subject,
          text: body,
          messageId,
          inReplyTo: inReplyTo ?? undefined,
          references: inReplyTo ?? undefined,
        }),
      {
        retries: 2,
        isRetryable: (err) => {
          const retryable = isTransientNetworkError(err);
          if (retryable) logger.warn("smtp send failed, retrying", { to: toAddress, ...describeError(err) });
          return retryable;
        },
      },
    );
    return { messageId, sentAt: new Date() };
  }

  async fetchNew(): Promise<InboundEmail[]> {
    const client = new ImapFlow({
      host: this.config.imapHost,
      port: this.config.imapPort,
      secure: this.config.secure ?? false,
      auth: { user: this.config.username, pass: this.config.password },
      logger: false,
      tls: { rejectUnauthorized: false },
    });

    const results: InboundEmail[] = [];
    await withRetry(() => client.connect(), {
      retries: 2,
      isRetryable: (err) => {
        const retryable = isTransientNetworkError(err);
        if (retryable) logger.warn("imap connect failed, retrying", describeError(err));
        return retryable;
      },
    });
    try {
      const lock = await client.getMailboxLock("INBOX");
      try {
        // Search for unseen mail, then mark it seen as we go — that flag
        // flip is our idempotency guard against re-processing the same
        // message on the next poll (see application/ports.ts).
        const uids = await client.search({ seen: false }, { uid: true });
        for (const uid of uids || []) {
          const msg = await client.fetchOne(uid, { source: true }, { uid: true });
          if (!msg || !msg.source) continue;
          const parsed = await simpleParser(msg.source);
          results.push({
            fromAddress: parsed.from?.value[0]?.address ?? "",
            subject: parsed.subject ?? "",
            body: (parsed.text ?? "").trim(),
            messageId: parsed.messageId ?? `<${randomUUID()}@unknown>`,
            inReplyTo: parsed.inReplyTo ?? null,
            receivedAt: parsed.date ?? new Date(),
          });
          await client.messageFlagsAdd({ uid: String(uid) }, ["\\Seen"], { uid: true });
        }
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
    return results;
  }
}
