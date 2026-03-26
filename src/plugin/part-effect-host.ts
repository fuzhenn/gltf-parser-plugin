import type { Object3D } from "three";
import type { TilesRenderer } from "3d-tiles-renderer";
import type { MeshCollector, MeshCollectorQuery } from "../MeshCollector";

/** 构件外观辅助（着色 / 闪烁 / 线框 / 高亮）从插件注入的能力 */
export interface PartEffectHost {
  getTiles(): TilesRenderer | null;
  hidePartsByOids(oids: number[]): void;
  showPartsByOids(oids: number[]): void;
  getMeshCollectorByOid(oid: number): MeshCollector;
  getMeshCollectorByCondition(query: MeshCollectorQuery): MeshCollector;
  getScene(): Object3D | null;
}
