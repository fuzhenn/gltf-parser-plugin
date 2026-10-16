/**
 * 插件级 featureData 缓存（partId → 属性表整行数据）的工具函数。
 *
 * 缓存实例由 GLTFParserPlugin 持有（`_featureDataCache`），
 * 经调用链以参数形式逐层传递到 features / geometry 层。
 */

export type FeatureData = Record<string, unknown>;
export type FeatureDataCache = Map<number, FeatureData>;

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

  const hit = cache.get(partId);
  if (hit) return hit;

  const data = load();
  cache.set(partId, data);
  return data;
}
