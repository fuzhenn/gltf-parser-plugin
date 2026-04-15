import {
  MESH_CACHE_NAMESPACE_HIGHLIGHT,
  normalizeMeshCollectorOids,
  type MeshCollector,
} from "../MeshCollector";
import { getPropertyDataMapFromTiles } from "../mesh-helper/mesh";
import type { StyleCondition } from "./style-appearance-types";
import {
  buildStyleConditionEvaluatorMap,
  evaluateStyleCondition,
} from "./style-condition-eval";
import type { PartEffectHost } from "./part-effect-host";
import type { ColorInput } from "../utils/color-input";
import { toColor } from "../utils/color-input";
import {
  Color,
  Euler,
  Material,
  MeshStandardMaterial,
  Object3D,
  Vector3,
} from "three";
import type {
  StyleAppearance,
  StyleEulerInput,
  StyleMaterialResolver,
  StyleMeshFactory,
  StyleVec3Input,
} from "./style-appearance-types";
import {
  appearanceGroupKey,
  applyEuler,
  applyStyleAppearanceToMesh,
  applyVec3,
  buildPivotStyleMatrix,
  eulerKey,
  resolveConditionsAppearance,
  restoreMeshAppearanceMaps,
  vec3Key,
  type MeshAppearanceMaps,
  type StoredTransform,
} from "./style-appearance-shared";

/** 高亮材质：Three.js Material 或 { color, opacity } */
export type HighlightMaterial = Material | { color?: ColorInput; opacity?: number };

/** 条件命中后的外观：材质可为简写、函数或 Material（可省略）；位姿与 setStyle 一致 */
export interface HighlightAppearance {
  material?: HighlightMaterial | StyleMaterialResolver;
  mesh?: StyleMeshFactory;
  translation?: StyleVec3Input;
  scale?: StyleVec3Input;
  rotation?: StyleEulerInput;
  origin?: StyleVec3Input;
}

export type HighlightCondition = [string | boolean, HighlightAppearance];

/** 高亮配置：语义与 setStyle 一致，并多一个 name 用于命名分组 */
export interface HighlightOptions {
  /** 高亮组名称，用于 cancelHighlight(name) 取消 */
  name: string;
  /** 可见性表达式，仅满足条件的构件参与高亮，如 'foo === bar' */
  show?: string;
  /** 条件外观数组，第一个满足条件的应用对应外观；[true, appearance] 为默认 */
  conditions?: HighlightCondition[];
  /** 若指定，仅在这些 OID 与属性数据的交集中应用（与 conditions 组合） */
  oids?: number[];
}

const highlightMaterialCache = new Map<string, MeshStandardMaterial>();

function getMaterialForHighlight(
  style: { color?: ColorInput; opacity?: number },
): MeshStandardMaterial {
  const color = style.color != null ? toColor(style.color) : new Color(0xffff00);
  const opacity =
    style.opacity != null ? Math.max(0, Math.min(1, style.opacity)) : 1;
  const key = `${color.getHex()}_${opacity}`;

  if (!highlightMaterialCache.has(key)) {
    const mat = new MeshStandardMaterial({
      color: color.clone(),
      roughness: 0.5,
      metalness: 0.1,
      opacity,
      transparent: opacity < 1,
    });
    highlightMaterialCache.set(key, mat);
  }
  return highlightMaterialCache.get(key)!;
}

function toMaterial(value: HighlightMaterial): Material {
  if (value instanceof Material) return value;
  return getMaterialForHighlight(value);
}

function toStyleAppearance(ha: HighlightAppearance): StyleAppearance {
  const mat = ha.material;
  const appearance: StyleAppearance = {
    mesh: ha.mesh,
    translation: ha.translation,
    scale: ha.scale,
    rotation: ha.rotation,
    origin: ha.origin,
  };
  if (mat !== undefined) {
    appearance.material =
      typeof mat === "function"
        ? mat
        : mat instanceof Material
          ? mat
          : toMaterial(mat);
  }
  return appearance;
}

interface HighlightGroupConfig {
  show?: string;
  conditions?: HighlightCondition[];
  oids?: number[];
}

function cloneHighlightOptions(options: HighlightOptions): HighlightOptions {
  return {
    name: options.name,
    show: options.show,
    conditions: options.conditions?.map(
      ([c, h]): HighlightCondition => [c, { ...h }],
    ),
    oids: options.oids?.slice(),
  };
}

function highlightAppearanceNeedsTransform(ha: HighlightAppearance): boolean {
  return (
    ha.translation !== undefined ||
    ha.scale !== undefined ||
    ha.rotation !== undefined
  );
}

function highlightAppearanceTransformKey(ha: HighlightAppearance): string {
  return `${vec3Key(ha.translation)}|${vec3Key(ha.scale)}|${eulerKey(ha.rotation)}|${vec3Key(ha.origin)}`;
}

/**
 * 与 {@link applyStyleAppearanceToMesh} 一致：基准为单位变换时，仅由 TRS 与 origin 枢轴得到的局部矩阵，列主序 16 个数（Three.js `Matrix4.elements` 顺序）。
 */
