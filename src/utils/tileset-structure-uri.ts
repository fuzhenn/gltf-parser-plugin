import { gunzipSync } from "fflate";
import type { Tileset } from "3d-tiles-renderer/core";
import type { StructureData } from "../plugin-types";

/** 兼容：少数 tileset 在根级挂 structureUri */
export type TilesetWithStructureUri = Tileset & {
  structureUri?: string;
};

/** 从 tileset 取内嵌 structure 的 data URI（优先 MapTalks：`asset.extras.maptalks.structureUri`） */
export function getStructureDataUriFromTileset(
  root: Tileset | null,
): string | null {
  if (!root) return null;

  const extras = (root.asset as { extras?: Record<string, unknown> } | undefined)
    ?.extras;
  const maptalks = extras?.maptalks;
  if (maptalks && typeof maptalks === "object") {
    const uri = (maptalks as { structureUri?: unknown }).structureUri;
    if (typeof uri === "string" && uri.trim()) {
      return uri.trim();
    }
  }

  const legacy = (root as TilesetWithStructureUri).structureUri;
  if (typeof legacy === "string" && legacy.trim()) {
    return legacy.trim();
  }

  return null;
}

function base64ToUint8Array(b64: string): Uint8Array {
  const clean = b64.replace(/\s/g, "");
  if (typeof globalThis.atob === "function") {
    const bin = globalThis.atob(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      out[i] = bin.charCodeAt(i);
    }
    return out;
  }
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(clean, "base64"));
  }
  throw new Error("[tileset-structure-uri] No base64 decoder available");
}

/**
 * 同步解析 `data:application/x-gzip;base64,...`：base64 → 二进制 → gunzip → UTF-8 文本。
 */
export function decodeGzipBase64DataUriSync(dataUri: string): string {
  const comma = dataUri.indexOf(",");
  if (comma < 0) {
    throw new Error("[tileset-structure-uri] Invalid data URI: missing comma");
  }
  const header = dataUri.slice(0, comma).toLowerCase();
  if (!header.includes("base64")) {
    throw new Error(
      "[tileset-structure-uri] Expected base64 data URI (e.g. data:application/x-gzip;base64,...)",
    );
  }
  const payload = dataUri.slice(comma + 1);
  const compressed = base64ToUint8Array(payload);
  const raw = gunzipSync(compressed);
  return new TextDecoder("utf-8").decode(raw);
}

/**
 * 从已加载的根 tileset 读取内嵌 structure（`asset.extras.maptalks.structureUri`，
 * 若无则回退根级 `structureUri`），同步解码并解析。
 * - 无有效 URI 或解析失败时返回 `null`（不抛错）。
 */
export function parseEmbeddedStructureDataFromTilesSync(
  tiles: { rootTileset: Tileset | null },
): StructureData | null {
  const uri = getStructureDataUriFromTileset(tiles.rootTileset);
  if (!uri) {
    return null;
  }
  try {
    const text = decodeGzipBase64DataUriSync(uri);
    const data = JSON.parse(text) as StructureData;
    return data;
  } catch (e) {
    console.warn("[GLTFParserPlugin] Failed to decode tileset structureUri:", e);
    return null;
  }
}
