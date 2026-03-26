import {
  Euler,
  type EulerOrder,
  Material,
  Matrix4,
  Mesh,
  Object3D,
  Vector3,
} from "three";
import { evaluateStyleCondition } from "./style-condition-eval";
import type {
  StyleAppearance,
  StyleCondition,
  StyleEulerInput,
  StyleVec3Input,
} from "./style-appearance-types";

export type StoredTransform = {
  position: Vector3;
  scale: Vector3;
  rotation: Euler;
};

export interface MeshAppearanceMaps {
  originalMaterialByMesh: Map<string, Material>;
  originalTransformByMesh: Map<string, StoredTransform>;
}

export function vec3Key(v: StyleVec3Input | undefined): string {
  if (v === undefined) return "";
  if (Array.isArray(v)) {
    return `${v[0] ?? 0},${v[1] ?? 0},${v[2] ?? 0}`;
  }
  const p = v as Vector3;
  return `${p.x},${p.y},${p.z}`;
}

export function eulerKey(r: StyleEulerInput | undefined): string {
  if (r === undefined) return "";
  if (Array.isArray(r)) {
    const order: EulerOrder =
      r.length >= 4 && typeof r[3] === "string" ? (r[3] as EulerOrder) : "XYZ";
    return `${r[0] ?? 0},${r[1] ?? 0},${r[2] ?? 0},${order}`;
  }
  const e = r as Euler;
  return `${e.x},${e.y},${e.z},${e.order}`;
}

export function applyVec3(target: Vector3, input: StyleVec3Input): void {
  if (Array.isArray(input)) {
    target.set(input[0] ?? 0, input[1] ?? 0, input[2] ?? 0);
  } else {
    target.copy(input as Vector3);
  }
}

export function applyEuler(target: Euler, input: StyleEulerInput): void {
  if (Array.isArray(input)) {
    if (input.length >= 4 && typeof input[3] === "string") {
      target.set(
        input[0] ?? 0,
        input[1] ?? 0,
        input[2] ?? 0,
        input[3] as EulerOrder,
      );
    } else {
      target.set(input[0] ?? 0, input[1] ?? 0, input[2] ?? 0, "XYZ");
    }
  } else {
    target.copy(input as Euler);
  }
}

export function appearanceGroupKey(a: StyleAppearance): string {
  const m = a.material.uuid;
  const t = vec3Key(a.translation);
  const s = vec3Key(a.scale);
  const r = eulerKey(a.rotation);
  const o = vec3Key(a.origin);
  return `${m}|${t}|${s}|${r}|${o}`;
}

export function buildPivotStyleMatrix(
  pivot: Vector3,
  sx: number,
  sy: number,
  sz: number,
  euler: Euler,
): Matrix4 {
  const m = new Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z);
  m.premultiply(new Matrix4().makeScale(sx, sy, sz));
  m.premultiply(new Matrix4().makeRotationFromEuler(euler));
  m.premultiply(new Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z));
  return m;
}

export function resolveConditionsAppearance<T>(
  conditions: [string | boolean, T][] | undefined,
  propertyData: Record<string, unknown> | null,
): T | null {
  if (!conditions?.length) return null;
  for (const [cond, value] of conditions) {
    if (evaluateStyleCondition(cond, propertyData)) {
      return value;
    }
  }
  return null;
}

export function resolveStyleAppearance(
  conditions: StyleCondition[] | undefined,
  propertyData: Record<string, unknown> | null,
): StyleAppearance | null {
  return resolveConditionsAppearance(conditions, propertyData);
}

