// Drain the durable queue to the server in BOUNDED chunks, deleting each chunk's keys only after
// the server confirms it. The previous flush sent the whole queue in one all-or-nothing batch —
// once the backlog grew large enough the single POST failed, and because nothing was deleted the
// next attempt was even bigger: a death spiral that stranded ~24h of capture in IndexedDB. Chunking
// guarantees forward progress (each acked chunk is removed) and caps any single POST's size.

import { partition, type QueuedEvent } from "./queue-router";

type Row = { key: IDBValidKey; value: QueuedEvent };
type Send = (msg: { kind: "flush"; impressions: unknown[]; tweets: unknown[]; health: unknown[] }) => Promise<boolean>;

export async function flushInChunks(
  rows: Row[],
  send: Send,
  deleteKeys: (keys: IDBValidKey[]) => Promise<void>,
  chunkSize = 500,
): Promise<{ sent: number; remaining: number }> {
  let sent = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const slice = rows.slice(i, i + chunkSize);
    const { impressions, tweets, health } = partition(slice.map(r => r.value));
    const ok = await send({ kind: "flush", impressions, tweets, health });
    if (!ok) break; // SW/server down — keep this and the remaining rows for the next flush
    await deleteKeys(slice.map(r => r.key));
    sent += slice.length;
  }
  return { sent, remaining: rows.length - sent };
}
