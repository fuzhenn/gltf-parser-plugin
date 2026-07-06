import {
  Color,
  Euler,
  type EulerOrder,
  Material,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Vector3,
} from "three";
import { evaluateStyleCondition } from "../appearance";
import {
  resolveShowFeatureIdAttribute,
  resolveStyleConditionFeatureIdAttribute,
} from "../appearance";
import { toColor, type ColorInput } from "../utils/color-input";
import type {
  StyleAppearance,
  StyleCondition,
  StyleConditionInput,
  StyleEulerInput,
  StyleMaterialMaps,
  StyleShowInput,
  StyleVec3Input,
} from "./style-appearance-types";

/** 单个 mesh 在样式应用前的原始 TRS 快照，用于取消样式时复位 */
export type StoredTransform = {
  position: Vector3;
  scale: Vector3;
  rotation: Euler;
};

/**
 * 按 split mesh.uuid 缓存原始材质 / 原始 TRS 的两张表。
 *
 * - 由调用方持有（每个 helper / 每次 setStyle 一份），生命周期与样式应用一致；
 * - 仅在第一次为某个 mesh 应用样式时写入，后续重复应用不会覆盖原始值；
 * - 取消样式时由 {@link restoreMeshAppearanceMaps} 读出并删除条目。
 */
export interface MeshAppearanceMaps {
  originalMaterialByMesh: Map<string, Material>;
  originalTransformByMesh: Map<string, StoredTransform>;
}

/**
 * 给"按引用相等"的函数对象（如 `material` 回调、`mesh` 工厂）发放稳定数字 ID，
 * 让 {@link appearanceGroupKey} 能把"用同一函数"的外观稳定归到同一分组。
 *
 * 用 WeakMap 持有函数引用，避免阻止函数被 GC。
 */
const fnIdentitySeq = new WeakMap<Function, number>();
let fnIdentityNext = 1;

function styleFnIdentity(fn: Function): number {
  let id = fnIdentitySeq.get(fn);
  if (id === undefined) {
    id = fnIdentityNext++;
    fnIdentitySeq.set(fn, id);
  }
  return id;
}

/** 从构件材质提取贴图，供 material 回调使用 */
export function extractStyleMaterialMaps(
  material: Material,
): StyleMaterialMaps {
  const m = material as unknown as Record<string, unknown>;
  const tex = (key: string) => {
    const v = m[key];
    return v &&
      typeof v === "object" &&
      "isTexture" in v &&
      (v as { isTexture?: boolean }).isTexture
      ? (v as import("three").Texture)
      : null;
  };
  return {
    map: tex("map"),
    normalMap: tex("normalMap"),
    metalnessMap: tex("metalnessMap"),
    roughnessMap: tex("roughnessMap"),
    aoMap: tex("aoMap"),
    emissiveMap: tex("emissiveMap"),
  };
}

/**
 * color-only（及 color+opacity）路径的进程级缓存：`hex_op` → 默认 `MeshStandardMaterial`。
 *
 * 同色同透明度多 mesh 共享同一 Material 实例，避免每 mesh `new` 一份。
 */
const defaultColorMaterialCache = new Map<string, MeshStandardMaterial>();

/**
 * `material` 实例 + 同级 `color` / `opacity` 的缓存：原始 Material → (复合 key → 克隆体)。
 *
 * - 克隆是为了**不污染用户传入的 Material 实例**；
 * - 用 `WeakMap` 持有原始 Material 作为外层 key，原始 Material 被 GC 时
 *   缓存条目自动回收，避免内存泄漏。
 */
const colorOverrideMaterialCache = new WeakMap<
  Material,
  Map<string, Material>
>();

function clampOpacity01(o: number): number {
  return Math.max(0, Math.min(1, o));
}

function colorHex(c: ColorInput): number {
  return toColor(c).getHex();
}

function materialHasColor(mat: Material): mat is Material & { color: Color } {
  const c = (mat as unknown as { color?: unknown }).color;
  return c instanceof Color;
}

