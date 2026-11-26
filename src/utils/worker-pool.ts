// Import inline Worker (Vite will compile and bundle the worker code into a base64 data URL)
import GLTFWorkerClass from "../worker/index?worker&inline";
import { resolveFetchOptions } from "./fetch-options";
import { tileCache } from "../cache";

// Worker pool management
let workerPool: Worker[] = [];
let maxWorkers = 1;
let currentWorkerIndex = 0;
let schemaCacheEnabled = false;

// ---- Global schema cache (shared across all workers) ----

const schemaCache = new Map<string, Promise<any>>();

/**
 * L2 miss -> IndexedDB -> network
 */
async function loadSchema(url: string, requestInit: RequestInit) {
  if (schemaCacheEnabled) {
    const cached = await tileCache.getSchema(url);
    if (cached) {
      return cached;
    }
  }

  const res = await fetch(url, requestInit);
  if (!res.ok) {
    throw new Error(`Failed to fetch schema: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();

  if (schemaCacheEnabled) {
    tileCache.setSchema(url, data).catch((err: unknown) => {
      console.warn("[GLTFParserPlugin] Failed to cache schema:", err);
    });
  }
  return data;
}

/**
 * Attach a schema request handler to a Worker.
 * When the worker sends a { type: "fetchSchema" } message,
 * the main thread fetches (with deduplication via cache) and replies with the result.
 */
function setupSchemaHandler(worker: Worker): void {
  worker.addEventListener("message", (event: MessageEvent) => {
    const {
      type,
      schemaRequestId,
      url,
      fetchOptions: reqFetchOptions,
    } = event.data;
    if (type !== "fetchSchema") return;

    const requestInit = resolveFetchOptions(reqFetchOptions);

    let promise = schemaCache.get(url);
    if (!promise) {
      promise = loadSchema(url, requestInit).catch((err) => {
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
export function setMaxWorkers(count?: number): void {
  const cap = navigator.hardwareConcurrency || 4;
  maxWorkers = Math.max(1, Math.min(count ?? cap, cap));
}

/**
 * Enable persisting schema JSON to IndexedDB (must be called before initialization)
 */
export function setSchemaCacheEnabled(enabled: boolean): void {
  schemaCacheEnabled = enabled;
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
