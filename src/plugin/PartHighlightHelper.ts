import {
  MESH_CACHE_NAMESPACE_HIGHLIGHT,
  normalizeMeshCollectorFeatureIds,
  type MeshCollector,
} from "../MeshCollector";
import { getPropertyDataMapFromTilesByFeatureAttribute } from "../mesh-helper/mesh";
import type {
  StyleCondition,
  StyleConditionInput,
  StyleShowInput,
} from "./style-appearance-types";
import {
  buildStyleConditionEvaluatorMap,
  evaluateStyleCondition,
} from "./style-condition-eval";
import {
  collectFeatureIdAttributesFromStyleConfig,
  normalizeFeatureIdAttribute,
  resolveShowFeatureIdAttribute,
  resolveStyleConditionFeatureIdAttribute,
} from "./style-condition-input";
import type { PartEffectHost } from "./part-effect-host";
import type { ColorInput } from "../utils/color-input";
import {
  Euler,
  Material,
  Object3D,
  Vector3,
} from "three";
import type {
  StyleAppearance,
  StyleEulerInput,
  StyleMaterialResolver,
  StyleMeshFactory,
  StyleVec3Input,
} from "./style-appearance-types";
import {
  appearanceGroupKey,
  applyEuler,
  applyStyleAppearanceToMesh,
  applyVec3,
  buildPivotStyleMatrix,
  detachStyledMeshFromScene,
  eulerKey,
  restoreMeshAppearanceMaps,
  vec3Key,
  type MeshAppearanceMaps,
  type StoredTransform,
} from "./style-appearance-shared";

/** 高亮用材质：与 {@link StyleAppearance.material} 相同，不含内嵌 color/opacity */
export type HighlightMaterial = Material | StyleMaterialResolver;

/** 条件命中后的外观；`color` / `opacity` 与 `material` 同级，语义同 setStyle */
export interface HighlightAppearance {
  material?: HighlightMaterial;
  color?: ColorInput;
  opacity?: number;
  mesh?: StyleMeshFactory;
  translation?: StyleVec3Input;
  scale?: StyleVec3Input;
  rotation?: StyleEulerInput;
  origin?: StyleVec3Input;
}

export type HighlightCondition = [StyleConditionInput, HighlightAppearance];

/**
 * 高亮配置：语义与 setStyle 相似，多一个 name 用于命名分组
 *
 * 与 setStyle 的关键差异：`conditions` 中**所有**命中的条目都会各自生效，
 * 分别创建独立的 MeshCollector 与 split mesh 实例，视觉上叠加。
 */
export interface HighlightOptions {
  name: string;
  show?: StyleShowInput;
  conditions?: HighlightCondition[];
  /** 若指定，仅在这些 feature id 与属性数据的交集中应用 */
  featureIds?: number[];
  /** 顶点属性索引，0 → `_FEATURE_ID_0`，1 → `_FEATURE_ID_1`；默认 0 */
  featureIdAttribute?: number;
  /** @deprecated 请使用 featureIds + featureIdAttribute: 0 */
  oids?: number[];
  /** @deprecated 请使用 featureIds + featureIdAttribute: 1 */
  pids?: number[];
}

/** @deprecated 请使用 HighlightOptions */
export type HighlightByPidsOptions = HighlightOptions;

interface HighlightGroupConfig {
  show?: StyleShowInput;
  conditions?: HighlightCondition[];
  featureIds?: number[];
  featureIdAttribute: number;
}

export interface ResolvedHighlightOptions {
  name: string;
  show?: StyleShowInput;
  conditions?: HighlightCondition[];
  featureIds: number[];
  featureIdAttribute: number;
}

