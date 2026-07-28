import { Material, Mesh, Object3D, Plane } from "three";

/**
 * 对指定 Object3D 子树内所有 mesh 材质写入 clippingPlanes。
 */
export function applyClippingPlanesToObject3D(
  root: Object3D,
  planes: Plane[] | null,
): void {
  root.traverse((obj) => {
    if (!(obj instanceof Mesh)) return;
    const materials = Array.isArray(obj.material)
      ? obj.material
      : [obj.material];
    for (const mat of materials) {
      if (mat && "clippingPlanes" in mat) {
        (mat as Material).clippingPlanes = planes;
      }
    }
  });
}
