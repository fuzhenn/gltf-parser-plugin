/**
 * 插件级 featureData 缓存（partId → 属性表整行数据）的工具函数。
 *
 * 缓存实例由 GLTFParserPlugin 持有（`_featureDataCache`），
 * 经调用链以参数形式逐层传递到 features / geometry 层。
 */

export type FeatureData = Record<string, unknown>;

/**
 * partId → 整行数据的高性能缓存：数组直接寻址，无哈希开销。
 * `data[partId - offset]` 即该 partId 的行数据（undefined 表示缺失）。
 * offset 由首个写入的 partId 确定，之后仅向下平移（rebase）或几何扩容。
 */
export interface FeatureDataCache {
  offset: number;
  data: (FeatureData | undefined)[];
}

export function createFeatureDataCache(): FeatureDataCache {
  return { offset: 0, data: [] };
}

/** 写入一行数据（负向越界时 rebase 平移窗口，正向越界时几何扩容） */
export function setFeatureData(
  cache: FeatureDataCache | undefined,
  partId: number,
  data: FeatureData,
): void {
  if (!cache) return;

  if (cache.data.length === 0) {
    cache.offset = partId;
  } else if (partId < cache.offset) {
    const shift = cache.offset - partId;
    const shifted = new Array<FeatureData | undefined>(
      cache.data.length + shift,
    );
    for (let i = 0; i < cache.data.length; i++) {
      shifted[i + shift] = cache.data[i];
    }
    cache.offset = partId;
    cache.data = shifted;
  }

  const index = partId - cache.offset;
  if (index >= cache.data.length) {
    let newLength = cache.data.length || 16;
    while (newLength <= index) newLength *= 2;
    cache.data.length = newLength;
  }
  cache.data[index] = data;
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

  const index = partId - cache.offset;
  if (index >= 0 && index < cache.data.length) {
    const hit = cache.data[index];
    if (hit) return hit;
  }

  const data = load();
  setFeatureData(cache, partId, data);
  return data;
}