function resolveHighlightOptions(
  options: HighlightOptions,
): ResolvedHighlightOptions {
  const hasFeatureIds =
    normalizeMeshCollectorFeatureIds(options.featureIds ?? []).length > 0;
  const hasOids = normalizeMeshCollectorFeatureIds(options.oids ?? []).length > 0;
  const hasPids = normalizeMeshCollectorFeatureIds(options.pids ?? []).length > 0;
  const legacyCount = [hasFeatureIds, hasOids, hasPids].filter(Boolean).length;
  if (legacyCount > 1) {
    throw new Error(
      "HighlightOptions cannot specify more than one of featureIds, oids, and pids",
    );
  }

  let featureIds: number[] = [];
  let featureIdAttribute = normalizeFeatureIdAttribute(
    options.featureIdAttribute,
  );

  if (hasFeatureIds) {
    featureIds = normalizeMeshCollectorFeatureIds(options.featureIds!);
  } else if (hasOids) {
    featureIds = normalizeMeshCollectorFeatureIds(options.oids!);
    featureIdAttribute = 0;
  } else if (hasPids) {
    featureIds = normalizeMeshCollectorFeatureIds(options.pids!);
    featureIdAttribute = 1;
  }

  if (legacyCount === 0 && options.featureIdAttribute === undefined) {
    const attrs = collectFeatureIdAttributesFromStyleConfig({
      show: options.show,
      conditions: options.conditions,
    });
    if (attrs.length === 1) {
      featureIdAttribute = attrs[0]!;
    }
  }

  return {
    name: options.name,
    show: options.show,
    conditions: options.conditions,
    featureIds,
    featureIdAttribute,
  };
}

function highlightGroupAppliesToAttribute(
  hl: HighlightGroupConfig,
  featureIdAttribute: number,
): boolean {
  if (hl.featureIds?.length) {
    return hl.featureIdAttribute === featureIdAttribute;
  }
  if (
    hl.show != null &&
    resolveShowFeatureIdAttribute(hl.show) === featureIdAttribute
  ) {
    return true;
  }
  for (const [cond] of hl.conditions ?? []) {
    if (
      resolveStyleConditionFeatureIdAttribute(cond) === featureIdAttribute
    ) {
      return true;
    }
  }
  return false;
}

function toStyleAppearance(ha: HighlightAppearance): StyleAppearance {
  const appearance: StyleAppearance = {
    mesh: ha.mesh,
    translation: ha.translation,
    scale: ha.scale,
    rotation: ha.rotation,
    origin: ha.origin,
  };
  if (ha.color !== undefined) appearance.color = ha.color;
  if (ha.opacity !== undefined) appearance.opacity = ha.opacity;
  if (ha.material !== undefined) appearance.material = ha.material;
  return appearance;
}

function cloneHighlightOptions(options: HighlightOptions): HighlightOptions {
  const resolved = resolveHighlightOptions(options);
  const cloned: HighlightOptions = {
    name: resolved.name,
    show: resolved.show,
    featureIdAttribute: resolved.featureIdAttribute,
    featureIds: resolved.featureIds.slice(),
    conditions: options.conditions?.map(
      ([c, h]): HighlightCondition => [c, { ...h }],
    ),
  };
  if (resolved.featureIdAttribute === 0 && resolved.featureIds.length > 0) {
    cloned.oids = resolved.featureIds.slice();
  }
  if (resolved.featureIdAttribute === 1 && resolved.featureIds.length > 0) {
    cloned.pids = resolved.featureIds.slice();
  }
  return cloned;
}

function highlightAppearanceNeedsTransform(ha: HighlightAppearance): boolean {
  return (
    ha.translation !== undefined ||
    ha.scale !== undefined ||
    ha.rotation !== undefined
  );
}

function highlightAppearanceTransformKey(ha: HighlightAppearance): string {
  return `${vec3Key(ha.translation)}|${vec3Key(ha.scale)}|${eulerKey(ha.rotation)}|${vec3Key(ha.origin)}`;
}

