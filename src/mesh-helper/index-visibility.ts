import { BufferAttribute, BufferGeometry, Mesh, Object3D } from "three";
import type { TilesRenderer } from "3d-tiles-renderer";
import type {
  StyleCondition,
  StyleShowInput,
} from "../plugin/style-appearance-types";
import {
  buildStyleConditionEvaluatorMap,
  evaluateStyleCondition,
} from "../plugin/style-condition-eval";
import {
  resolveShowFeatureIdAttribute,
  resolveStyleConditionFeatureIdAttribute,
} from "../plugin/style-condition-input";
import {
  buildVisibleIndexExcludingHiddenFids,
  forEachLoadedFeatureMesh,
  getPartIdMapForFeatureAttribute,
  getPropertyDataFromMeshUserData,
  resolveFeatureChannelOnMesh,
  type InternalData,
  type PartIdChannel,
} from "./mesh";

/** 在单个 mesh 上按 show / conditions 解析应隐藏的 partId（OID 或 PID） */
export interface MeshPartVisibilityConfig {
  show?: StyleShowInput;
  conditions?: readonly StyleCondition[];
}

/**
 * 根据 mesh.userData、feature 通道与 show/conditions，解析本 mesh 上应隐藏的 partId。
 *
 * @param userData 瓦片 feature mesh 的 userData（需含 idMap/pidMap、meshFeatures、structuralMetadata）
 * @param featureIdAttribute 0 → OID（`_FEATURE_ID_0`），1 → PID（`_FEATURE_ID_1`）
 * @returns 本 mesh 上应隐藏的 OID 或 PID 集合（不含其它 mesh 上的 id）
 */
export function resolveHiddenPartIdsOnMeshUserData(
  userData: Record<string, unknown>,
  featureIdAttribute: number,
  config: MeshPartVisibilityConfig,
  internalData?: InternalData,
): Set<number> {
  const idMap = getPartIdMapForFeatureAttribute(userData, featureIdAttribute);

  if (!idMap) return new Set();

  const hidden = new Set<number>();
  const conditions = config.conditions ?? [];
  const evaluators = buildStyleConditionEvaluatorMap({
    show: config.show,
    conditions: [...conditions],
  });

  const showForChannel =
    config.show != null &&
    resolveShowFeatureIdAttribute(config.show) === featureIdAttribute
      ? config.show
      : undefined;

  const candidateIds = Object.keys(idMap).map(Number);

  for (const partId of candidateIds) {
    const propertyData = getPropertyDataFromMeshUserData(
      userData,
      partId,
      featureIdAttribute,
      internalData,
    );
    if (propertyData == null) continue;

    if (
      showForChannel &&
      !evaluateStyleCondition(showForChannel, propertyData, evaluators)
    ) {
      hidden.add(partId);
      continue;
    }

    for (const [cond] of conditions) {
      if (
        resolveStyleConditionFeatureIdAttribute(cond) !== featureIdAttribute
      ) {
        continue;
      }
      if (evaluateStyleCondition(cond, propertyData, evaluators)) {
        hidden.add(partId);
        break;
      }
    }
  }

  return hidden;
}

/** {@link resolveHiddenPartIdsOnMeshUserData} 的 mesh 便捷封装 */
export function resolveHiddenPartIdsOnMesh(
  mesh: Mesh,
  featureIdAttribute: number,
  config: MeshPartVisibilityConfig,
  internalData?: InternalData,
): Set<number> {
  return resolveHiddenPartIdsOnMeshUserData(
    mesh.userData,
    featureIdAttribute,
    config,
    internalData,
  );
}

const meshPartVisibilityConfigsByAttribute = new Map<
  number,
  MeshPartVisibilityConfig[]
>();
let meshPartVisibilityInternalData: InternalData | undefined;

export function setMeshPartVisibilityInternalData(
  internalData?: InternalData,
): void {
  meshPartVisibilityInternalData = internalData;
}

/** 登记某通道的 show/conditions 规则层，供 applyVisibilityToMesh 在 mesh 内局部解析 */
export function setMeshPartVisibilityConfigs(
  featureIdAttribute: number,
  configs: MeshPartVisibilityConfig[],
): void {
  if (configs.length > 0) {
    meshPartVisibilityConfigsByAttribute.set(featureIdAttribute, configs);
  } else {
    meshPartVisibilityConfigsByAttribute.delete(featureIdAttribute);
  }
}

