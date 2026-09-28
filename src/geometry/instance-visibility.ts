import { InstancedBufferAttribute, InstancedMesh } from "three";
import type { InstanceFeatures } from "../features/types";

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
export function hideMatchedFeaturesOnInstancedMesh(
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

  const kept = new Int32Array(originalCount);
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
