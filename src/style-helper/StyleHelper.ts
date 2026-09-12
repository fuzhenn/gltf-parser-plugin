import { Mesh, Object3D } from "three";
import { MeshCollector } from "./MeshCollector";
import {
  buildSplitCacheKey,
  collectTileMeshesFromScene,
  hideMatchedFeaturesOnInstancedMesh,
  hideMatchedFeaturesOnTileMesh,
} from "./utils";
import type { StyleConfig } from "../appearance";
import type { MaterialBuilder } from "../types";
import { isTileInstancedMesh, isTileMesh } from "../mesh-helper";

/** scene 级样式代数标记（挂在 scene.userData，随瓦片释放自动清理） */
const STYLE_GENERATION_KEY = "_gltfParserStyleGeneration";

export class StyleHelper {
  style: StyleConfig | null = null;
  private readonly _collectors = new Map<string, MeshCollector>();
  private readonly _materialBuilder?: MaterialBuilder;
  private _generation = 0;

  constructor(materialBuilder?: MaterialBuilder) {
    this._materialBuilder = materialBuilder;
  }

  /** 样式代数：每次 setStyle 递增，scene 上的标记落后即为"过期" */
  get generation(): number {
    return this._generation;
  }

  setStyle(style: StyleConfig | null, scenes: Object3D[]): MeshCollector[] {
    this.style = style;
    const keep = new Set(
      (style?.conditions ?? []).map((c) => buildSplitCacheKey(c)),
    );
    const added: MeshCollector[] = [];

    for (const [key, collector] of this._collectors) {
      if (keep.has(key)) continue;
      for (const scene of scenes) collector.dispose(scene);
      this._collectors.delete(key);
    }

    for (const condition of style?.conditions ?? []) {
      const key = buildSplitCacheKey(condition);
      if (this._collectors.has(key)) continue;
      const collector = new MeshCollector({
        condition,
        materialBuilder: this._materialBuilder,
      });
      this._collectors.set(key, collector);
      added.push(collector);
    }

    this._generation++;
    return added;
  }

  applyTileMeshVisibility(scene: Object3D): void {
    // 暂只支持所有条件共用同一属性通道，取首个 collector 的通道；出现多通道需求时再扩展
    const featureIdAttribute = this._collectors.values().next()
      .value?.featureIdAttribute;

    const hiddenFids = new Set<number>();
    scene.traverse((child) => {
      hiddenFids.clear();
      if (isTileInstancedMesh(child)) {
        for (const collector of this._collectors.values()) {
          collector.addMatchedFeatureIds(child, hiddenFids);
        }
        // InstancedMesh 的隐藏，与普通 mesh 的 index 过滤不同路径
        hideMatchedFeaturesOnInstancedMesh(
          child,
          featureIdAttribute,
          hiddenFids,
        );
        return;
      }
      if (!isTileMesh(child)) return;

      for (const collector of this._collectors.values()) {
        collector.addMatchedFeatureIds(child, hiddenFids);
      }
      hideMatchedFeaturesOnTileMesh(child, featureIdAttribute, hiddenFids);
    });
  }

  applySceneIfStale(scene: Object3D): void {
    if (scene.userData[STYLE_GENERATION_KEY] === this._generation) {
      return;
    }
    this.applyTileMeshVisibility(scene);
    this._applyStyle(scene);
    scene.userData[STYLE_GENERATION_KEY] = this._generation;
  }

  getSplitMeshes(scene: Object3D): Mesh[] {
    const splitMeshes: Mesh[] = [];
    for (const tileMesh of collectTileMeshesFromScene(scene)) {
      for (const collector of this._collectors.values()) {
        const mesh = collector.getSplitMesh(tileMesh);
        if (mesh) splitMeshes.push(mesh);
      }
    }
    return splitMeshes;
  }

  disposeTileScene(scene: Object3D): void {
    for (const collector of this._collectors.values()) {
      collector.dispose(scene);
    }
  }

  private _applyStyle(scene: Object3D): void {
    for (const collector of this._collectors.values()) {
      collector.applyStyle(scene);
    }
  }
}
