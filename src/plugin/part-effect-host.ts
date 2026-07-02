import type { Object3D } from "three";
import type { TilesRenderer } from "3d-tiles-renderer";
import type { MeshCollector, MeshCollectorQuery } from "../MeshCollector";
import type { InternalData } from "../mesh-helper/mesh";
import type { MeshPartVisibilityConfig } from "../mesh-helper";

/** 构件外观辅助（着色 / 闪烁 / 线框 / 高亮）从插件注入的能力 */
export interface PartEffectHost {
  getTiles(): TilesRenderer | null;
  setPartVisibilityConfigLayer(
    layerId: string,
    featureIdAttribute: number,
    configs: MeshPartVisibilityConfig[],
  ): void;
  removePartVisibilityConfigLayer(
    layerId: string,
    featureIdAttribute?: number,
  ): void;
  /** @deprecated 样式/高亮请使用 setPartVisibilityConfigLayer；仅 imperative 隐藏时使用 */
  hidePartsByFeatureAttribute(
    featureIds: number[],
    featureIdAttribute: number,
  ): void;
  /** @deprecated 请配合 hidePartsByFeatureAttribute 使用 */
  showPartsByFeatureAttribute(
    featureIds: number[],
    featureIdAttribute: number,
  ): void;
  /** @deprecated 请使用 hidePartsByFeatureAttribute(ids, 0) */
  hidePartsByOids(oids: number[]): void;
  /** @deprecated 请使用 showPartsByFeatureAttribute(ids, 0) */
  showPartsByOids(oids: number[]): void;
  /** @deprecated 请使用 hidePartsByFeatureAttribute(ids, 1) */
  hidePartsByPids(pids: number[]): void;
  /** @deprecated 请使用 showPartsByFeatureAttribute(ids, 1) */
  showPartsByPids(pids: number[]): void;
  getMeshCollectorByCondition(query: MeshCollectorQuery): MeshCollector;
  releaseMeshCollector(collector: MeshCollector): void;
  getRootGroup(): Object3D | null;
  getInternalData?(): InternalData | undefined;
}
