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
import type { StyleConfig } from "./style-appearance-types";
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
    this.styleCollectors = [];

    this.style = null;
    this.styledIdsByAttribute.clear();
    this.hiddenIdsByAttribute.clear();
  }

  /**
   * 仅重算并应用 hide，不重建收集器。
   * 由插件在 tile-visibility-change 防抖后调用。
   */
  refreshHiddenIdsOnly(): void {
    const resolved = this.resolveStyleFromTiles();
    if (!resolved) return;
    for (const [attr, ids] of resolved.idsToHideByAttribute) {
      this.context.hidePartsByFeatureAttribute(ids, attr);
    }
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

  /**
   * 瓦片加载完成后重新应用样式（由插件调用）
   */
  onTilesLoadEnd(): void {
    if (this.style) {
      this.applyStyle();
    }
  }

  dispose(): void {
    this.clearStyle();
  }
}
