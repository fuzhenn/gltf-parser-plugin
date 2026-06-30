import {
  MESH_CACHE_NAMESPACE_STYLE,
  normalizeMeshCollectorFeatureIds,
  type MeshCollector,
  type MeshCollectorQuery,
} from "../MeshCollector";
import type { TilesRenderer } from "3d-tiles-renderer";
import { getPropertyDataMapFromTilesByFeatureAttribute } from "../mesh-helper/mesh";
import { Object3D } from "three";
import type { Material } from "three";
import type { StyleConfig, StyleAppearance } from "./style-appearance-types";
import { buildStyleConditionEvaluatorMap } from "./style-condition-eval";
import { collectFeatureIdAttributesFromStyleConfig } from "./style-condition-input";
import {
  applyStyleAppearanceToMesh,
  buildAppearanceGroupsFromPropertyMap,
  detachStyledMeshFromScene,
  restoreMeshAppearanceMaps,
  type MeshAppearanceMaps,
  type StoredTransform,
} from "./style-appearance-shared";

export type {
  StyleAppearance,
  StyleCondition,
  StyleConditionDescriptor,
  StyleConditionInput,
  StyleConfig,
  StyleEulerInput,
  StyleMaterialMaps,
  StyleMaterialResolver,
  StyleMeshFactory,
  StyleShowInput,
  StyleVec3Input,
} from "./style-appearance-types";

/** 内部使用：插件需提供的接口 */
interface StyleHelperContext {
  getTiles(): TilesRenderer | null;
  hidePartsByFeatureAttribute(
    featureIds: number[],
    featureIdAttribute: number,
  ): void;
  showPartsByFeatureAttribute(
    featureIds: number[],
    featureIdAttribute: number,
  ): void;
  getMeshCollectorByCondition(query: MeshCollectorQuery): MeshCollector;
  releaseMeshCollector(collector: MeshCollector): void;
  getRootGroup(): Object3D | null;
  getInternalData?(): import("../mesh-helper/mesh").InternalData | undefined;
}

/**
 * 构件样式辅助器
 * 通过 show 表达式控制可见性，通过 conditions 应用条件材质与可选位姿
 */
export class StyleHelper {
  /** 当前样式配置；在插件上可通过 `plugin.style` 读写（与 `setStyle` 等价） */
  style: StyleConfig | null = null;
  private styledIdsByAttribute = new Map<number, Set<number>>();
  private hiddenIdsByAttribute = new Map<number, Set<number>>();
  private originalMaterialByMesh = new Map<string, Material>();
  private originalTransformByMesh = new Map<string, StoredTransform>();
  /** 按收集器实例（interactionGroupKey）挂接 mesh-change */
  private meshChangeHandlers = new Map<string, () => void>();
  /** 收集器 → 外观，供单瓦片增量应用 */
  private collectorAppearanceByKey = new Map<string, StyleAppearance>();
  /** 当前样式占用的收集器（用于 clearStyle / 下次 applyStyle 前卸载监听） */
  private styleCollectors: MeshCollector[] = [];

  constructor(private context: StyleHelperContext) {}

  /**
   * 设置样式
   * @param style 样式配置，传 null 或空对象清除样式
   */
  setStyle(style: StyleConfig | null): void {
    this.clearStyle();
    this.style = style;

    if (
      !style ||
      (!style.show && (!style.conditions || style.conditions.length === 0))
    ) {
      return;
    }

    this.applyStyle();
  }

  /**
   * 清除样式，恢复默认显示
   */
  clearStyle(): void {
    for (const [attr, ids] of this.styledIdsByAttribute) {
      this.context.showPartsByFeatureAttribute([...ids], attr);
    }
    for (const [attr, ids] of this.hiddenIdsByAttribute) {
      this.context.showPartsByFeatureAttribute([...ids], attr);
    }

    const maps: MeshAppearanceMaps = {
      originalMaterialByMesh: this.originalMaterialByMesh,
      originalTransformByMesh: this.originalTransformByMesh,
    };
    for (const collector of this.styleCollectors) {
      collector.meshes.forEach((mesh) => {
        restoreMeshAppearanceMaps(mesh, maps);
        detachStyledMeshFromScene(mesh);
      });

      const handler = this.meshChangeHandlers.get(
        collector.getInteractionGroupKey(),
      );
      if (handler) {
        collector.removeEventListener("mesh-change", handler);
      }
      this.context.releaseMeshCollector(collector);
    }
    this.meshChangeHandlers.clear();
    this.collectorAppearanceByKey.clear();
    this.styleCollectors = [];

    this.style = null;
    this.styledIdsByAttribute.clear();
    this.hiddenIdsByAttribute.clear();
  }