/** @deprecated 请使用 {@link setMeshPartVisibilityConfigs} */
export function setMeshPartVisibilityConfig(
  featureIdAttribute: number,
  config: MeshPartVisibilityConfig | null,
): void {
  setMeshPartVisibilityConfigs(featureIdAttribute, config ? [config] : []);
}

export function clearMeshPartVisibilityConfigs(): void {
  meshPartVisibilityConfigsByAttribute.clear();
}

function hasMeshPartVisibilityRules(): boolean {
  for (const configs of meshPartVisibilityConfigsByAttribute.values()) {
    for (const cfg of configs) {
      if (cfg.show || cfg.conditions?.length) {
        return true;
      }
    }
  }
  return false;
}

function resolveAllHiddenPartIdsOnMesh(
  mesh: Mesh,
  featureIdAttribute: number,
): Set<number> {
  const configs =
    meshPartVisibilityConfigsByAttribute.get(featureIdAttribute) ?? [];
  if (configs.length === 0) return new Set();

  const hidden = new Set<number>();
  for (const config of configs) {
    for (const partId of resolveHiddenPartIdsOnMesh(
      mesh,
      featureIdAttribute,
      config,
      meshPartVisibilityInternalData,
    )) {
      hidden.add(partId);
    }
  }
  return hidden;
}

/** 与 split / 高亮一致：仅改 meshFeatures.geometry（若无则用 mesh.geometry） */
function getVisibilityGeometry(mesh: Mesh): BufferGeometry | null {
  const { meshFeatures } = mesh.userData;
  const g = meshFeatures?.geometry ?? mesh.geometry;
  return g ?? null;
}

function getHiddenFeatureIdsForChannel(
  mesh: Mesh,
  hiddenIds: Set<number>,
  channel: PartIdChannel,
): Set<number> {
  const mapKey = channel === "oid" ? "idMap" : "pidMap";
  const idMap = mesh.userData?.[mapKey] as Record<number, number> | undefined;
  if (!idMap) return new Set();

  const hidden = new Set<number>();
  for (const partId of hiddenIds) {
    const fid = idMap[partId];
    if (fid !== undefined) hidden.add(fid);
  }
  return hidden;
}

function isTileFeatureSourceMesh(mesh: Mesh): boolean {
  return Boolean(
    mesh.userData?.meshFeatures &&
    mesh.userData?.structuralMetadata &&
    !mesh.userData?.isSplit,
  );
}

function setGeometryIndexFromArray(
  geometry: BufferGeometry,
  indexArray: Uint16Array | Uint32Array,
): void {
  geometry.setIndex(new BufferAttribute(indexArray, 1));
  geometry.index!.needsUpdate = true;
}

/** OID + PID 同时隐藏时，同一 oid fid 块内可能含不同 pid fid，需逐三角过滤 */
function buildVisibleIndexExcludingMultiChannelHiddenFids(
  sourceIndex: Uint16Array | Uint32Array,
  checks: Array<{
    featureIdAttr: { getX(index: number): number };
    hiddenFids: Set<number>;
  }>,
): Uint16Array | Uint32Array {
  const filtered =
    sourceIndex instanceof Uint32Array
      ? new Uint32Array(sourceIndex.length)
      : new Uint16Array(sourceIndex.length);

  let writeOffset = 0;
  for (let i = 0; i < sourceIndex.length; i += 3) {
    const vertexIndex = sourceIndex[i]!;
    let hide = false;
    for (const { featureIdAttr, hiddenFids } of checks) {
      if (hiddenFids.has(featureIdAttr.getX(vertexIndex))) {
        hide = true;
        break;
      }
    }
    if (hide) continue;

    filtered.set(sourceIndex.subarray(i, i + 3), writeOffset);
    writeOffset += 3;
  }

  return filtered.subarray(0, writeOffset);
}

/**
 * 对当前已加载的所有瓦片 feature mesh 应用显隐（按 mesh.uuid 去重）。
 * 同时遍历 tiles.group 与各 tile.engineData.scene。
 */