function materialSupportsOpacity(mat: Material): boolean {
  return typeof (mat as unknown as { opacity?: unknown }).opacity === "number";
}

function overrideMaterialCacheKey(
  colorInput: ColorInput | undefined,
  opacityOverride: number | undefined,
): string {
  const h = colorInput !== undefined ? String(colorHex(colorInput)) : "_";
  const o =
    opacityOverride !== undefined
      ? clampOpacity01(opacityOverride).toFixed(4)
      : "_";
  return `${h},${o}`;
}

function getDefaultColorMaterial(
  c: ColorInput,
  opacity?: number,
): MeshStandardMaterial {
  const hex = colorHex(c);
  const op = opacity != null ? clampOpacity01(opacity) : 1;
  const key = `${hex}_${op}`;
  let m = defaultColorMaterialCache.get(key);
  if (!m) {
    m =
      op < 1
        ? new MeshStandardMaterial({
            color: hex,
            opacity: op,
            transparent: true,
          })
        : new MeshStandardMaterial({ color: hex });
    defaultColorMaterialCache.set(key, m);
  }
  return m;
}

function applyAppearanceOverridesToMaterialInstance(
  mat: Material,
  colorInput: ColorInput | undefined,
  opacityOverride: number | undefined,
): Material {
  const wantColor = colorInput !== undefined;
  const wantOpacity = opacityOverride !== undefined;
  const canColor = wantColor && materialHasColor(mat);
  const canOpacity = wantOpacity && materialSupportsOpacity(mat);
  if (!canColor && !canOpacity) return mat;

  const key = overrideMaterialCacheKey(
    canColor ? colorInput : undefined,
    canOpacity ? opacityOverride : undefined,
  );
  let perMat = colorOverrideMaterialCache.get(mat);
  if (!perMat) {
    perMat = new Map();
    colorOverrideMaterialCache.set(mat, perMat);
  }
  let cloned = perMat.get(key);
  if (!cloned) {
    cloned = mat.clone();
    if (canColor) {
      (cloned as Material & { color: Color }).color.setHex(
        colorHex(colorInput!),
      );
    }
    if (canOpacity) {
      const o = clampOpacity01(opacityOverride!);
      (cloned as Material & { opacity: number }).opacity = o;
      (cloned as Material & { transparent?: boolean }).transparent = o < 1;
    }
    perMat.set(key, cloned);
  }
  return cloned;
}

/**
 * 解析单个 mesh 最终要使用的 Material 实例。
 *
 * `color` / `opacity` 与 `material` 同级；`material` 本身不含内嵌 color/opacity 字段。
 * 带 `color` 的默认材质路径靠 {@link defaultColorMaterialCache} 共享实例；
 * 改写实例材质靠 {@link colorOverrideMaterialCache}。回调返回的材质在提供 `color` /
 * `opacity` 时**直接 mutate**（约定每次返回新实例）。
 */
function resolveStyleMaterial(
  appearance: StyleAppearance,
  originalMaterial: Material,
): Material {
  const colorInput = appearance.color;
  const opacityRaw = appearance.opacity;
  const opacityOverride =
    opacityRaw != null ? clampOpacity01(opacityRaw) : undefined;

  if (appearance.material === undefined) {
    if (colorInput !== undefined) {
      return getDefaultColorMaterial(colorInput, opacityOverride);
    }
    if (opacityOverride !== undefined) {
      return applyAppearanceOverridesToMaterialInstance(
        originalMaterial,
        undefined,
        opacityOverride,
      );
    }
    return originalMaterial;
  }

  if (typeof appearance.material === "function") {
    const mat = appearance.material(extractStyleMaterialMaps(originalMaterial));
    if (colorInput !== undefined && materialHasColor(mat)) {
      mat.color.setHex(colorHex(colorInput));
    }
    if (opacityOverride !== undefined && materialSupportsOpacity(mat)) {
      mat.opacity = opacityOverride;
      mat.transparent = opacityOverride < 1;
    }
    return mat;
  }

  if (colorInput !== undefined || opacityOverride !== undefined) {
    return applyAppearanceOverridesToMaterialInstance(
      appearance.material,
      colorInput,
      opacityOverride,
    );
  }
  return appearance.material;
}