  /**
   * 单瓦片可见时增量应用样式 split mesh（仅遍历该 scene，不全局扫描）。
   */
  applyStyleToTileScene(scene: Object3D): void {
    if (!this.style || this.styleCollectors.length === 0) return;

    const rootGroup = this.context.getRootGroup();
    if (!rootGroup) return;

    const maps: MeshAppearanceMaps = {
      originalMaterialByMesh: this.originalMaterialByMesh,
      originalTransformByMesh: this.originalTransformByMesh,
    };

    for (const collector of this.styleCollectors) {
      const groupKey = collector.getInteractionGroupKey();
      const appearance = this.collectorAppearanceByKey.get(groupKey);
      if (!appearance) continue;

      const added = collector.appendMeshesForTileScene(scene);
      for (const mesh of added) {
        applyStyleAppearanceToMesh(mesh, appearance, rootGroup, maps);
      }
    }
  }

  /** 样式收集器列表（供插件区分托管/自建收集器） */
  getStyleCollectors(): readonly MeshCollector[] {
    return this.styleCollectors;
  }

  private resolveStyleFromTiles(): {
    idsToHideByAttribute: Map<number, number[]>;
    channelGroups: Array<{
      featureIdAttribute: number;
      groups: ReturnType<
        typeof buildAppearanceGroupsFromPropertyMap
      >["groups"];
    }>;
  } | null {
    const style = this.style;
    if (!style) return null;

    const tiles = this.context.getTiles();
    if (!tiles) return null;

    const evaluators = buildStyleConditionEvaluatorMap({
      show: style.show,
      conditions: style.conditions ?? [],
    });

    const attributes = collectFeatureIdAttributesFromStyleConfig(style);
    const channelGroups: Array<{
      featureIdAttribute: number;
      groups: ReturnType<
        typeof buildAppearanceGroupsFromPropertyMap
      >["groups"];
    }> = [];
    const idsToHideByAttribute = new Map<number, number[]>();

    this.styledIdsByAttribute.clear();
    this.hiddenIdsByAttribute.clear();

    for (const featureIdAttribute of attributes) {
      const propertyMap = getPropertyDataMapFromTilesByFeatureAttribute(
        tiles,
        featureIdAttribute,
        this.context.getInternalData?.(),
      );
      const { hiddenFeatureIdsList, groups } =
        buildAppearanceGroupsFromPropertyMap(
          propertyMap,
          { show: style.show, conditions: style.conditions ?? [] },
          evaluators,
          featureIdAttribute,
        );

      const styledIds = new Set<number>();
      const hideSet = new Set(hiddenFeatureIdsList);
      const idsToHide: number[] = [...hiddenFeatureIdsList];

      for (const { featureIds } of groups.values()) {
        for (const id of featureIds) {
          styledIds.add(id);
          idsToHide.push(id);
        }
      }

      this.styledIdsByAttribute.set(featureIdAttribute, styledIds);
      this.hiddenIdsByAttribute.set(featureIdAttribute, hideSet);
      idsToHideByAttribute.set(featureIdAttribute, [...new Set(idsToHide)]);
      channelGroups.push({ featureIdAttribute, groups });
    }

    return { idsToHideByAttribute, channelGroups };
  }

  private applyStyle(): void {
    const style = this.style;
    if (!style) return;

    const rootGroup = this.context.getRootGroup();
    if (!rootGroup) return;

    for (const collector of this.styleCollectors) {
      const h = this.meshChangeHandlers.get(
        collector.getInteractionGroupKey(),
      );
      if (h) collector.removeEventListener("mesh-change", h);
      this.context.releaseMeshCollector(collector);
    }
    this.styleCollectors = [];
    this.meshChangeHandlers.clear();
    this.collectorAppearanceByKey.clear();

    const resolved = this.resolveStyleFromTiles();
    if (!resolved) return;

    const maps: MeshAppearanceMaps = {
      originalMaterialByMesh: this.originalMaterialByMesh,
      originalTransformByMesh: this.originalTransformByMesh,
    };

    for (const { featureIdAttribute, groups } of resolved.channelGroups) {
      for (const { appearance, featureIds } of groups.values()) {
        const sortedIds = normalizeMeshCollectorFeatureIds(featureIds);
        const collector = this.context.getMeshCollectorByCondition({
          featureIds: sortedIds,
          featureIdAttribute,
          meshCacheNamespace: MESH_CACHE_NAMESPACE_STYLE,
        });
        this.styleCollectors.push(collector);

        const groupKey = collector.getInteractionGroupKey();
        this.collectorAppearanceByKey.set(groupKey, appearance);
        const handler = () => {
          if (!rootGroup) return;
          collector.meshes.forEach((mesh) => {
            applyStyleAppearanceToMesh(mesh, appearance, rootGroup, maps);
          });
        };
        this.meshChangeHandlers.set(groupKey, handler);
        collector.addEventListener("mesh-change", handler);
        handler();
      }
    }

    for (const [attr, ids] of resolved.idsToHideByAttribute) {
      this.context.hidePartsByFeatureAttribute(ids, attr);
    }
  }

  dispose(): void {
    this.clearStyle();
  }
}