function localMatrix16FromHighlightAppearance(
  ha: HighlightAppearance,
): number[] | undefined {
  if (!highlightAppearanceNeedsTransform(ha)) return undefined;

  const obj = new Object3D();
  const hasScaleOrRotation =
    ha.scale !== undefined || ha.rotation !== undefined;

  if (hasScaleOrRotation) {
    const pivot = new Vector3();
    if (ha.origin !== undefined) {
      applyVec3(pivot, ha.origin);
    } else {
      pivot.set(0, 0, 0);
    }

    let sx = 1;
    let sy = 1;
    let sz = 1;
    if (ha.scale !== undefined) {
      if (Array.isArray(ha.scale)) {
        sx = ha.scale[0] ?? 1;
        sy = ha.scale[1] ?? 1;
        sz = ha.scale[2] ?? 1;
      } else {
        const sc = ha.scale as Vector3;
        sx = sc.x;
        sy = sc.y;
        sz = sc.z;
      }
    }

    const euler = new Euler();
    if (ha.rotation !== undefined) {
      applyEuler(euler, ha.rotation);
    } else {
      euler.set(0, 0, 0);
    }

    const styleM = buildPivotStyleMatrix(pivot, sx, sy, sz, euler);
    obj.updateMatrix();
    obj.matrix.multiply(styleM);
    obj.matrix.decompose(obj.position, obj.quaternion, obj.scale);
  }

  if (ha.translation !== undefined) {
    applyVec3(obj.position, ha.translation);
  }

  obj.updateMatrix();
  return Array.from(obj.matrix.elements);
}

/**
 * 构件高亮辅助器
 * 与 setStyle 相同的 show / conditions / 位姿语义，多组命名高亮；底层通过 hidePartsByOids + split mesh 实现
 */
export class PartHighlightHelper {
  private highlightGroups = new Map<string, HighlightGroupConfig>();
  /** 最近一次 highlight(name, …) 传入的完整参数，供 getHighlightConfigByName 读取 */
  private highlightConfigByName = new Map<string, HighlightOptions>();

  private originalMaterialByMesh = new Map<string, Material>();
  private originalTransformByMesh = new Map<string, StoredTransform>();
  private meshChangeHandlers = new Map<string, () => void>();
  private highlightCollectors: MeshCollector[] = [];
  /** 上次 hidePartsByOids 传入的 OID 列表，用于重新应用前 showParts */
  private lastHiddenOids: number[] = [];

  constructor(private context: PartEffectHost) {}

  private getMaps(): MeshAppearanceMaps {
    return {
      originalMaterialByMesh: this.originalMaterialByMesh,
      originalTransformByMesh: this.originalTransformByMesh,
    };
  }

  /**
   * 合并多组命名高亮：按 Map 插入顺序，后写入的组覆盖同一 OID 的外观
   */
  private mergeAppearanceByOid(
    propertyByOid: Map<number, Record<string, unknown> | null>,
  ): Map<number, StyleAppearance> {
    const appearanceByOid = new Map<number, StyleAppearance>();
    for (const [, hl] of this.highlightGroups) {
      const evaluators = buildStyleConditionEvaluatorMap({
        show: hl.show,
        conditions: (hl.conditions ?? []) as StyleCondition[],
      });
      const conditions = (hl.conditions ?? []).map(
        ([c, h]): [string | boolean, StyleAppearance] => [
          c,
          toStyleAppearance(h),
        ],
      );
      for (const [oid, propertyData] of propertyByOid) {
        if (propertyData == null) continue;
        if (hl.oids && !hl.oids.includes(oid)) continue;
        if (
          hl.show &&
          !evaluateStyleCondition(hl.show, propertyData, evaluators)
        )
          continue;
        const app = resolveConditionsAppearance(
          conditions,
          propertyData,
          evaluators,
        );
        if (!app) continue;
        appearanceByOid.set(oid, app);
      }
    }
    return appearanceByOid;
  }

  /** 各组 show 失败需隐藏的 OID（与 setStyle 一致：show 不满足则隐藏原片） */
  private collectUnionShowHide(
    propertyByOid: Map<number, Record<string, unknown> | null>,
  ): Set<number> {
    const unionHide = new Set<number>();
    for (const [, hl] of this.highlightGroups) {
      const evaluators = buildStyleConditionEvaluatorMap({
        show: hl.show,
        conditions: (hl.conditions ?? []) as StyleCondition[],
      });
      for (const [oid, propertyData] of propertyByOid) {
        if (propertyData == null) continue;
        if (hl.oids && !hl.oids.includes(oid)) continue;
        if (
          hl.show &&
          !evaluateStyleCondition(hl.show, propertyData, evaluators)
        ) {
          unionHide.add(oid);
        }
      }
    }
    return unionHide;
  }

