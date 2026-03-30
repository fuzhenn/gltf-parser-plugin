import {
  normalizeMeshCollectorOids,
  type MeshCollector,
  type MeshCollectorQuery,
} from "../MeshCollector";
import type { TilesRenderer } from "3d-tiles-renderer";
import { getPropertyDataMapFromTiles } from "../mesh-helper/mesh";
import { Object3D } from "three";
import type { Material } from "three";
import type { StyleConfig } from "./style-appearance-types";
import { buildStyleConditionEvaluatorMap } from "./style-condition-eval";
import {
  applyStyleAppearanceToMesh,
  buildAppearanceGroupsFromPropertyMap,
  type MeshAppearanceMaps,
  type StoredTransform,
} from "./style-appearance-shared";

export type {
  StyleAppearance,
  StyleConfig,
  StyleCondition,
  StyleEulerInput,
  StyleMaterialMaps,
  StyleMaterialResolver,
  StyleMeshFactory,
  StyleVec3Input,
} from "./style-appearance-types";

/** 内部使用：插件需提供的接口 */
interface StyleHelperContext {
  getTiles(): TilesRenderer | null;
  hidePartsByOids(oids: number[]): void;
  showPartsByOids(oids: number[]): void;
  getMeshCollectorByCondition(query: MeshCollectorQuery): MeshCollector;
  getScene(): Object3D | null;
}

/**
 * 构件样式辅助器
 * 通过 show 表达式控制可见性，通过 conditions 应用条件材质与可选位姿
 */
export class StyleHelper {
  /** 当前样式配置；在插件上可通过 `plugin.style` 读写（与 `setStyle` 等价） */
  style: StyleConfig | null = null;
  private styledOids = new Set<number>();
  private hiddenOids = new Set<number>();
  private originalMaterialByMesh = new Map<string, Material>();
  private originalTransformByMesh = new Map<string, StoredTransform>();
  /** 按材质分组后的收集器，key 与 collector.getCacheKey() 一致 */
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
    const styledOidsList = Array.from(this.styledOids);
    const hiddenOidsList = Array.from(this.hiddenOids);

    for (const collector of this.styleCollectors) {
      collector.meshes.forEach((mesh) => {
        const original = this.originalMaterialByMesh.get(mesh.uuid);
        if (original) {
          mesh.material = original;
          this.originalMaterialByMesh.delete(mesh.uuid);
        }
        const origT = this.originalTransformByMesh.get(mesh.uuid);
        if (origT) {
          mesh.position.copy(origT.position);
          mesh.scale.copy(origT.scale);
          mesh.rotation.copy(origT.rotation);
          this.originalTransformByMesh.delete(mesh.uuid);
        }
        mesh.removeFromParent();
      });

      const handler = this.meshChangeHandlers.get(collector.getCacheKey());
      if (handler) {
        collector.removeEventListener("mesh-change", handler);
      }
    }
    this.meshChangeHandlers.clear();
    this.styleCollectors = [];

    this.style = null;
    this.styledOids.clear();
    this.hiddenOids.clear();
    this.context.showPartsByOids([...styledOidsList, ...hiddenOidsList]);
  }

  private applyStyle(): void {
    const style = this.style;
    if (!style) return;

    // TODO 命名getRootGroup
    const scene = this.context.getScene();
    if (!scene) return;

    const tiles = this.context.getTiles();
    if (!tiles) return;

    const propertyByOid = getPropertyDataMapFromTiles(tiles);

    for (const collector of this.styleCollectors) {
      const h = this.meshChangeHandlers.get(collector.getCacheKey());
      if (h) collector.removeEventListener("mesh-change", h);
    }
    this.styleCollectors = [];
    this.meshChangeHandlers.clear();

    const evaluators = buildStyleConditionEvaluatorMap({
      show: style.show,
      conditions: style.conditions ?? [],
    });
    const { hiddenOidsList, groups } = buildAppearanceGroupsFromPropertyMap(
      propertyByOid,
      { show: style.show, conditions: style.conditions ?? [] },
      evaluators,
    );

    for (const { oids } of groups.values()) {
      for (const oid of oids) {
        this.styledOids.add(oid);
      }
    }

    this.hiddenOids = new Set(hiddenOidsList);
    const oidsToHide = [...hiddenOidsList];
    for (const { oids } of groups.values()) {
      oidsToHide.push(...oids);
    }

    const maps: MeshAppearanceMaps = {
      originalMaterialByMesh: this.originalMaterialByMesh,
      originalTransformByMesh: this.originalTransformByMesh,
    };

    for (const { appearance, oids } of groups.values()) {
      const sortedOids = normalizeMeshCollectorOids(oids);
      const collector = this.context.getMeshCollectorByCondition({
        oids: sortedOids,
      });
      this.styleCollectors.push(collector);

      const cacheKey = collector.getCacheKey();
      const handler = () => {
        const s = this.context.getScene();
        if (!s) return;
        collector.meshes.forEach((mesh) => {
          applyStyleAppearanceToMesh(mesh, appearance, s, maps);
        });
      };
      this.meshChangeHandlers.set(cacheKey, handler);
      collector.addEventListener("mesh-change", handler);
      handler();
    }

    this.context.hidePartsByOids(oidsToHide);
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