export function applyVisibilityToAllLoadedMeshes(tiles: TilesRenderer): void {
  if (!hasMeshPartVisibilityRules()) {
    forEachLoadedFeatureMesh(tiles, (mesh) => restoreMeshIndex(mesh));
    return;
  }

  forEachLoadedFeatureMesh(tiles, (mesh) => {
    if (isTileFeatureSourceMesh(mesh)) {
      applyVisibilityToMesh(mesh);
    }
  });
}

/** 对单个 mesh 应用可见性过滤（通过修改 index 排除隐藏的三角形） */
export function applyVisibilityToMesh(mesh: Mesh): void {
  const { meshFeatures } = mesh.userData;
  if (!meshFeatures?.featureIds?.length) return;

  const geometry = getVisibilityGeometry(mesh);
  if (!geometry) return;

  const hiddenOids = resolveAllHiddenPartIdsOnMesh(mesh, 0);
  const hiddenPids = resolveAllHiddenPartIdsOnMesh(mesh, 1);

  if (hiddenOids.size === 0 && hiddenPids.size === 0) {
    restoreMeshIndex(mesh);
    return;
  }

  const oidResolved =
    hiddenOids.size > 0 ? resolveFeatureChannelOnMesh(mesh, "oid") : null;
  const pidResolved =
    hiddenPids.size > 0 ? resolveFeatureChannelOnMesh(mesh, "pid") : null;

  const oidFeatureAttr = oidResolved?.featureIdAttr ?? null;
  const pidFeatureAttr = pidResolved?.featureIdAttr ?? null;

  const index = geometry.index;

  if (!index) return;

  const hiddenOidFids = getHiddenFeatureIdsForChannel(mesh, hiddenOids, "oid");
  const hiddenPidFids = getHiddenFeatureIdsForChannel(mesh, hiddenPids, "pid");

  const needsOidHide =
    hiddenOids.size > 0 && hiddenOidFids.size > 0 && oidFeatureAttr;
  const needsPidHide =
    hiddenPids.size > 0 && hiddenPidFids.size > 0 && pidFeatureAttr;

  if (!needsOidHide && !needsPidHide) {
    restoreMeshIndex(mesh);
    return;
  }

  if (!mesh.userData._originalIndex) {
    const src = index.array;
    mesh.userData._originalIndex =
      src instanceof Uint32Array
        ? new Uint32Array(src)
        : src instanceof Uint16Array
          ? new Uint16Array(src)
          : new Uint32Array(Array.from(src));
  }
  const originalArray = mesh.userData._originalIndex;

  let filteredArray: Uint16Array | Uint32Array;
  if (needsOidHide && needsPidHide) {
    filteredArray = buildVisibleIndexExcludingMultiChannelHiddenFids(
      originalArray,
      [
        { featureIdAttr: oidFeatureAttr!, hiddenFids: hiddenOidFids },
        { featureIdAttr: pidFeatureAttr!, hiddenFids: hiddenPidFids },
      ],
    );
  } else if (needsOidHide) {
    filteredArray = buildVisibleIndexExcludingHiddenFids(
      mesh,
      originalArray,
      oidFeatureAttr!,
      hiddenOidFids,
    );
  } else {
    filteredArray = buildVisibleIndexExcludingHiddenFids(
      mesh,
      originalArray,
      pidFeatureAttr!,
      hiddenPidFids,
    );
  }

  setGeometryIndexFromArray(geometry, filteredArray);
}

/** 恢复 mesh 的原始 index */
export function restoreMeshIndex(mesh: Mesh): void {
  const original = mesh.userData?._originalIndex;
  if (!original) return;

  const geometry = getVisibilityGeometry(mesh);
  if (!geometry) return;

  setGeometryIndexFromArray(geometry, original);
  delete mesh.userData._originalIndex;
}

/** 遍历 scene 子树中所有 tile mesh，应用可见性过滤 */
export function applyVisibilityToScene(scene: Object3D): void {
  if (!hasMeshPartVisibilityRules()) {
    scene.traverse((obj) => {
      const mesh = obj as Mesh;
      if (mesh.userData?.meshFeatures && !mesh.userData?.isSplit) {
        restoreMeshIndex(mesh);
      }
    });
    return;
  }

  scene.traverse((obj) => {
    const mesh = obj as Mesh;
    if (isTileFeatureSourceMesh(mesh)) {
      applyVisibilityToMesh(mesh);
    }
  });
}
