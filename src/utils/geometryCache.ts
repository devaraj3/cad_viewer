import type { CadAssemblyCachePayload } from "../components/cad/mesh-loader";

const DB_NAME = "cad-viewer-cache";
const STORE_NAME = "geometries";
const DB_VERSION = 1;
const MAX_ENTRIES = 20;
const CAD_ASSEMBLY_KIND = "cad_assembly";

type GeometryCacheRecord = {
  key: string;
  kind: typeof CAD_ASSEMBLY_KIND;
  data: CadAssemblyCachePayload;
  timestamp: number;
};

function hasIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!hasIndexedDb()) {
      reject(new Error("IndexedDB is unavailable in this environment."));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "key" });
        store.createIndex("timestamp", "timestamp");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function waitForTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted."));
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed."));
  });
}

function readRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function pruneOldEntries(db: IDBDatabase): Promise<void> {
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);
  const count = await readRequest(store.count());
  const overflow = count - MAX_ENTRIES;
  if (overflow <= 0) {
    await waitForTransaction(tx);
    return;
  }

  const index = store.index("timestamp");
  const cursorRequest = index.openCursor(null, "next");
  let remainingToDelete = overflow;

  await new Promise<void>((resolve, reject) => {
    cursorRequest.onerror = () => reject(cursorRequest.error);
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor || remainingToDelete <= 0) {
        resolve();
        return;
      }
      store.delete(cursor.primaryKey);
      remainingToDelete -= 1;
      cursor.continue();
    };
  });

  await waitForTransaction(tx);
}

export function buildCadGeometryCacheKey(
  fileName: string,
  fileSize: number,
  lastModified: number,
): string {
  return `${fileName}::${fileSize}::${lastModified}`;
}

export async function getCachedCadAssembly(
  key: string,
): Promise<CadAssemblyCachePayload | null> {
  if (!hasIndexedDb()) return null;

  try {
    const db = await openDB();
    try {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const result = (await readRequest(store.get(key))) as
        | GeometryCacheRecord
        | undefined;
      await waitForTransaction(tx);
      if (!result || result.kind !== CAD_ASSEMBLY_KIND) return null;
      if (!result.data || result.data.version !== 1) return null;
      return result.data;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export async function setCachedCadAssembly(
  key: string,
  payload: CadAssemblyCachePayload,
): Promise<void> {
  if (!hasIndexedDb()) return;

  try {
    const db = await openDB();
    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put({
        key,
        kind: CAD_ASSEMBLY_KIND,
        data: payload,
        timestamp: Date.now(),
      } as GeometryCacheRecord);
      await waitForTransaction(tx);
      await pruneOldEntries(db);
    } finally {
      db.close();
    }
  } catch {
    // Non-fatal cache write errors.
  }
}

export async function clearGeometryCache(): Promise<void> {
  if (!hasIndexedDb()) return;

  try {
    const db = await openDB();
    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).clear();
      await waitForTransaction(tx);
    } finally {
      db.close();
    }
  } catch {
    // Non-fatal cache clear errors.
  }
}
