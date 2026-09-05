/**
 * Fan-out of daemon activity to live subscribers: the island, mainly.
 *
 * The one rule: a subscriber must never slow the daemon down. Publishing is
 * non-blocking, and a subscriber that stops reading loses frames rather than
 * applying back-pressure to a hook on the agent's critical path.
 */

import type { ServerResponse } from "node:http";

export const QUEUE_DEPTH = 64;

export type Frame = { type: string; seq: number; [k: string]: unknown };

interface Subscriber {
  res: ServerResponse;
  queue: Frame[];
  writing: boolean;
}

export class Hub {
  private subs = new Set<Subscriber>();
  private seq = 0;
  private listeners = new Set<(f: Frame) => void>();

  get count(): number {
    return this.subs.size;
  }

  /** In-process listener (the app's windows), no HTTP. */
  listen(fn: (f: Frame) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  subscribe(res: ServerResponse, hello: Record<string, unknown>): () => void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const sub: Subscriber = { res, queue: [], writing: false };
    this.subs.add(sub);
    res.write(encode({ ...hello, type: "hello", seq: ++this.seq }));
    const ping = setInterval(() => {
      if (!res.writableEnded) res.write(": ping\n\n");
    }, 15000);
    const off = () => {
      clearInterval(ping);
      this.subs.delete(sub);
    };
    res.on("close", off);
    res.on("error", off);
    return off;
  }

  publish(type: string, fields: Record<string, unknown> = {}): Frame {
    const frame: Frame = { ...fields, type, seq: ++this.seq };
    for (const fn of this.listeners) {
      try {
        fn(frame);
      } catch {
        /* a broken listener must not stop the rest */
      }
    }
    for (const sub of this.subs) {
      if (sub.res.writableEnded || sub.res.destroyed) {
        this.subs.delete(sub);
        continue;
      }
      sub.queue.push(frame);
      // Drop the oldest so the newest state still gets through: for a status
      // display the latest frame is the only one that matters.
      if (sub.queue.length > QUEUE_DEPTH) sub.queue.shift();
      this.pump(sub);
    }
    return frame;
  }

  private pump(sub: Subscriber): void {
    if (sub.writing) return;
    sub.writing = true;
    while (sub.queue.length && !sub.res.writableEnded) {
      const frame = sub.queue.shift()!;
      const ok = sub.res.write(encode(frame));
      if (!ok) {
        // Back-pressure from the socket: wait for drain, keep queuing meanwhile.
        sub.res.once("drain", () => {
          sub.writing = false;
          this.pump(sub);
        });
        return;
      }
    }
    sub.writing = false;
  }
}

export function encode(frame: Frame): string {
  return `data: ${JSON.stringify(frame)}\n\n`;
}
