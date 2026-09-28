// IndexedDB constants
const DB_NAME = "GLTFParserPluginTilesCache";
const DB_VERSION = 1;
const STORE_NAME = "tiles";

/**
 * IndexedDB Cache Manager Class
 */
export class TileCacheDB {
  private dbPromise: Promise<IDBDatabase> | null = null;

  /**
   * Open/Get database connection
   */
  private openDB(): Promise<IDBDatabase> {
    if (this.dbPromise) {
      return this.dbPromise;
    }

    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        reject(request.error);
      };

      request.onsuccess = () => {
        resolve(request.result);
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "url" });
        }
      };
    });

    return this.dbPromise;
  }

  /**
   * Get data from cache
   * @param url Cache key (processedUrl)
   */
  async get(url: string): Promise<ArrayBuffer | null> {
    try {
      const db = await this.openDB();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, "readonly");
        const store = transaction.objectStore(STORE_NAME);
        const request = store.get(url);

        request.onerror = () => {
          reject(request.error);
        };

        request.onsuccess = () => {
          const result = request.result;
          resolve(result ? result.data : null);
        };
      });
    } catch (error) {
      return null;
    }
  }

  /**
   * Store data to cache
   * @param url Cache key (processedUrl)
   * @param data Data to cache
   */
  async set(url: string, data: ArrayBuffer): Promise<void> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.put({
        url,
        data,
      });

      request.onerror = () => {
        reject(request.error);
      };

      request.onsuccess = () => {
        resolve();
      };
    });
  }

  /**
   * Clear cache
   */
  async clear(): Promise<void> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.clear();

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }
}

// Global cache instance
export const tileCache = new TileCacheDB();