function localMatrix16FromHighlightAppearance(
  ha: HighlightAppearance,
): number[] | undefined {
  if (!highlightAppearanceNeedsTransform(ha)) return undefined;

  const obj = new Object3D();
  const hasScaleOrRotation =
    ha.scale !== undefined || ha.rotation !== undefined;

  if (hasScaleOrRotation) {
    const pivot = new Vector3();
    if (ha.origin !== undefined) {
      applyVec3(pivot, ha.origin);
    } else {
      pivot.set(0, 0, 0);
    }

    let sx = 1;
    let sy = 1;
    let sz = 1;
    if (ha.scale !== undefined) {
      if (Array.isArray(ha.scale)) {
        sx = ha.scale[0] ?? 1;
        sy = ha.scale[1] ?? 1;
        sz = ha.scale[2] ?? 1;
      } else {
        const sc = ha.scale as Vector3;
        sx = sc.x;
        sy = sc.y;
        sz = sc.z;
      }
    }

    const euler = new Euler();
    if (ha.rotation !== undefined) {
      applyEuler(euler, ha.rotation);
    } else {
      euler.set(0, 0, 0);
    }

    const styleM = buildPivotStyleMatrix(pivot, sx, sy, sz, euler);
    obj.updateMatrix();
    obj.matrix.multiply(styleM);
    obj.matrix.decompose(obj.position, obj.quaternion, obj.scale);
  }

  if (ha.translation !== undefined) {
    applyVec3(obj.position, ha.translation);
  }

  obj.updateMatrix();
  return Array.from(obj.matrix.elements);
}

/**
 * 构件高亮辅助器
 * 与 setStyle 相同的 show / conditions / 位姿语义，多组命名高亮
 */
export class PartHighlightHelper {
  private highlightGroups = new Map<string, HighlightGroupConfig>();
  private highlightConfigByName = new Map<string, HighlightOptions>();
  private originalMaterialByMesh = new Map<string, Material>();
  private originalTransformByMesh = new Map<string, StoredTransform>();
  private meshChangeHandlers = new Map<string, () => void>();
  private collectorAppearanceByKey = new Map<string, StyleAppearance>();
  private highlightCollectors: MeshCollector[] = [];

  constructor(private context: PartEffectHost) {}

  private getMaps(): MeshAppearanceMaps {
    return {
      originalMaterialByMesh: this.originalMaterialByMesh,
      originalTransformByMesh: this.originalTransformByMesh,
    };
  }

  private buildAppearanceGroupsForAttribute(
    propertyMap: Map<number, Record<string, unknown> | null>,
    featureIdAttribute: number,
  ): {
    groups: Map<string, { appearance: StyleAppearance; featureIds: number[] }>;
    styledIds: Set<number>;
  } {
    const groupsByKey = new Map<
      string,
      { appearance: StyleAppearance; ids: Set<number> }
    >();
    const styledIds = new Set<number>();

    for (const [, hl] of this.highlightGroups) {
      if (!highlightGroupAppliesToAttribute(hl, featureIdAttribute)) continue;

      const evaluators = buildStyleConditionEvaluatorMap({
        show: hl.show,
        conditions: (hl.conditions ?? []) as StyleCondition[],
      });
      const conditions = (hl.conditions ?? [])
        .filter(
          ([cond]) =>
            resolveStyleConditionFeatureIdAttribute(cond) ===
            featureIdAttribute,
        )
        .map(
          ([c, h]): [StyleConditionInput, StyleAppearance] => [
            c,
            toStyleAppearance(h),
          ],
        );
      const showForChannel =
        hl.show != null &&
        resolveShowFeatureIdAttribute(hl.show) === featureIdAttribute
          ? hl.show
          : undefined;
      const explicitIds = hl.featureIds;
      const idsSet = explicitIds?.length ? new Set(explicitIds) : null;
      const candidateIds = idsSet ? [...idsSet] : [...propertyMap.keys()];

      for (const partId of candidateIds) {
        const propertyData = propertyMap.get(partId) ?? null;
        if (propertyData == null && !idsSet) continue;
        if (
          showForChannel &&
          !evaluateStyleCondition(showForChannel, propertyData, evaluators)
        ) {
          continue;
        }

        for (const [cond, appearance] of conditions) {
          if (!evaluateStyleCondition(cond, propertyData, evaluators)) continue;
          const gkey = appearanceGroupKey(appearance);
          let g = groupsByKey.get(gkey);
          if (!g) {
            g = { appearance, ids: new Set() };
            groupsByKey.set(gkey, g);
          }
          g.ids.add(partId);
          styledIds.add(partId);
        }
      }
    }

    const groups = new Map<
      string,
      { appearance: StyleAppearance; featureIds: number[] }
    >();
    for (const [gkey, g] of groupsByKey) {
      groups.set(gkey, { appearance: g.appearance, featureIds: [...g.ids] });
    }

    return { groups, styledIds };
  }

