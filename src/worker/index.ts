/// <reference lib="webworker" />

import { GLTFLoader } from "@maptalks/gltf-loader";
import dracoLoader from "@maptalks/transcoders.draco";
import { processGLTFData } from "./process";

// ---- Schema request with two-level caching ----
// L1: Worker-local cache  — avoids postMessage serialization overhead
// L2: Main thread cache   — avoids duplicate fetch across workers

/** L1 cache: Worker-local, keyed by resolved URL */
const localSchemaCache = new Map<string, Promise<any>>();

let schemaRequestId = 0;
const pendingSchemaRequests = new Map<
  number,
  { resolve: (data: any) => void; reject: (err: Error) => void }
>();

/**
 * Listen for schemaResponse messages from main thread.
 * Uses addEventListener so it doesn't conflict with self.onmessage.
 */
self.addEventListener("message", (event: MessageEvent) => {
  const { type, schemaRequestId: id, data, error } = event.data;
  if (type !== "schemaResponse") return;

  const pending = pendingSchemaRequests.get(id);
  if (!pending) return;
  pendingSchemaRequests.delete(id);

  if (error) {
    pending.reject(new Error(error));
  } else {
    pending.resolve(data);
  }
});

/**
 * Request schema with two-level caching:
 * 1. Check Worker-local cache first (zero-cost)
 * 2. If miss, delegate to main thread (which has a global cache shared across all workers)
 * 3. Store the result in local cache for subsequent requests within this worker
 */
function fetchSchema(
  url: string,
  _fetchOptions: RequestInit,
  urlModifier?: (url: string) => string,
): Promise<any> {
  const resolvedUrl = urlModifier ? urlModifier(url) : url;

  // L1: Worker-local cache hit
  const cached = localSchemaCache.get(resolvedUrl);
  if (cached) {
    return cached;
  }

  // L2: Request from main thread
  const id = schemaRequestId++;
  const promise = new Promise<any>((resolve, reject) => {
    pendingSchemaRequests.set(id, { resolve, reject });
    self.postMessage({
      type: "fetchSchema",
      schemaRequestId: id,
      url: resolvedUrl,
    });
  }).catch((err) => {
    // Remove from local cache on failure so it can be retried
    localSchemaCache.delete(resolvedUrl);
    throw err;
  });

  // Store in L1 cache (caching the Promise itself deduplicates concurrent requests within this worker)
  localSchemaCache.set(resolvedUrl, promise);
  return promise;
}

/**
 * Load GLTF data using the loader
 */
function load(root: string, data: any, options: any) {
  const loader = new GLTFLoader(root, data, {
    ...options,
    fetchSchema,
  });
  return loader.load({
    skipAttributeTransform: true,
  });
}

/**
 * Worker message handler
 */
self.onmessage = function (event: MessageEvent) {
  const { method, fetchOptions, loaderId, requestId, buffer, root } =
    event.data;

  if (method === "parseTile") {
    load(
      root || "",
      { buffer: buffer, byteOffset: 0 },
      {
        transferable: true,
        fetchOptions: fetchOptions || {},
        decoders: {
          draco: dracoLoader(),
        },
      },
    )
      .then((data: any) => {
        if (data.message) {
          self.postMessage({
            type: "error",
            loaderId,
            requestId,
            error: data.message,
          });
          return;
        }

        // Complete dequantization and decoding in Worker
        try {
          const { data: processedData, transferables } = processGLTFData(data);
          self.postMessage(
            {
              type: "success",
              loaderId,
              requestId,
              data: processedData,
            },
            transferables,
          );
        } catch (err: any) {
          self.postMessage({
            type: "error",
            loaderId,
            requestId,
            error: err.message || String(err),
          });
        }
      })
      .catch((error: any) => {
        self.postMessage({
          type: "error",
          loaderId,
          requestId,
          error: error.message || String(error),
        });
      });
  }
};

// Signal that worker is ready
self.postMessage({ type: "ready" });
