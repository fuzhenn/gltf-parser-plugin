import {
  normalizeMeshCollectorOids,
  type MeshCollector,
  type MeshCollectorQuery,
} from "../MeshCollector";
import type { TilesRenderer } from "3d-tiles-renderer";
import { getPropertyDataMapFromTiles } from "../mesh-helper/mesh";
import { evaluateStyleCondition } from "./style-condition-eval";
import {
  Euler,
  type EulerOrder,
  Material,
  Matrix4,
  Object3D,
  Vector3,
} from "three";

/** 与 Vector3 等价：Three 的 Vector3 或长度≥3 的 [x,y,z] 数组 */
export type StyleVec3Input = Vector3 | readonly number[];

/** 与 Euler 等价：Three 的 Euler，或 [x,y,z] / [x,y,z,order] */
export type StyleEulerInput = Euler | readonly number[];

/** 条件命中后的外观：材质必填，位姿可选（未传则不改对应分量） */
export interface StyleAppearance {
  material: Material;
  translation?: StyleVec3Input;
  scale?: StyleVec3Input;
  rotation?: StyleEulerInput;
  /**
   * mesh 局部空间中的枢轴；`scale` / `rotation` 绕该点作用。
   * 未传时等价于 (0,0,0)（几何局部原点）。
   */
  origin?: StyleVec3Input;
}

/** 条件项：[条件表达式或 true, 外观对象] */
export type StyleCondition = [string | boolean, StyleAppearance];

/** 样式配置 */
export interface StyleConfig {
  /** 可见性表达式，仅满足条件的构件显示，如 'foo === bar' */
  show?: string;
  /** 条件样式数组，第一个满足条件的应用对应外观；[true, appearance] 为默认 */
  conditions?: StyleCondition[];
}

/** 内部使用：插件需提供的接口 */
interface StyleHelperContext {
  getTiles(): TilesRenderer | null;
  hidePartsByOids(oids: number[]): void;
  showPartsByOids(oids: number[]): void;
  getMeshCollectorByCondition(query: MeshCollectorQuery): MeshCollector;
  getScene(): Object3D | null;
}

function vec3Key(v: StyleVec3Input | undefined): string {
  if (v === undefined) return "";
  if (Array.isArray(v)) {
    return `${v[0] ?? 0},${v[1] ?? 0},${v[2] ?? 0}`;
  }
  const p = v as Vector3;
  return `${p.x},${p.y},${p.z}`;
}

function eulerKey(r: StyleEulerInput | undefined): string {
  if (r === undefined) return "";
  if (Array.isArray(r)) {
    const order: EulerOrder =
      r.length >= 4 && typeof r[3] === "string" ? (r[3] as EulerOrder) : "XYZ";
    return `${r[0] ?? 0},${r[1] ?? 0},${r[2] ?? 0},${order}`;
  }
  const e = r as Euler;
  return `${e.x},${e.y},${e.z},${e.order}`;
}

function applyVec3(target: Vector3, input: StyleVec3Input): void {
  if (Array.isArray(input)) {
    target.set(input[0] ?? 0, input[1] ?? 0, input[2] ?? 0);
  } else {
    target.copy(input as Vector3);
  }
}