/** 将 Vec3 输入序列化为稳定字符串，仅用作 {@link appearanceGroupKey} 的拼装片段 */
export function vec3Key(v: StyleVec3Input | undefined): string {
  if (v === undefined) return "";
  if (Array.isArray(v)) {
    return `${v[0] ?? 0},${v[1] ?? 0},${v[2] ?? 0}`;
  }
  const p = v as Vector3;
  return `${p.x},${p.y},${p.z}`;
}

/** 同 {@link vec3Key}，但保留 Euler 的 order，以保证不同 order 不会被误合并到同一分组 */
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

/** 将 {@link StyleVec3Input}（Vector3 或 [x,y,z]）写入 target，原地修改 */
export function applyVec3(target: Vector3, input: StyleVec3Input): void {
  if (Array.isArray(input)) {
    target.set(input[0] ?? 0, input[1] ?? 0, input[2] ?? 0);
  } else {
    target.copy(input as Vector3);
  }
}

/** 将 {@link StyleEulerInput}（Euler 或 [x,y,z(,order)]）写入 target，原地修改 */
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

/**
 * 把一个 {@link StyleAppearance} 序列化为分组 key，决定哪些 OID 会被合并到同一个
 * MeshCollector / split mesh 实例中。
 *
 * 包含的字段：material（实例 uuid 或回调身份）、color、opacity、mesh 工厂身份、TRS 与枢轴。
 * 任意一项不同即应分到不同 group，否则它们会共用同一终态 Material/Mesh 实例
 * 造成"后写覆盖前写"。
 *
 * 注意 {@link resolveStyleMaterial} 是按外观逐 mesh 解析的，本 key 只决定"逻辑分组"，
 * Material 实例的真正共享靠 {@link defaultColorMaterialCache} /
 * {@link colorOverrideMaterialCache} 兜底。
 */
export function appearanceGroupKey(a: StyleAppearance): string {
  const m =
    a.material === undefined
      ? "mat:keep"
      : typeof a.material === "function"
        ? `matFn#${styleFnIdentity(a.material)}`
        : a.material.uuid;
  const colorPart = a.color !== undefined ? `|c:${colorHex(a.color)}` : "";
  const opacityPart =
    a.opacity != null ? `|o:${clampOpacity01(a.opacity).toFixed(4)}` : "";
  const meshPart = a.mesh ? `|meshFn#${styleFnIdentity(a.mesh)}` : "";
  const t = vec3Key(a.translation);
  const s = vec3Key(a.scale);
  const r = eulerKey(a.rotation);
  const o = vec3Key(a.origin);
  return `${m}${colorPart}${opacityPart}${meshPart}|${t}|${s}|${r}|${o}`;
}

/**
 * 构建"绕枢轴 pivot 的缩放 + 旋转"矩阵：M = T(p) · R · S · T(-p)。
 *
 * 即先把 pivot 平移到原点应用 S/R，再平移回去——这样不同 mesh 即使坐标各异，
 * 给它们配置相同的 origin（如 mesh 自身中心）就能得到一致的"原地缩放/旋转"效果。
 */
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

/**
 * 顺序评估条件并返回**首个**命中的外观（first-match 语义，专供 `setStyle` 使用）。
 *
 * 若需要"所有命中条件都生效"（如 highlight 的填充 + 线框叠加），调用方应改走
 * `PartHighlightHelper.buildAppearanceGroups` 的 all-match 实现，而非本函数。
 */
export function resolveConditionsAppearance<T>(
  conditions: [StyleConditionInput, T][] | undefined,
  propertyData: Record<string, unknown> | null,
  evaluators?: ReadonlyMap<
    string,
    import("../appearance").StyleConditionEvaluator
  >,
  featureIdAttribute?: number,
): T | null {
  if (!conditions?.length) return null;
  for (const [cond, value] of conditions) {
    if (
      featureIdAttribute !== undefined &&
      resolveStyleConditionFeatureIdAttribute(cond) !== featureIdAttribute
    ) {
      continue;
    }
    if (evaluateStyleCondition(cond, propertyData, evaluators)) {
      return value;
    }
  }
  return null;
}

