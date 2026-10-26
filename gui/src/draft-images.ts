/**
 * 会话草稿图持久化（2026-10-26 图片功能，用户裁定「发送前应放到草稿中，和队列一样」）：
 * 待发图片按会话键（journalId 稳定身份）落 IndexedDB——切换会话/重启回来不丢。选 IndexedDB 而非
 * localStorage：dataURL 体量（8 张压缩图可达数 MB）会击穿 localStorage 5MB 配额；业界形态同位
 * （ChatGPT/Claude/Cursor 的附件均为会话草稿态、随消息发出即清）。
 * IndexedDB 不可用（隐私模式等）降级进程内 Map——应用存活期内切换会话仍保，重启丢（尽力而为）。
 */

const DB_NAME = 'sunshinex-drafts';
const STORE = 'images';
const DB_VERSION = 1;

/** 降级缓存（IndexedDB 不可用时的进程内兜底；同 API 形态） */
const memory = new Map<string, string[]>();

function openDb(): Promise<IDBDatabase | undefined> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') {
        resolve(undefined);
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(undefined);
      req.onblocked = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

/** 读会话草稿图（缺档/库不可用回空列——空列不写档，零噪音） */
export async function loadDraftImages(key: string): Promise<string[]> {
  const db = await openDb();
  if (db === undefined) return memory.get(key) ?? [];
  return await new Promise<string[]>((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => resolve(Array.isArray(req.result) ? (req.result as string[]) : []);
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

/** 写会话草稿图（覆盖语义；空列删档）。失败静默（降级缓存同步维护，尽力而为） */
export async function saveDraftImages(key: string, images: readonly string[]): Promise<void> {
  if (images.length === 0) memory.delete(key);
  else memory.set(key, [...images]);
  const db = await openDb();
  if (db === undefined) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      if (images.length === 0) store.delete(key);
      else store.put([...images], key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}