  private collectUnionShowHideForAttribute(
    propertyMap: Map<number, Record<string, unknown> | null>,
    featureIdAttribute: number,
  ): Set<number> {
    const unionHide = new Set<number>();
    for (const [, hl] of this.highlightGroups) {
      if (!highlightGroupAppliesToAttribute(hl, featureIdAttribute)) continue;

      const evaluators = buildStyleConditionEvaluatorMap({
        show: hl.show,
        conditions: (hl.conditions ?? []) as StyleCondition[],
      });
      const showForChannel =
        hl.show != null &&
        resolveShowFeatureIdAttribute(hl.show) === featureIdAttribute
          ? hl.show
          : undefined;
      if (!showForChannel) continue;

      const explicitIds = hl.featureIds;
      const idsSet = explicitIds?.length ? new Set(explicitIds) : null;
      const candidateIds = idsSet ? [...idsSet] : [...propertyMap.keys()];
      for (const partId of candidateIds) {
        const propertyData = propertyMap.get(partId) ?? null;
        if (propertyData == null && !idsSet) continue;
        if (!evaluateStyleCondition(showForChannel, propertyData, evaluators)) {
          unionHide.add(partId);
        }
      }
    }
    return unionHide;
  }

  private collectUsedFeatureIdAttributes(): number[] {
    const attrs = new Set<number>();
    for (const [, hl] of this.highlightGroups) {
      if (hl.featureIds?.length) {
        attrs.add(hl.featureIdAttribute);
      }
      if (hl.show != null) {
        attrs.add(resolveShowFeatureIdAttribute(hl.show));
      }
      for (const [cond] of hl.conditions ?? []) {
        attrs.add(resolveStyleConditionFeatureIdAttribute(cond));
      }
    }
    if (attrs.size === 0) attrs.add(0);
    return [...attrs].sort((a, b) => a - b);
  }

  private clearCollectorsAndRestoreMeshes(): void {
    const maps = this.getMaps();
    for (const collector of this.highlightCollectors) {
      collector.meshes.forEach((mesh) => {
        restoreMeshAppearanceMaps(mesh, maps);
        detachStyledMeshFromScene(mesh);
      });
      const groupKey = collector.getInteractionGroupKey();
      const handler = this.meshChangeHandlers.get(groupKey);
      if (handler) {
        collector.removeEventListener("mesh-change", handler);
        this.meshChangeHandlers.delete(groupKey);
      }
      this.context.releaseMeshCollector(collector);
    }
    this.highlightCollectors = [];
    this.collectorAppearanceByKey.clear();
  }

  /**
   * 单瓦片可见时增量应用高亮 split mesh（仅遍历该 scene，不全局扫描）。
   */
  applyHighlightToTileScene(scene: Object3D): void {
    if (this.highlightCollectors.length === 0) return;

    const rootGroup = this.context.getRootGroup();
    if (!rootGroup) return;

    const maps = this.getMaps();
    for (const collector of this.highlightCollectors) {
      const groupKey = collector.getInteractionGroupKey();
      const appearance = this.collectorAppearanceByKey.get(groupKey);
      if (!appearance) continue;

      const added = collector.appendMeshesForTileScene(scene);
      for (const mesh of added) {
        applyStyleAppearanceToMesh(mesh, appearance, rootGroup, maps);
      }
    }
  }

  /** 高亮收集器列表（供插件区分托管/自建收集器） */
  getHighlightCollectors(): readonly MeshCollector[] {
    return this.highlightCollectors;
  }