/**
 * setStyle 的核心分组逻辑：把 feature id → propertyData
 * 经 `show` 过滤、conditions first-match 评估后，按 {@link appearanceGroupKey} 聚合。
 */
export function buildAppearanceGroupsFromPropertyMap(
  propertyMap: Map<number, Record<string, unknown> | null>,
  config: { show?: StyleShowInput; conditions: StyleCondition[] },
  evaluators?: ReadonlyMap<
    string,
    import("../appearance").StyleConditionEvaluator
  >,
  featureIdAttribute = 0,
): {
  hiddenFeatureIdsList: number[];
  groups: Map<string, { appearance: StyleAppearance; featureIds: number[] }>;
} {
  const hiddenFeatureIdsList: number[] = [];
  const groups = new Map<
    string,
    { appearance: StyleAppearance; featureIds: number[] }
  >();
  const conditions = config.conditions ?? [];
  const showForChannel =
    config.show != null &&
    resolveShowFeatureIdAttribute(config.show) === featureIdAttribute
      ? config.show
      : undefined;

  for (const [featureId, propertyData] of propertyMap) {
    if (propertyData == null) continue;
    if (showForChannel) {
      if (!evaluateStyleCondition(showForChannel, propertyData, evaluators)) {
        hiddenFeatureIdsList.push(featureId);
        continue;
      }
    }

    const appearance = resolveConditionsAppearance(
      conditions,
      propertyData,
      evaluators,
      featureIdAttribute,
    );
    if (!appearance) continue;

    const gkey = appearanceGroupKey(appearance);
    let g = groups.get(gkey);
    if (!g) {
      g = { appearance, featureIds: [] };
      groups.set(gkey, g);
    }
    g.featureIds.push(featureId);
  }

  return { hiddenFeatureIdsList, groups };
}

/** 当 `appearance.mesh` 工厂被使用时，把产物 Object3D 暂存到原 mesh 的 userData，便于还原时清理 */
const STYLE_APPEARANCE_BUILT_KEY = "_gltfParserStyleAppearanceBuilt";

/**
 * 从场景图移除样式 split mesh（及 `appearance.mesh` 工厂产物）。
 * 必须在把 `geometry` 置为 `null` 之前调用，否则渲染时 `Frustum.intersectsObject` 会读 `null.boundingSphere` 崩溃。
 */
export function detachStyledMeshFromScene(mesh: Mesh): void {
  const built = mesh.userData?.[STYLE_APPEARANCE_BUILT_KEY] as
    | Object3D
    | undefined;
  if (built) {
    built.removeFromParent();
    delete mesh.userData[STYLE_APPEARANCE_BUILT_KEY];
  }
  mesh.removeFromParent();
}

/**
 * 撤销 {@link applyStyleAppearanceToMesh} 对该 mesh 的所有副作用：
 *
 * 1. 把 material 还原为应用前的原始 Material；
 * 2. 把 position/scale/rotation 还原为快照值；
 * 3. 若曾经使用过 `appearance.mesh` 工厂产生的辅助 Object3D，把它从场景图移除。
 *
 * 还原后会从 {@link MeshAppearanceMaps} 中删除对应条目，可重复调用是幂等的。
 */
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
  const built = mesh.userData?.[STYLE_APPEARANCE_BUILT_KEY] as
    | Object3D
    | undefined;
  if (built) {
    built.removeFromParent();
    delete mesh.userData[STYLE_APPEARANCE_BUILT_KEY];
  }
}