  private clearCollectorsAndRestoreMeshes(): void {
    const maps = this.getMaps();
    for (const collector of this.highlightCollectors) {
      collector.meshes.forEach((mesh) => {
        restoreMeshAppearanceMaps(mesh, maps);
        mesh.removeFromParent();
      });
      const handler = this.meshChangeHandlers.get(
        collector.getInteractionGroupKey(),
      );
      if (handler) {
        collector.removeEventListener("mesh-change", handler);
      }
      this.context.releaseMeshCollector(collector);
    }
    this.meshChangeHandlers.clear();
    this.highlightCollectors = [];
  }

  private reapplyAll(): void {
    this.clearCollectorsAndRestoreMeshes();

    if (this.lastHiddenOids.length > 0) {
      this.context.showPartsByOids(this.lastHiddenOids);
    }

    if (this.highlightGroups.size === 0) {
      this.lastHiddenOids = [];
      return;
    }

    const tiles = this.context.getTiles();
    const scene = this.context.getRootGroup();
    if (!tiles || !scene) return;

    const propertyByOid = getPropertyDataMapFromTiles(tiles);
    const appearanceByOid = this.mergeAppearanceByOid(propertyByOid);
    const unionHide = this.collectUnionShowHide(propertyByOid);

    const oidsToHide = [
      ...new Set([...appearanceByOid.keys(), ...unionHide]),
    ];
    this.lastHiddenOids = oidsToHide;

    const groups = new Map<
      string,
      { appearance: StyleAppearance; oids: number[] }
    >();
    for (const [oid, app] of appearanceByOid) {
      const gkey = appearanceGroupKey(app);
      let g = groups.get(gkey);
      if (!g) {
        g = { appearance: app, oids: [] };
        groups.set(gkey, g);
      }
      g.oids.push(oid);
    }

    const maps = this.getMaps();

    for (const { appearance, oids } of groups.values()) {
      const sortedOids = normalizeMeshCollectorOids(oids);
      const collector = this.context.getMeshCollectorByCondition({
        oids: sortedOids,
        meshCacheNamespace: MESH_CACHE_NAMESPACE_HIGHLIGHT,
      });
      this.highlightCollectors.push(collector);

      const groupKey = collector.getInteractionGroupKey();
      const handler = () => {
        const s = this.context.getRootGroup();
        if (!s) return;
        collector.meshes.forEach((mesh) => {
          applyStyleAppearanceToMesh(mesh, appearance, s, maps);
        });
      };
      this.meshChangeHandlers.set(groupKey, handler);
      collector.addEventListener("mesh-change", handler);
      handler();
    }

    this.context.hidePartsByOids(oidsToHide);
  }

  /**
   * 高亮指定构件（语义与 setStyle 一致，多 name 参数）
   */
  highlight(options: HighlightOptions): void {
    const { name, show, conditions, oids } = options;
    if (!show && (!conditions || conditions.length === 0)) {
      this.cancelHighlight(name);
      return;
    }

    this.highlightGroups.set(name, { show, conditions, oids });
    this.highlightConfigByName.set(name, cloneHighlightOptions(options));
    this.reapplyAll();
  }

  /**
   * 按名称获取最近一次 highlight 传入的配置（取消高亮后不再可用）
   */
  getHighlightConfigByName(name: string): HighlightOptions | undefined {
    const saved = this.highlightConfigByName.get(name);
    return saved ? cloneHighlightOptions(saved) : undefined;
  }

  /**
   * 按名称从已保存的 highlight 配置中取出位姿矩阵（列主序 16 个数，同 Three.js Matrix4）。
   * 仅当 `conditions` 里所有「含 translation / scale / rotation」的外观其 TRS+origin 完全一致时返回；否则返回 undefined。
   */
  getHighlightMatrixByName(name: string): number[] | undefined {
    const saved = this.highlightConfigByName.get(name);
    if (!saved?.conditions?.length) return undefined;

    let matrix: number[] | undefined;
    let seenKey: string | undefined;

    for (const [, ha] of saved.conditions) {
      if (!highlightAppearanceNeedsTransform(ha)) continue;
      const m = localMatrix16FromHighlightAppearance(ha);
      if (!m) continue;
      const k = highlightAppearanceTransformKey(ha);
      if (seenKey === undefined) {
        seenKey = k;
        matrix = m;
      } else if (seenKey !== k) {
        return undefined;
      }
    }

    return matrix ? matrix.slice() : undefined;
  }

  /**
   * 取消指定名称的高亮
   */
  cancelHighlight(name: string): void {
    this.highlightConfigByName.delete(name);
    if (!this.highlightGroups.has(name)) return;
    this.highlightGroups.delete(name);
    this.reapplyAll();
  }

  /**
   * 取消所有高亮
   */
  cancelAllHighlight(): void {
    this.highlightGroups.clear();
    this.highlightConfigByName.clear();
    this.reapplyAll();
  }

  /**
   * 瓦片加载完成后重新应用高亮（由插件调用）
   */
  onTilesLoadEnd(): void {
    if (this.highlightGroups.size === 0) return;
    this.reapplyAll();
  }

  dispose(): void {
    this.cancelAllHighlight();
  }
}
