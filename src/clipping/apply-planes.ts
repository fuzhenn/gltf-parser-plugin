import { Material, Mesh, Object3D, Plane } from "three";

/**
 * 对指定 Object3D 子树内所有 mesh 材质写入 clippingPlanes。
 * 幂等：材质当前引用与目标一致时跳过（每帧增量调用时无写入开销）。
 * 剖切面数量变化（null ↔ 数组）会改变 NUM_CLIPPING_PLANES 宏定义，
 * 需 needsUpdate 触发着色器重编译，否则对已渲染材质不生效。
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
        const target = mat as Material;
        if (target.clippingPlanes === planes) continue;
        target.clippingPlanes = planes;
        target.needsUpdate = true;
      }
    }
  });
}
