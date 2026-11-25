/**
 * 插件级 featureData 缓存（partId → 属性表整行数据）的工具函数。
 *
 * 缓存实例由 GLTFParserPlugin 持有（`_featureDataCache`），
 * 经调用链以参数形式逐层传递到 features / geometry 层。
 */

export type FeatureData = Record<string, unknown>;

/**
 * partId → 整行数据的高性能缓存：数组直接寻址，无哈希开销。
 * `_oid` / `_pid` 约定为从 1 开始的连续整数，故 `cache[partId]`
 * 即该 partId 的行数据（下标 0 空置，undefined 表示缺失）。
 */
export type FeatureDataCache = (FeatureData | undefined)[];

export function createFeatureDataCache(): FeatureDataCache {
  return [];
}

/** 写入一行数据（正向越界时几何扩容） */
export function setFeatureData(
  cache: FeatureDataCache | undefined,
  partId: number,
  data: FeatureData,
): void {
  if (!cache) return;

  if (partId >= cache.length) {
    let newLength = cache.length || 16;
    while (newLength <= partId) newLength *= 2;
    cache.length = newLength;
  }
  cache[partId] = data;
}

/**
 * partId 优先命中缓存；未命中时用 `load()` 整行解码并回写缓存。
 * `cache` 未传时直接 `load()`。
 */
export function getOrLoadFeatureData(
  cache: FeatureDataCache | undefined,
  partId: number,
  load: () => FeatureData,
): FeatureData {
  if (!cache) return load();

  const hit = cache[partId];
  if (hit) return hit;

  const data = load();
  setFeatureData(cache, partId, data);
  return data;
}
