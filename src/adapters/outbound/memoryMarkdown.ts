/**
 * Persistence adapter: one markdown file per thread. YAML frontmatter is
 * the mutable, authoritative state header (overwritten in place); the
 * body is an append-only, human-readable transcript of every email sent
 * and received. See SYSTEM_DESIGN.md §4 for why this beats a vector/graph
 * store for this problem shape.
 *
 * Scope assumption: one running agent = one gig campaign (matches the
 * brief's framing of "the gig we are offering", singular), so the full
 * Gig config is supplied at construction time rather than duplicated
 * into every thread file — only the gigId is persisted, as an integrity
 * check.
 */

import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";
import type { MemoryRepository } from "../../application/ports.js";
import type { Gig, Message, MessageDirection } from "../../domain/models.js";
import { Thread } from "../../domain/models.js";
import type { ThreadStatus } from "../../domain/stateMachine.js";

interface FrontMatter {
  threadId: string;
  status: ThreadStatus;
  gigId: string;
  prospectId: string;
  prospectName: string;
  prospectEmail: string;
  currentRate: number | null;
  currentSlot: string | null;
  rescheduleCount: number;
  counterRounds: number;
  nudgeCount?: number;
  createdAt: string;
  updatedAt: string;
}

const MESSAGE_HEADER = /^### (in|out) \| (\S+) \| (\S+) \| in-reply-to: (none|\S+)$/;

export class MarkdownMemoryRepository implements MemoryRepository {
  constructor(
    private readonly threadsDir: string,
    private readonly gig: Gig,
  ) {}

  private pathFor(threadId: string): string {
    return join(this.threadsDir, `${threadId}.md`);
  }

  async load(threadId: string): Promise<Thread | null> {
    let content: string;
    try {
      content = await readFile(this.pathFor(threadId), "utf-8");
    } catch {
      return null;
    }
    return this.parse(content);
  }

  async findByProspectEmail(email: string): Promise<Thread | null> {
    for (const id of await this.allThreadIds()) {
      const thread = await this.load(id);
      if (thread && thread.prospect.email === email) return thread;
    }
    return null;
  }

  async save(thread: Thread): Promise<void> {
    await mkdir(this.threadsDir, { recursive: true });
    const content = this.render(thread);
    const finalPath = this.pathFor(thread.id);
    const tmpPath = `${finalPath}.tmp`;
    // Write-then-rename: rename is atomic on the same filesystem, so a
    // crash mid-write never leaves a corrupt/partial thread file behind.
    await writeFile(tmpPath, content, "utf-8");
    await rename(tmpPath, finalPath);
  }

  async allThreadIds(): Promise<string[]> {
    let files: string[];
    try {
      files = await readdir(this.threadsDir);
    } catch {
      return [];
    }
    return files.filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3));
  }

  private render(thread: Thread): string {
    const frontMatter: FrontMatter = {
      threadId: thread.id,
      status: thread.status,
      gigId: thread.gig.id,
      prospectId: thread.prospect.id,
      prospectName: thread.prospect.name,
      prospectEmail: thread.prospect.email,
      currentRate: thread.negotiation.currentRate,
      currentSlot: thread.negotiation.currentSlot?.toISOString() ?? null,
      rescheduleCount: thread.negotiation.rescheduleCount,
      counterRounds: thread.negotiation.counterRounds,
      nudgeCount: thread.negotiation.nudgeCount,
      createdAt: thread.createdAt.toISOString(),
      updatedAt: thread.updatedAt.toISOString(),
    };

    const body = thread.messages
      .map((m) => `### ${m.direction} | ${m.timestamp.toISOString()} | ${m.messageId} | in-reply-to: ${m.inReplyTo ?? "none"}\n${m.body}`)
      .join("\n\n");

    return `---\n${yaml.dump(frontMatter)}---\n\n${body}\n`;
  }

  private parse(content: string): Thread {
    const match = content.match(/^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/);
    if (!match) throw new Error("Malformed thread memory file: missing frontmatter delimiters");
    const [, frontMatterRaw, body] = match;
    const fm = yaml.load(frontMatterRaw!) as FrontMatter;

    if (fm.gigId !== this.gig.id) {
      throw new Error(`Thread ${fm.threadId} belongs to gig '${fm.gigId}', but this agent is configured for '${this.gig.id}'`);
    }

    const messages: Message[] = [];
    const lines = (body ?? "").split("\n");
    let current: { direction: MessageDirection; timestamp: string; messageId: string; inReplyTo: string | null; bodyLines: string[] } | null = null;

    const flush = () => {
      if (current) {
        messages.push({
          direction: current.direction,
          timestamp: new Date(current.timestamp),
          messageId: current.messageId,
          inReplyTo: current.inReplyTo,
          body: current.bodyLines.join("\n").trim(),
        });
      }
    };

    for (const line of lines) {
      const headerMatch = line.match(MESSAGE_HEADER);
      if (headerMatch) {
        flush();
        const [, direction, timestamp, messageId, inReplyTo] = headerMatch;
        current = { direction: direction as MessageDirection, timestamp: timestamp!, messageId: messageId!, inReplyTo: inReplyTo === "none" ? null : inReplyTo!, bodyLines: [] };
      } else if (current) {
        current.bodyLines.push(line);
      }
    }
    flush();

    return new Thread({
      id: fm.threadId,
      prospect: { id: fm.prospectId, name: fm.prospectName, email: fm.prospectEmail },
      gig: this.gig,
      status: fm.status,
      negotiation: {
        currentRate: fm.currentRate,
        currentSlot: fm.currentSlot ? new Date(fm.currentSlot) : null,
        rescheduleCount: fm.rescheduleCount,
        counterRounds: fm.counterRounds,
        nudgeCount: fm.nudgeCount ?? 0, // older thread files predate this field
      },
      messages,
      createdAt: new Date(fm.createdAt),
      updatedAt: new Date(fm.updatedAt),
    });
  }
}
