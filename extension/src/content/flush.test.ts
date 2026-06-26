import { describe, it, expect } from "vitest";
import { flushInChunks } from "./flush";
import type { QueuedEvent } from "./queue-router";

function rows(n: number): { key: number; value: QueuedEvent }[] {
  return Array.from({ length: n }, (_, i) => ({ key: i, value: { __k: "impression", v: { i } } }));
}

describe("flushInChunks", () => {
  it("drains a large backlog in chunks and deletes every acked key", async () => {
    const deleted: IDBValidKey[] = [];
    const sends: number[] = [];
    const res = await flushInChunks(
      rows(1200),
      async (m) => { sends.push(m.impressions.length); return true; },
      async (keys) => { deleted.push(...keys); },
      500,
    );
    expect(sends).toEqual([500, 500, 200]); // 3 chunks
    expect(res).toEqual({ sent: 1200, remaining: 0 });
    expect(deleted).toHaveLength(1200);
  });

  it("CRITICAL: stops on a failed send and never deletes un-acked rows", async () => {
    const deleted: IDBValidKey[] = [];
    let call = 0;
    const res = await flushInChunks(
      rows(1200),
      async () => { call++; return call !== 2; }, // 2nd chunk fails
      async (keys) => { deleted.push(...keys); },
      500,
    );
    expect(res).toEqual({ sent: 500, remaining: 700 }); // only the first chunk got through
    expect(deleted).toHaveLength(500);                  // un-acked rows stay in the queue
  });
});
