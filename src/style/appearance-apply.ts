import { BufferGeometry, Euler, Material, Mesh, Vector3 } from "three";
import type { StyleAppearance } from "./appearance";
import {
  applyEuler,
  applyStyleColorOpacity,
  applyVec3,
  buildPivotStyleMatrix,
  resolveStyleMaterial,
} from "./material-resolver";

/**
 * 把完整的 {@link StyleAppearance} 应用到 split mesh（由 MeshCollector 在创建
 * split mesh 后一次性调用；split mesh 走缓存复用，不存在重复叠加变换的问题）。
 *
 * - material：经 {@link resolveStyleMaterial} 解析独享材质（构建时仅此一次），
 *   color/opacity 随即由 {@link applyStyleColorOpacity} 原地写入；后续拖动更新
 *   由 MeshCollector 的快速路径/getSplitMeshes 直接原地写，不再走本函数；
 * - mesh 工厂：按 {@link StyleMeshFactory} 约定把返回 Mesh 的 geometry / material
 *   写回当前 split mesh（uuid 不变），被替换的原 split geometry 随之释放；
 * - translation / scale / rotation / origin：split mesh 创建后 TRS 为初始态，
 *   按 origin 做"绕枢轴的 S/R"后 decompose 回 TRS，translation 直接覆盖 position。
 */
export function applyStyleAppearanceToSplitMesh(
  geometry: BufferGeometry,
  material: Material,
  appearance: StyleAppearance,
  _materialBuilder?: unknown,
): Mesh | null {
  const resolvedMaterial = resolveStyleMaterial(appearance, material);
  applyStyleColorOpacity(resolvedMaterial, appearance);

  const mesh = appearance.mesh
    ? appearance.mesh(geometry, resolvedMaterial)
    : new Mesh(geometry, resolvedMaterial);

  const needTransform =
    appearance.translation !== undefined ||
    appearance.scale !== undefined ||
    appearance.rotation !== undefined;
  if (!needTransform) return mesh;

  const hasScaleOrRotation =
    appearance.scale !== undefined || appearance.rotation !== undefined;

  if (hasScaleOrRotation) {
    const pivot = new Vector3();
    if (appearance.origin !== undefined) {
      applyVec3(pivot, appearance.origin);
    }

    const s = appearance.scale;
    const [sx, sy, sz] = s instanceof Vector3
      ? [s.x, s.y, s.z]
      : [s?.[0] ?? 1, s?.[1] ?? 1, s?.[2] ?? 1];

    const euler = new Euler();
    if (appearance.rotation !== undefined) {
      applyEuler(euler, appearance.rotation);
    }

    const styleM = buildPivotStyleMatrix(pivot, sx, sy, sz, euler);
    mesh.updateMatrix();
    mesh.matrix.multiply(styleM);
    mesh.matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
  }

  if (appearance.translation !== undefined) {
    applyVec3(mesh.position, appearance.translation);
  }

  return mesh;
}
