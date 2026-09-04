import { BufferAttribute, BufferGeometry, Mesh, Object3D } from "three";
import { MeshCollector } from "./MeshCollector";
import { buildSplitCacheKey, collectTileMeshesFromScene } from "./utils";
import { StyleConfig } from "../plugin/style-appearance-types";
import {
  buildVisibleIndex,
  isTileMesh,
  snapshotOriginalIndex,
} from "../mesh-helper";

export class StyleHelper {
  style: StyleConfig | null = null;
  private readonly _collectors = new Map<string, MeshCollector>();

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
      const collector = new MeshCollector({ condition });
      this._collectors.set(key, collector);
      added.push(collector);
    }
    return added;
  }

  applyTileMeshVisibility(scene: Object3D): void {
    // 暂只支持所有条件共用同一属性通道，取首个 collector 的通道；出现多通道需求时再扩展
    const featureIdAttribute = this._collectors.values().next()
      .value?.featureIdAttribute;

    const hiddenFids = new Set<number>();
    scene.traverse((child) => {
      if (!isTileMesh(child)) return;

      hiddenFids.clear();
      for (const collector of this._collectors.values()) {
        collector.addMatchedFeatureIds(child, hiddenFids);
      }
      hideMatchedFeaturesOnTileMesh(child, featureIdAttribute, hiddenFids);
    });
  }

  applyStyle(scene: Object3D): void {
    for (const collector of this._collectors.values()) {
      collector.applyStyle(scene);
    }
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
}

function hideMatchedFeaturesOnTileMesh(
  mesh: Mesh,
  featureIdAttribute: number | undefined,
  hiddenFids: Set<number>,
): void {
  const geometry = mesh.geometry;
  const index = geometry?.index;
  if (!index) return;

  if (featureIdAttribute === undefined || hiddenFids.size === 0) {
    restoreOriginalIndex(mesh, geometry);
    return;
  }

  const original = snapshotOriginalIndex(mesh, geometry);
  if (!original) return;

  const filtered = buildVisibleIndex(
    mesh,
    original.array,
    `_feature_id_${featureIdAttribute}`,
    hiddenFids,
  );
  setFilteredIndex(mesh, geometry, original, filtered);
}

function disposeStyleFilteredIndex(
  mesh: Mesh,
  original: BufferAttribute,
): void {
  const filtered = mesh.userData._styleFilteredIndex as
    | BufferAttribute
    | undefined;
  if (filtered && filtered !== original) {
    filtered.dispose();
  }
  mesh.userData._styleFilteredIndex = undefined;
}

function setFilteredIndex(
  mesh: Mesh,
  geometry: BufferGeometry,
  original: BufferAttribute,
  filteredArray: Uint16Array | Uint32Array,
): void {
  disposeStyleFilteredIndex(mesh, original);
  const attr = new BufferAttribute(filteredArray, 1);
  mesh.userData._styleFilteredIndex = attr;
  geometry.setIndex(attr);
}

function restoreOriginalIndex(mesh: Mesh, geometry: BufferGeometry): void {
  const original = mesh.userData._originalIndex;
  if (!(original instanceof BufferAttribute)) return;
  disposeStyleFilteredIndex(mesh, original);
  geometry.setIndex(original);
}

// tile mesh 生命周期
// 1.构造：parseTile函数，gltf loader解析数据构造出来的，此时已经在内存里面
// 2. tiles.update，每一帧都会调用，tiles.update的时候，计算出那些需要加到 root group 里面
// 3. 标记 visivble，加载完成且在相机视锥内
// 4. 加到 root group，tile 被标为 visible 时，才会通过 group.add(scene) 挂到 tiles.group 上
// 5. 比如视角变化之类导致 tile 的 visible 被设置成false的时候， group.remove(scene) 从 tiles.group 上移除，但不释放tile mesh，但是还在内存里面
// 6. dispose model : tile mesh 直接释放掉
// 7. tiles group 加到threejs场景中的时候，才会渲染

// 总结： tile mesh 的创建在解析瓦片阶段，tiles group添加或移除在tiles.update阶段，渲染在threejs场景中，释放在dispose阶段

// split mesh 生命周期
// 1.构造：新增样式 / load-model，挂到原 tile mesh 同一 parent
// 2.渲染：随 tile scene 进出 tiles.group
// 3.销毁：删除样式 / dispose-model（先 removeFromParent）

// apply tile mesh visibility 在 load-model 和应用样式时调用
