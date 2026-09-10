import {
  BufferAttribute,
  BufferGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  Mesh,
  Object3D,
} from "three";
import { MeshCollector } from "./MeshCollector";
import { buildSplitCacheKey, collectTileMeshesFromScene } from "./utils";
import { StyleConfig } from "../plugin/style-appearance-types";
import type { MaterialBuilder } from "../types";
import type { InstanceFeatures } from "../mesh/types";
import {
  buildVisibleIndex,
  isTileInstancedMesh,
  isTileMesh,
  snapshotOriginalIndex,
} from "../mesh-helper";

export class StyleHelper {
  style: StyleConfig | null = null;
  private readonly _collectors = new Map<string, MeshCollector>();
  private readonly _materialBuilder?: MaterialBuilder;

  constructor(materialBuilder?: MaterialBuilder) {
    this._materialBuilder = materialBuilder;
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
        // InstancedMesh 的隐藏 = 压缩可见 instance，与普通 mesh 的 index 过滤不同路径
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

// ---------- InstancedMesh 显隐 ----------

let scratchKeptInstanceIndices: Int32Array | undefined;

/** instanced 显隐的实例化 feature 通道；pid(1) 需声明第二个 featureIds 通道才可解析 */
function resolveInstanceFeatureIndex(
  instanceFeatures: InstanceFeatures,
  featureIdAttribute: number,
): number | null {
  if (featureIdAttribute === 0) return 0;
  return instanceFeatures.featureIds.length > 1 ? 1 : null;
}

/** 引用快照：过滤只通过替换 instanceMatrix / instanceColor 属性对象进行，不改写原数组 */
function snapshotInstancedVisibility(mesh: InstancedMesh): void {
  if (
    mesh.userData._originalInstanceMatrix instanceof InstancedBufferAttribute
  ) {
    return;
  }
  mesh.userData._originalInstanceMatrix = mesh.instanceMatrix;
  mesh.userData._originalInstanceCount = mesh.count;
  if (mesh.instanceColor) {
    mesh.userData._originalInstanceColor = mesh.instanceColor;
  }
}

function restoreInstancedVisibility(mesh: InstancedMesh): void {
  const original = mesh.userData._originalInstanceMatrix;
  if (!(original instanceof InstancedBufferAttribute)) return;
  if (mesh.instanceMatrix === original) return;
  mesh.instanceMatrix = original;
  mesh.count = mesh.userData._originalInstanceCount as number;
  const originalColor = mesh.userData._originalInstanceColor;
  if (
    originalColor instanceof InstancedBufferAttribute &&
    mesh.instanceColor !== originalColor
  ) {
    mesh.instanceColor = originalColor;
  }
}

/**
 * InstancedMesh 的按 feature 隐藏：把可见 instance 的矩阵（及 instanceColor）压缩进
 * 新属性对象并下调 count，被隐藏的 instance 不再参与绘制。
 * 始终从原始快照出发重建，重复调用与恢复语义幂等。
 */
function hideMatchedFeaturesOnInstancedMesh(
  mesh: InstancedMesh,
  featureIdAttribute: number | undefined,
  hiddenFids: Set<number>,
): void {
  snapshotInstancedVisibility(mesh);

  const instanceFeatures = mesh.userData.instanceFeatures as
    | InstanceFeatures
    | undefined;
  if (!instanceFeatures || featureIdAttribute === undefined) {
    restoreInstancedVisibility(mesh);
    return;
  }
  const featureIndex = resolveInstanceFeatureIndex(
    instanceFeatures,
    featureIdAttribute,
  );

  if (featureIndex === null || hiddenFids.size === 0) {
    restoreInstancedVisibility(mesh);
    return;
  }

  const originalMatrix = mesh.userData
    ._originalInstanceMatrix as InstancedBufferAttribute;
  const originalCount = mesh.userData._originalInstanceCount as number;
  const source = originalMatrix.array as Float32Array;

  if (
    !scratchKeptInstanceIndices ||
    scratchKeptInstanceIndices.length < originalCount
  ) {
    scratchKeptInstanceIndices = new Int32Array(originalCount);
  }
  const kept = scratchKeptInstanceIndices;
  let visibleCount = 0;
  for (let i = 0; i < originalCount; i++) {
    if (!hiddenFids.has(instanceFeatures.getFeatureId(featureIndex, i))) {
      kept[visibleCount++] = i;
    }
  }

  if (visibleCount === originalCount) {
    restoreInstancedVisibility(mesh);
    return;
  }

  const matrixAttr = new InstancedBufferAttribute(
    new Float32Array(visibleCount * 16),
    16,
  );
  const dst = matrixAttr.array as Float32Array;
  for (let j = 0; j < visibleCount; j++) {
    const srcOffset = kept[j]! * 16;
    dst.set(source.subarray(srcOffset, srcOffset + 16), j * 16);
  }

  // instanceColor 语义是「instance 下标 → 颜色」，必须与矩阵同步压缩，否则颜色错位
  const originalColor = mesh.userData._originalInstanceColor;
  if (originalColor instanceof InstancedBufferAttribute) {
    const itemSize = originalColor.itemSize;
    const srcColor = originalColor.array as Float32Array;
    const colorAttr = new InstancedBufferAttribute(
      new Float32Array(visibleCount * itemSize),
      itemSize,
    );
    const dstColor = colorAttr.array as Float32Array;
    for (let j = 0; j < visibleCount; j++) {
      const srcOffset = kept[j]! * itemSize;
      dstColor.set(
        srcColor.subarray(srcOffset, srcOffset + itemSize),
        j * itemSize,
      );
    }
    mesh.instanceColor = colorAttr;
  }

  mesh.instanceMatrix = matrixAttr;
  mesh.count = visibleCount;
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