/**
 * 将一个 {@link StyleAppearance} 应用到指定 split mesh。
 *
 * 流程：
 * 1. **快照原始材质**（仅首次），便于后续 {@link restoreMeshAppearanceMaps} 还原；
 * 2. **解析终态 Material**（{@link resolveStyleMaterial}）；
 * 3. 若给定 `appearance.mesh` 工厂：用 (geometry, resolvedMaterial) 生成新的 Object3D
 *    挂到原 mesh 的 userData 上（典型用于线框等叠加体），`mesh` 变量本地切换为该产物
 *    以便后续 transform 应用到产物上；
 * 4. 若需要变换：先把 mesh TRS **复位到原始快照**（保证多次重复应用是等价的，而不是
 *    在上一轮变换上叠加），再依据 origin 做"绕枢轴的 S/R"，最后把 translation 直接覆盖
 *    到 position（translation 语义是绝对位移，不参与枢轴变换）。
 *
 * 注意：本函数与 `StyleHelper.applyAppearanceToCollector` 共享同一套语义，
 * 任何修改需保持两边对齐。
 */
function placeMeshUnderRoot(
  mesh: Mesh,
  root: Object3D,
  worldMatrix: Matrix4,
): void {
  root.updateMatrixWorld(true);
  const inv = new Matrix4().copy(root.matrixWorld).invert();
  mesh.matrix.copy(worldMatrix).premultiply(inv);
  mesh.matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
}

export function applyStyleAppearanceToMesh(
  mesh: Mesh,
  appearance: StyleAppearance,
  scene: Object3D,
  maps: MeshAppearanceMaps,
): void {
  if (!mesh.geometry) return;

  /** split mesh（工厂模式下几何/位姿的锚点） */
  const anchorMesh = mesh;

  if (!maps.originalMaterialByMesh.has(anchorMesh.uuid)) {
    maps.originalMaterialByMesh.set(
      anchorMesh.uuid,
      anchorMesh.material as Material,
    );
  }
  const originalMaterial = maps.originalMaterialByMesh.get(anchorMesh.uuid)!;
  const resolvedMaterial = resolveStyleMaterial(appearance, originalMaterial);

  let renderMesh: Mesh = anchorMesh;

  if (appearance.mesh) {
    anchorMesh.updateMatrixWorld(true);
    const prevBuilt = anchorMesh.userData?.[STYLE_APPEARANCE_BUILT_KEY] as
      | Object3D
      | undefined;
    if (prevBuilt) {
      prevBuilt.removeFromParent();
    }
    const built = appearance.mesh(anchorMesh.geometry, resolvedMaterial);
    anchorMesh.userData[STYLE_APPEARANCE_BUILT_KEY] = built;
    renderMesh = built as unknown as Mesh;
  } else {
    anchorMesh.material = resolvedMaterial;
  }

  const needTransform =
    appearance.translation !== undefined ||
    appearance.scale !== undefined ||
    appearance.rotation !== undefined;

  if (needTransform) {
    const transformKey = renderMesh.uuid;
    if (!maps.originalTransformByMesh.has(transformKey)) {
      maps.originalTransformByMesh.set(transformKey, {
        position: renderMesh.position.clone(),
        scale: renderMesh.scale.clone(),
        rotation: renderMesh.rotation.clone(),
      });
    }
    const bt = maps.originalTransformByMesh.get(transformKey)!;
    renderMesh.position.copy(bt.position);
    renderMesh.scale.copy(bt.scale);
    renderMesh.rotation.copy(bt.rotation);

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
      renderMesh.updateMatrix();
      renderMesh.matrix.multiply(styleM);
      renderMesh.matrix.decompose(
        renderMesh.position,
        renderMesh.quaternion,
        renderMesh.scale,
      );
    }

    if (appearance.translation !== undefined) {
      applyVec3(renderMesh.position, appearance.translation);
    }
  }

  const placementWorld = new Matrix4();
  if (appearance.mesh) {
    anchorMesh.updateMatrixWorld(true);
    renderMesh.updateMatrix();
    placementWorld.multiplyMatrices(anchorMesh.matrixWorld, renderMesh.matrix);
  } else {
    renderMesh.updateMatrixWorld(true);
    placementWorld.copy(renderMesh.matrixWorld);
  }

  placeMeshUnderRoot(renderMesh, scene, placementWorld);
  scene.add(renderMesh);
}
