// IndexedDB constants
const DB_NAME = "GLTFParserPluginTilesCache";
const DB_VERSION = 2;
const STORE_NAME = "tiles";
const SCHEMA_STORE_NAME = "schemas";

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
        if (!db.objectStoreNames.contains(SCHEMA_STORE_NAME)) {
          db.createObjectStore(SCHEMA_STORE_NAME, { keyPath: "url" });
        }
      };
    });

    return this.dbPromise;
  }

  private read(storeName: string, url: string): Promise<any | null> {
    return this.openDB().then(
      (db) =>
        new Promise((resolve, reject) => {
          const transaction = db.transaction(storeName, "readonly");
          const store = transaction.objectStore(storeName);
          const request = store.get(url);

          request.onerror = () => {
            reject(request.error);
          };

          request.onsuccess = () => {
            const result = request.result;
            resolve(result ? result.data : null);
          };
        }),
    );
  }

  private write(storeName: string, url: string, data: any): Promise<void> {
    return this.openDB().then(
      (db) =>
        new Promise((resolve, reject) => {
          const transaction = db.transaction(storeName, "readwrite");
          const store = transaction.objectStore(storeName);
          const request = store.put({ url, data });

          request.onerror = () => {
            reject(request.error);
          };

          request.onsuccess = () => {
            resolve();
          };
        }),
    );
  }

  /**
   * Get data from cache
   * @param url Cache key (processedUrl)
   */
  async get(url: string): Promise<ArrayBuffer | null> {
    try {
      return await this.read(STORE_NAME, url);
    } catch (error) {
      return null;
    }
  }

  /**
   * Get schema JSON from cache
   * @param url Cache key (schema url)
   */
  async getSchema(url: string): Promise<any | null> {
    try {
      return await this.read(SCHEMA_STORE_NAME, url);
    } catch (error) {
      return null;
    }
  }

  /**
   * Store data to cache
   * @param url Cache key (processedUrl)
   * @param data Data to cache
   */
  set(url: string, data: ArrayBuffer): Promise<void> {
    return this.write(STORE_NAME, url, data);
  }

  /**
   * Store schema JSON to cache
   * @param url Cache key (schema url)
   * @param data Schema JSON object
   */
  setSchema(url: string, data: any): Promise<void> {
    return this.write(SCHEMA_STORE_NAME, url, data);
  }

  /**
   * Clear cache (tiles and schemas)
   */
  async clear(): Promise<void> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(
        [STORE_NAME, SCHEMA_STORE_NAME],
        "readwrite",
      );

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);

      for (const storeName of [STORE_NAME, SCHEMA_STORE_NAME]) {
        transaction.objectStore(storeName).clear();
      }
    });
  }
}

// Global cache instance
export const tileCache = new TileCacheDB();
