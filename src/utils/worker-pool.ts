// Import inline Worker (Vite will compile and bundle the worker code into a base64 data URL)
import GLTFWorkerClass from "../worker/index?worker&inline";

// Worker pool management
let workerPool: Worker[] = [];
let maxWorkers = 1;
let currentWorkerIndex = 0;

// ---- Global schema cache (shared across all workers) ----

const schemaCache = new Map<string, Promise<any>>();

let globalFetchOptions: RequestInit = {};

/**
 * 合并并设置全局 fetch 选项（Worker schema 拉取等主线程请求共用）。
 */
export function setFetchOptions(options: RequestInit): void {
  globalFetchOptions = options;
}

/**
 * 合并 fetch 选项：默认值 < tiles.fetchOptions < 插件 fetchOptions。
 */
export function resolveFetchOptions(
  ...sources: (RequestInit | undefined)[]
): RequestInit {
  const merged: RequestInit = {
    mode: "cors",
    referrerPolicy: "origin",
  };
  for (const src of sources) {
    if (src) Object.assign(merged, src);
  }
  if (typeof window !== "undefined" && merged.referrer === undefined) {
    merged.referrer = window.location.href;
  }
  if (merged.mode === undefined) {
    merged.mode = "cors";
  }
  return merged;
}

/**
 * Clear the global schema cache.
 */
export function clearSchemaCache(): void {
  schemaCache.clear();
}

/**
 * Attach a schema request handler to a Worker.
 * When the worker sends a { type: "fetchSchema" } message,
 * the main thread fetches (with deduplication via cache) and replies with the result.
 */
function setupSchemaHandler(worker: Worker): void {
  worker.addEventListener("message", (event: MessageEvent) => {
    const { type, schemaRequestId, url, fetchOptions: reqFetchOptions } =
      event.data;
    if (type !== "fetchSchema") return;

    const requestInit = resolveFetchOptions(globalFetchOptions, reqFetchOptions);

    let promise = schemaCache.get(url);
    if (!promise) {
      promise = fetch(url, requestInit)
        .then((res) => {
          if (!res.ok) {
            throw new Error(
              `Failed to fetch schema: ${res.status} ${res.statusText}`,
            );
          }
          return res.json();
        })
        .catch((err) => {
          // Remove from cache on failure so it can be retried next time
          schemaCache.delete(url);
          throw err;
        });
      schemaCache.set(url, promise);
    }

    promise
      .then((data) => {
        worker.postMessage({ type: "schemaResponse", schemaRequestId, data });
      })
      .catch((err) => {
        worker.postMessage({
          type: "schemaResponse",
          schemaRequestId,
          error: err.message || String(err),
        });
      });
  });
}

/**
 * Set the maximum number of Workers (must be called before initialization)
 */
export function setMaxWorkers(count: number): void {
  maxWorkers = Math.max(1, Math.min(count, navigator.hardwareConcurrency || 4));
}

/**
 * Create a single Worker and wait for it to be ready
 */
function createWorker(): Worker {
  const worker = new GLTFWorkerClass();
  setupSchemaHandler(worker);
  return worker;
}

/**
 * Initialize the Worker pool
 */
function initWorkerPool() {
  if (workerPool.length === 0) {
    // Create all Workers
    for (let i = 0; i < maxWorkers; i++) {
      workerPool.push(createWorker());
    }
  }
}

export function getWorkers(): Worker[] {
  initWorkerPool();
  return workerPool;
}

/**
 * Acquire a Worker (wait if none are available)
 */
export function acquireWorker() {
  initWorkerPool();

  const worker = workerPool[currentWorkerIndex];
  currentWorkerIndex = (currentWorkerIndex + 1) % workerPool.length;
  return worker;
}
