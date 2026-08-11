import { Loader } from "three";

function normalizeHeaders(headers?: HeadersInit): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const out: Record<string, string> = {};
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return { ...headers };
}

/**
 * 将 RequestInit 映射到 Three.js Loader 的 requestHeader / credentials / crossOrigin。
 */
export function applyFetchOptionsToLoader(
  loader: Loader,
  fetchOptions?: RequestInit,
): void {
  if (!fetchOptions) return;

  const headers = normalizeHeaders(fetchOptions.headers);
  if (Object.keys(headers).length > 0) {
    loader.setRequestHeader(headers);
  }

  if (fetchOptions.credentials === "include") {
    loader.setWithCredentials(true);
    loader.setCrossOrigin("use-credentials");
  } else if (fetchOptions.credentials === "omit") {
    loader.setWithCredentials(false);
  }

  if (fetchOptions.mode === "cors") {
    loader.setCrossOrigin(
      fetchOptions.credentials === "include" ? "use-credentials" : "anonymous",
    );
  } else if (fetchOptions.mode === "same-origin") {
    loader.setCrossOrigin("same-origin");
  }
}
