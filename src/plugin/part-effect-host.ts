import type { Object3D } from "three";
import type { TilesRenderer } from "3d-tiles-renderer";
import type { MeshCollector, MeshCollectorQuery } from "../MeshCollector";
import type { InternalData } from "../mesh-helper/mesh";

/** 构件外观辅助（着色 / 闪烁 / 线框 / 高亮）从插件注入的能力 */
export interface PartEffectHost {
  getTiles(): TilesRenderer | null;
  hidePartsByOids(oids: number[]): void;
  showPartsByOids(oids: number[]): void;
  getMeshCollectorByCondition(query: MeshCollectorQuery): MeshCollector;
  /** 与 getMeshCollectorByCondition 成对：不再使用该收集器时从插件注销并 dispose（样式/高亮内部会调用） */
  releaseMeshCollector(collector: MeshCollector): void;
  getRootGroup(): Object3D | null;
  /**
   * 可选：从插件读取内部数据钩子（如注入层级 `_path`）。
   * 所有 condition 表达式求值前会用它扩展 propertyData。
   */
  getInternalData?(): InternalData | undefined;
}