function applyEuler(target: Euler, input: StyleEulerInput): void {
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

function appearanceGroupKey(a: StyleAppearance): string {
  const m = a.material.uuid;
  const t = vec3Key(a.translation);
  const s = vec3Key(a.scale);
  const r = eulerKey(a.rotation);
  const o = vec3Key(a.origin);
  return `${m}|${t}|${s}|${r}|${o}`;
}

/** 局部空间：v' = T(pivot) * R * S * T(-pivot) * v */
function buildPivotStyleMatrix(
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

/**
 * 根据 conditions 和 propertyData 解析出应使用的外观
 */
function resolveStyleAppearance(
  conditions: StyleCondition[],
  propertyData: Record<string, unknown> | null,
): StyleAppearance | null {
  for (const [cond, value] of conditions) {
    if (evaluateStyleCondition(cond, propertyData)) {
      return value;
    }
  }
  return null;
}

type StoredTransform = {
  position: Vector3;
  scale: Vector3;
  rotation: Euler;
};

/**
 * 构件样式辅助器
 * 通过 show 表达式控制可见性，通过 conditions 应用条件材质与可选位姿
 */
export class StyleHelper {
  /** 当前样式配置，可通过 plugin.style 获取 */
  style: StyleConfig | null = null;
  private styledOids = new Set<number>();
  private hiddenOids = new Set<number>();
  private materialByOid = new Map<number, Material>();
  private originalMaterialByMesh = new Map<string, Material>();
  private originalTransformByMesh = new Map<string, StoredTransform>();
  /** 按材质分组后的收集器，key 与 collector.getCacheKey() 一致 */
  private meshChangeHandlers = new Map<string, () => void>();
  /** 当前样式占用的收集器（用于 clearStyle / 下次 applyStyle 前卸载监听） */
  private styleCollectors: MeshCollector[] = [];

  constructor(private context: StyleHelperContext) { }

  /**
   * 设置样式
   * @param style 样式配置，传 null 或空对象清除样式
   */
  setStyle(style: StyleConfig | null): void {
    this.clearStyle();
    this.style = style;

    if (!style || (!style.show && (!style.conditions || style.conditions.length === 0))) {
      return;
    }

    this.applyStyle();
  }

  /**
   * 清除样式，恢复默认显示
   */
  clearStyle(): void {
    const styledOidsList = Array.from(this.styledOids);
    const hiddenOidsList = Array.from(this.hiddenOids);

    for (const collector of this.styleCollectors) {
      collector.meshes.forEach((mesh) => {
        const original = this.originalMaterialByMesh.get(mesh.uuid);
        if (original) {
          mesh.material = original;
          this.originalMaterialByMesh.delete(mesh.uuid);
        }
        const origT = this.originalTransformByMesh.get(mesh.uuid);
        if (origT) {
          mesh.position.copy(origT.position);
          mesh.scale.copy(origT.scale);
          mesh.rotation.copy(origT.rotation);
          this.originalTransformByMesh.delete(mesh.uuid);
        }
        mesh.removeFromParent();
      });

      const handler = this.meshChangeHandlers.get(collector.getCacheKey());
      if (handler) {
        collector.removeEventListener("mesh-change", handler);
      }
    }
    this.meshChangeHandlers.clear();
    this.styleCollectors = [];

    this.style = null;
    this.styledOids.clear();
    this.hiddenOids.clear();
    this.materialByOid.clear();
    this.context.showPartsByOids([...styledOidsList, ...hiddenOidsList]);
  }

  private applyStyle(): void {
    const style = this.style;
    if (!style) return;

    const scene = this.context.getScene();
    if (!scene) return;

    const tiles = this.context.getTiles();
    if (!tiles) return;

    const propertyByOid = getPropertyDataMapFromTiles(tiles);

    for (const collector of this.styleCollectors) {
      const h = this.meshChangeHandlers.get(collector.getCacheKey());
      if (h) collector.removeEventListener("mesh-change", h);
    }
    this.styleCollectors = [];
    this.meshChangeHandlers.clear();

    const hiddenOidsList: number[] = [];
    const groups = new Map<
      string,
      { appearance: StyleAppearance; oids: number[] }
    >();

    const conditions = style.conditions ?? [];

    for (const [oid, propertyData] of propertyByOid) {
      if (style.show) {
        if (!evaluateStyleCondition(style.show, propertyData)) {
          hiddenOidsList.push(oid);
          continue;
        }
      }

      const appearance = resolveStyleAppearance(conditions, propertyData);
      if (!appearance) continue;

      this.styledOids.add(oid);
      this.materialByOid.set(oid, appearance.material);

      const gkey = appearanceGroupKey(appearance);
      let g = groups.get(gkey);
      if (!g) {
        g = { appearance, oids: [] };
        groups.set(gkey, g);
      }
      g.oids.push(oid);
    }

    this.hiddenOids = new Set(hiddenOidsList);
    const oidsToHide = [...hiddenOidsList];
    for (const { oids } of groups.values()) {
      oidsToHide.push(...oids);
    }

    for (const { appearance, oids } of groups.values()) {
      const sortedOids = normalizeMeshCollectorOids(oids);
      const collector = this.context.getMeshCollectorByCondition({
        oids: sortedOids,
      });
      this.applyAppearanceToCollector(collector, appearance, scene);
      this.styleCollectors.push(collector);

      const cacheKey = collector.getCacheKey();
      const handler = () => {
        const s = this.context.getScene();
        if (s) this.applyAppearanceToCollector(collector, appearance, s);
      };
      this.meshChangeHandlers.set(cacheKey, handler);
      collector.addEventListener("mesh-change", handler);
    }

    this.context.hidePartsByOids(oidsToHide);
  }

  /** Split mesh 与瓦片 originalMesh 同父级，避免挂到 tiles.group 导致大地矩阵数值问题 */
  private attachMeshForStyle(fallbackScene: Object3D, mesh: Object3D): void {
    const orig = (mesh.userData as { originalMesh?: Object3D }).originalMesh;
    const parent = orig?.parent ?? fallbackScene;
    if (mesh.parent === parent) return;
    parent.attach(mesh);
  }

  private applyAppearanceToCollector(
    collector: MeshCollector,
    appearance: StyleAppearance,
    scene: Object3D,
  ): void {
    collector.meshes.forEach((mesh) => {
      if (!this.originalMaterialByMesh.has(mesh.uuid)) {
        this.originalMaterialByMesh.set(mesh.uuid, mesh.material as Material);
      }
      mesh.material = appearance.material;

      const needTransform =
        appearance.translation !== undefined ||
        appearance.scale !== undefined ||
        appearance.rotation !== undefined;

      if (needTransform) {
        if (!this.originalTransformByMesh.has(mesh.uuid)) {
          this.originalTransformByMesh.set(mesh.uuid, {
            position: mesh.position.clone(),
            scale: mesh.scale.clone(),
            rotation: mesh.rotation.clone(),
          });
        }
        const bt = this.originalTransformByMesh.get(mesh.uuid)!;
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
    });
  }

  /**
   * 瓦片加载完成后重新应用样式（由插件调用）
   */
  onTilesLoadEnd(): void {
    if (this.style) {
      this.applyStyle();
    }
  }

  dispose(): void {
    this.clearStyle();
  }
}
