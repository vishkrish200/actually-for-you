// Durable IndexedDB event queue. SW drains it; events survive SW being killed.

const DB_NAME = "afy-queue";
const STORE = "events";

let db: IDBDatabase | null = null;

export function openQueue(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { autoIncrement: true });
    req.onsuccess = () => { db = req.result; resolve(); };
    req.onerror = () => reject(req.error);
  });
}

export function enqueue(event: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!db) { reject(new Error("DB not open")); return; }
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).add(event);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export function drainQueue(): Promise<{ key: IDBValidKey; value: unknown }[]> {
  return new Promise((resolve, reject) => {
    if (!db) { reject(new Error("DB not open")); return; }
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).openCursor();
    const rows: { key: IDBValidKey; value: unknown }[] = [];
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) { rows.push({ key: cursor.key, value: cursor.value }); cursor.continue(); }
      else resolve(rows);
    };
    req.onerror = () => reject(req.error);
  });
}

export function deleteKeys(keys: IDBValidKey[]): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!db || !keys.length) { resolve(); return; }
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    keys.forEach(k => store.delete(k));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