  private reapplyAll(): void {
    this.clearCollectorsAndRestoreMeshes();
    this.collectorAppearanceByKey.clear();

    if (this.highlightGroups.size === 0) {
      this.context.hidePartsByFeatureAttribute([], 0);
      this.context.hidePartsByFeatureAttribute([], 1);
      return;
    }

    const tiles = this.context.getTiles();
    const scene = this.context.getRootGroup();
    if (!tiles || !scene) return;

    const maps = this.getMaps();
    const attributes = this.collectUsedFeatureIdAttributes();

    for (const featureIdAttribute of attributes) {
      const propertyMap = getPropertyDataMapFromTilesByFeatureAttribute(
        tiles,
        featureIdAttribute,
        this.context.getInternalData?.(),
      );
      const { groups, styledIds } = this.buildAppearanceGroupsForAttribute(
        propertyMap,
        featureIdAttribute,
      );
      const unionHide = this.collectUnionShowHideForAttribute(
        propertyMap,
        featureIdAttribute,
      );
      const idsToHide = [...new Set([...styledIds, ...unionHide])];

      this.context.hidePartsByFeatureAttribute(idsToHide, featureIdAttribute);

      for (const { appearance, featureIds } of groups.values()) {
        const sortedIds = normalizeMeshCollectorFeatureIds(featureIds);
        const collector = this.context.getMeshCollectorByCondition({
          featureIds: sortedIds,
          featureIdAttribute,
          meshCacheNamespace: MESH_CACHE_NAMESPACE_HIGHLIGHT,
        });
        this.highlightCollectors.push(collector);

        const groupKey = collector.getInteractionGroupKey();
        this.collectorAppearanceByKey.set(groupKey, appearance);
        const handler = () => {
          const s = this.context.getRootGroup();
          if (!s) return;
          collector.meshes.forEach((mesh) => {
            applyStyleAppearanceToMesh(mesh, appearance, s, maps);
          });
        };
        this.meshChangeHandlers.set(groupKey, handler);
        collector.addEventListener("mesh-change", handler);
        handler();
      }
    }
  }

  highlight(options: HighlightOptions): void {
    const resolved = resolveHighlightOptions(options);
    if (
      !resolved.show &&
      (!resolved.conditions || resolved.conditions.length === 0) &&
      resolved.featureIds.length === 0
    ) {
      this.cancelHighlight(resolved.name);
      return;
    }

    this.highlightGroups.set(resolved.name, {
      show: resolved.show,
      conditions: resolved.conditions,
      featureIds: resolved.featureIds.length
        ? resolved.featureIds
        : undefined,
      featureIdAttribute: resolved.featureIdAttribute,
    });
    this.highlightConfigByName.set(resolved.name, cloneHighlightOptions(options));
    this.reapplyAll();
  }

  /** @deprecated 请使用 highlight({ ...options, featureIdAttribute: 1 }) */
  highlightByPids(options: HighlightByPidsOptions): void {
    this.highlight({
      ...options,
      featureIdAttribute: options.featureIdAttribute ?? 1,
      featureIds: options.featureIds ?? options.pids,
      pids: options.pids,
    });
  }

  getHighlightByName(name: string): HighlightOptions | undefined {
    const saved = this.highlightConfigByName.get(name);
    return saved ? cloneHighlightOptions(saved) : undefined;
  }

  /** @deprecated 请使用 getHighlightByName */
  getHighlightByPidName(name: string): HighlightOptions | undefined {
    return this.getHighlightByName(name);
  }

  getHighlightMatrixByName(name: string): number[] | undefined {
    const saved = this.highlightConfigByName.get(name);
    if (!saved?.conditions?.length) return undefined;

    let matrix: number[] | undefined;
    let seenKey: string | undefined;

    for (const [, ha] of saved.conditions) {
      if (!highlightAppearanceNeedsTransform(ha)) continue;
      const m = localMatrix16FromHighlightAppearance(ha);
      if (!m) continue;
      const k = highlightAppearanceTransformKey(ha);
      if (seenKey === undefined) {
        seenKey = k;
        matrix = m;
      } else if (seenKey !== k) {
        return undefined;
      }
    }

    return matrix ? matrix.slice() : undefined;
  }

  cancelHighlight(name: string): void {
    this.highlightConfigByName.delete(name);
    if (!this.highlightGroups.has(name)) return;
    this.highlightGroups.delete(name);
    this.reapplyAll();
  }

  /** @deprecated 请使用 cancelHighlight */
  cancelHighlightByPid(name: string): void {
    this.cancelHighlight(name);
  }

  cancelAllHighlight(): void {
    this.highlightGroups.clear();
    this.highlightConfigByName.clear();
    this.reapplyAll();
  }

  /** @deprecated 请使用 cancelAllHighlight */
  cancelAllHighlightByPid(): void {
    this.cancelAllHighlight();
  }

  dispose(): void {
    this.cancelAllHighlight();
  }
}