/** 与 setStyle 相同的 OID 分组逻辑（show + conditions → 外观分组 + 被 show 隐藏的 OID） */
export function buildAppearanceGroupsFromPropertyMap(
  propertyByOid: Map<number, Record<string, unknown> | null>,
  config: { show?: string; conditions: StyleCondition[] },
): {
  hiddenOidsList: number[];
  groups: Map<string, { appearance: StyleAppearance; oids: number[] }>;
} {
  const hiddenOidsList: number[] = [];
  const groups = new Map<
    string,
    { appearance: StyleAppearance; oids: number[] }
  >();
  const conditions = config.conditions ?? [];

  for (const [oid, propertyData] of propertyByOid) {
    if (propertyData == null) continue;
    if (config.show) {
      if (!evaluateStyleCondition(config.show, propertyData)) {
        hiddenOidsList.push(oid);
        continue;
      }
    }

    const appearance = resolveStyleAppearance(conditions, propertyData);
    if (!appearance) continue;

    const gkey = appearanceGroupKey(appearance);
    let g = groups.get(gkey);
    if (!g) {
      g = { appearance, oids: [] };
      groups.set(gkey, g);
    }
    g.oids.push(oid);
  }

  return { hiddenOidsList, groups };
}

export function restoreMeshAppearanceMaps(
  mesh: Mesh,
  maps: MeshAppearanceMaps,
): void {
  const original = maps.originalMaterialByMesh.get(mesh.uuid);
  if (original) {
    mesh.material = original;
    maps.originalMaterialByMesh.delete(mesh.uuid);
  }
  const origT = maps.originalTransformByMesh.get(mesh.uuid);
  if (origT) {
    mesh.position.copy(origT.position);
    mesh.scale.copy(origT.scale);
    mesh.rotation.copy(origT.rotation);
    maps.originalTransformByMesh.delete(mesh.uuid);
  }
}

/**
 * 将 StyleAppearance 应用到 mesh（与 StyleHelper.applyAppearanceToCollector 一致）
 */
export function applyStyleAppearanceToMesh(
  mesh: Mesh,
  appearance: StyleAppearance,
  scene: Object3D,
  maps: MeshAppearanceMaps,
): void {
  if (!maps.originalMaterialByMesh.has(mesh.uuid)) {
    maps.originalMaterialByMesh.set(mesh.uuid, mesh.material as Material);
  }
  mesh.material = appearance.material;

  const needTransform =
    appearance.translation !== undefined ||
    appearance.scale !== undefined ||
    appearance.rotation !== undefined;

  if (needTransform) {
    if (!maps.originalTransformByMesh.has(mesh.uuid)) {
      maps.originalTransformByMesh.set(mesh.uuid, {
        position: mesh.position.clone(),
        scale: mesh.scale.clone(),
        rotation: mesh.rotation.clone(),
      });
    }
    const bt = maps.originalTransformByMesh.get(mesh.uuid)!;
    mesh.position.copy(bt.position);
    mesh.scale.copy(bt.scale);
    mesh.rotation.copy(bt.rotation);

    const hasScaleOrRotation =
      appearance.scale !== undefined || appearance.rotation !== undefined;

    if (hasScaleOrRotation) {
      const pivot = new Vector3();
      if (appearance.origin !== undefined) {
        applyVec3(pivot, appearance.origin);
      } else {
        pivot.set(0, 0, 0);
      }

      let sx = 1;
      let sy = 1;
      let sz = 1;
      if (appearance.scale !== undefined) {
        if (Array.isArray(appearance.scale)) {
          sx = appearance.scale[0] ?? 1;
          sy = appearance.scale[1] ?? 1;
          sz = appearance.scale[2] ?? 1;
        } else {
          const sc = appearance.scale as Vector3;
          sx = sc.x;
          sy = sc.y;
          sz = sc.z;
        }
      }

      const euler = new Euler();
      if (appearance.rotation !== undefined) {
        applyEuler(euler, appearance.rotation);
      } else {
        euler.set(0, 0, 0);
      }

      const styleM = buildPivotStyleMatrix(pivot, sx, sy, sz, euler);
      mesh.updateMatrix();
      mesh.matrix.multiply(styleM);
      mesh.matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
    }

    if (appearance.translation !== undefined) {
      applyVec3(mesh.position, appearance.translation);
    }
  }

  mesh.updateMatrixWorld();
  scene.add(mesh);
}
