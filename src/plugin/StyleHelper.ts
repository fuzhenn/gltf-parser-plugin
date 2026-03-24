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
  return `${m}|${t}|${s}|${r}`;
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
    const scene = this.context.getScene();
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
        if (scene && mesh.parent === scene) scene.remove(mesh);
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
        if (appearance.translation !== undefined) {
          applyVec3(mesh.position, appearance.translation);
        }
        if (appearance.scale !== undefined) {
          // applyVec3(mesh.scale, appearance.scale);
          mesh.scale.set(100, 100, 100)
          mesh.updateMatrix();
          mesh.updateMatrixWorld();
          // mesh.matrixWorldNeedsUpdate  = true;
        }
        if (appearance.rotation !== undefined) {
          applyEuler(mesh.rotation, appearance.rotation);
        }
      }

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
