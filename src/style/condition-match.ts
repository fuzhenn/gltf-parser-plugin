import type { Mesh } from "three";
import {
  buildStyleConditionEvaluatorMap,
  evaluateStyleCondition,
  resolveShowContent,
  type StyleCondition,
  type StyleShowInput,
} from "./appearance";
import {
  getPartIdMapForFeatureAttribute,
  getPropertyDataFromUserData,
} from "../features";
import {
  getCachedMatchedFeatureIds,
  setCachedMatchedFeatureIds,
} from "./split-cache";

/**
 * 按 cacheKey 缓存地遍历 tile mesh 的 partId，用 keep 谓词收集集合。
 * 供条件命中（正取）与 show 隐藏（补集取反）共用。
 */
function collectPartIdsByPredicate(
  tileMesh: Mesh,
  cacheKey: string,
  featureIdAttribute: number,
  keep: (propertyData: Record<string, unknown> | null) => boolean,
): Set<number> {
  const cached = getCachedMatchedFeatureIds(tileMesh, cacheKey);
  if (cached) return cached;

  const idMap = getPartIdMapForFeatureAttribute(tileMesh, featureIdAttribute);
  const result = new Set<number>();
  if (idMap) {
    for (const key in idMap) {
      const partId = Number(key);
      const propertyData = getPropertyDataFromUserData(
        tileMesh.userData,
        partId,
        featureIdAttribute,
      );
      if (propertyData != null && keep(propertyData)) {
        result.add(partId);
      }
    }
  }
  setCachedMatchedFeatureIds(tileMesh, cacheKey, result);
  return result;
}

/**
 * 解析某条件在 tile mesh 上命中的 partId 集合（按 cacheKey 缓存）。
 * featureIdAttribute 由调用方传入（MeshCollector 构造时已解析），避免重复计算。
 */
export function resolveMatchedPartIdsOnTileMesh(
  tileMesh: Mesh,
  condition: StyleCondition,
  cacheKey: string,
  featureIdAttribute: number,
): Set<number> {
  const evaluators = buildStyleConditionEvaluatorMap({
    conditions: [condition],
  });
  return collectPartIdsByPredicate(
    tileMesh,
    cacheKey,
    featureIdAttribute,
    (propertyData) =>
      evaluateStyleCondition(condition[0], propertyData, evaluators),
  );
}

/**
 * 解析该 mesh 上被 show 隐藏的 partId（keep-set 补集语义：不满足 show 表达式即隐藏，
 * 无属性数据的 partId 保持可见）。
 * 结果按 showHiddenKey 缓存（key 携带 show 内容，show 变更自然换 key，无失效问题）。
 */
export function resolveShowHiddenPartIdsOnTileMesh(
  tileMesh: Mesh,
  show: StyleShowInput,
  showHiddenKey: string,
  featureIdAttribute: number,
): Set<number> {
  const evaluators = buildStyleConditionEvaluatorMap({ show });
  const showExpr = resolveShowContent(show)!;
  return collectPartIdsByPredicate(
    tileMesh,
    showHiddenKey,
    featureIdAttribute,
    (propertyData) =>
      !evaluateStyleCondition(showExpr, propertyData, evaluators),
  );
}
