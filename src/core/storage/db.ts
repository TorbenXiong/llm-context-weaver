/**
 * IndexedDB 极简封装。扩展的 SW 与工作台页面同属扩展 origin，共享同一数据库；
 * Content Script 运行在页面 origin，严禁直接使用本模块（通过消息与 SW 通信）。
 */
const DB_NAME = 'lcw';
const DB_VERSION = 2;

export type StoreName = 'kv' | 'jobs' | 'chunks' | 'chunkTexts' | 'results';

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (event) => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('jobs')) db.createObjectStore('jobs', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('chunks')) {
          const s = db.createObjectStore('chunks', { keyPath: 'id' });
          s.createIndex('byJob', 'jobId', { unique: false });
        }
        if (!db.objectStoreNames.contains('chunkTexts')) db.createObjectStore('chunkTexts', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('results')) {
          const s = db.createObjectStore('results', { keyPath: 'id' });
          s.createIndex('byJob', 'jobId', { unique: false });
        }
        if (event.oldVersion > 0 && event.oldVersion < 2 && db.objectStoreNames.contains('jobs')) {
          const jobs = req.transaction!.objectStore('jobs');
          const cursorRequest = jobs.openCursor();
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) return;
            const legacy = cursor.value as Record<string, unknown> & {
              tabId?: number | null;
              current?: (Record<string, unknown> & { url?: string | null; phase?: string }) | null;
            };
            const { tabId, ...job } = legacy;
            let current = job.current;
            if (current) {
              const { url, ...unit } = current;
              current = {
                ...unit,
                // 旧数据无法证明 send 是否完成；按 submitting 迁移并在恢复时 fail closed。
                phase: typeof unit.phase === 'string' ? unit.phase : 'submitting',
                remoteRef: url ?? null,
              };
            }
            cursor.update({
              ...job,
              providerId: typeof job.providerId === 'string' ? job.providerId : 'legacy',
              providerConnectionId: typeof tabId === 'number' ? String(tabId) : null,
              current,
            });
            cursor.continue();
          };
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function run<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        let value: T;
        req.onsuccess = () => { value = req.result; };
        req.onerror = () => reject(req.error);
        t.oncomplete = () => resolve(value);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

export const idb = {
  get: <T>(store: StoreName, key: string): Promise<T | undefined> =>
    run(store, 'readonly', (s) => s.get(key)) as Promise<T | undefined>,
  put: (store: StoreName, value: unknown): Promise<IDBValidKey> => run(store, 'readwrite', (s) => s.put(value)),
  del: (store: StoreName, key: string): Promise<undefined> => run(store, 'readwrite', (s) => s.delete(key)),
  getAll: <T>(store: StoreName): Promise<T[]> => run(store, 'readonly', (s) => s.getAll()) as Promise<T[]>,
  byIndex: <T>(store: StoreName, index: string, value: string): Promise<T[]> =>
    run(store, 'readonly', (s) => s.index(index).getAll(value)) as Promise<T[]>,
};

export const kv = {
  get: <T>(key: string): Promise<T | undefined> => run('kv', 'readonly', (s) => s.get(key)) as Promise<T | undefined>,
  set: (key: string, value: unknown): Promise<IDBValidKey> => run('kv', 'readwrite', (s) => s.put(value, key)),
  del: (key: string): Promise<undefined> => run('kv', 'readwrite', (s) => s.delete(key)),
};
