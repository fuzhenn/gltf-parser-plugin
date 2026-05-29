import {
  BufferAttribute,
  BufferGeometry,
  Material,
  Mesh,
  Object3D,
  Texture,
} from "three";

import { TilesRenderer } from "3d-tiles-renderer";

/**
 * split 必须从「隐藏原片前」的完整 index 抽取三角形。
 * `hidePartsByOids` 会改写 `geometry.index`；若用当前 index，被高亮 OID 的三角已被删掉 → split 为空。
 */
/** 完整 index（优先 userData 备份），供 split / hide 使用 */
export function getFeatureSplitSourceIndex(
  tileMesh: Mesh,
  geometry: BufferGeometry,
): ArrayLike<number> | null {
  const stored = (tileMesh.userData as { _originalIndex?: ArrayLike<number> })
    ._originalIndex;
  if (stored && stored.length > 0) return stored;
  return geometry.index?.array ?? null;
}

/** 首次隐藏前拷贝完整 index，避免在已过滤的 index 上备份 */
export function snapshotOriginalIndexForMesh(
  mesh: Mesh,
  geometry: BufferGeometry,
): Uint16Array | Uint32Array | null {
  const src = getFeatureSplitSourceIndex(mesh, geometry);
  if (!src || src.length === 0) return null;
  if (src instanceof Uint32Array) return new Uint32Array(src);
  if (src instanceof Uint16Array) return new Uint16Array(src);
  return new Uint32Array(Array.from(src));
}

export function triangleMatchesFeatureIdSet(
  fa: number,
  fb: number,
  fc: number,
  targetFids: Set<number>,
  strict: boolean,
): boolean {
  return strict
    ? fa === fb && fa === fc && targetFids.has(fa)
    : targetFids.has(fa) || targetFids.has(fb) || targetFids.has(fc);
}

/** 与 buildMergedSplitGeometryForTileMesh 一致：有 strict 三角则 strict，否则 loose */
export function resolveHideUsesLooseMode(
  sourceIndex: ArrayLike<number>,
  featureIdAttr: { getX(index: number): number },
  targetFids: Set<number>,
): boolean {
  for (let i = 0; i < sourceIndex.length; i += 3) {
    const a = sourceIndex[i]!;
    const b = sourceIndex[i + 1]!;
    const c = sourceIndex[i + 2]!;
    const fa = featureIdAttr.getX(a);
    const fb = featureIdAttr.getX(b);
    const fc = featureIdAttr.getX(c);
    if (triangleMatchesFeatureIdSet(fa, fb, fc, targetFids, true)) {
      return false;
    }
  }
  return true;
}

/**
 * 合并多个 feature 的三角形为单一 BufferGeometry（共享顶点属性，index 为并集）
 * @param strict true：三顶点 feature id 相同；false：任一顶点命中（细化 LOD 回退）
 */
function createGeometryForFeatureIdSet(
  originalGeometry: BufferGeometry,
  featureIdAttr: BufferAttribute,
  targetFids: Set<number>,
  sourceIndex: ArrayLike<number>,
  strict: boolean,
): BufferGeometry | null {
  if (targetFids.size === 0 || sourceIndex.length === 0) {
    return null;
  }

  const newGeometry = new BufferGeometry();
  const attributes = originalGeometry.attributes;
  for (const attributeName in attributes) {
    newGeometry.setAttribute(attributeName, attributes[attributeName]);
  }

  const newIndices: number[] = [];

  for (let i = 0; i < sourceIndex.length; i += 3) {
    const a = sourceIndex[i]!;
    const b = sourceIndex[i + 1]!;
    const c = sourceIndex[i + 2]!;
    const fa = featureIdAttr.getX(a);
    const fb = featureIdAttr.getX(b);
    const fc = featureIdAttr.getX(c);
    if (triangleMatchesFeatureIdSet(fa, fb, fc, targetFids, strict)) {
      newIndices.push(a, b, c);
    }
  }

  if (newIndices.length === 0) {
    return null;
  }

  newGeometry.setIndex(newIndices);
  return newGeometry;
}

/**
 * 仅构建合并后的 split 几何（与瓦片共享顶点属性 + 独立 index），供多路 Mesh 复用。
 */
export function buildMergedSplitGeometryForTileMesh(
  originalMesh: Mesh,
  oidSet: ReadonlySet<number>,
): BufferGeometry | null {
  if (oidSet.size === 0) return null;

  const idMap = originalMesh.userData?.idMap as
    | Record<number, number>
    | undefined;
  if (!idMap) return null;

  const { meshFeatures } = originalMesh.userData;
  const { geometry, featureIds } = meshFeatures;
  const featureId = featureIds[0];
  const featureIdAttr = geometry.getAttribute(
    `_feature_id_${featureId.attribute}`,
  );

  if (!featureIdAttr) {
    console.warn("No feature ID attribute found");
    return null;
  }

  const targetFids = new Set<number>();
  for (const oid of oidSet) {
    const fid = idMap[oid];
    if (fid !== undefined) {
      targetFids.add(fid);
    }
  }

  if (targetFids.size === 0) return null;

  const sourceIndex = getFeatureSplitSourceIndex(originalMesh, geometry);
  if (!sourceIndex) return null;

  let newGeometry = createGeometryForFeatureIdSet(
    geometry,
    featureIdAttr,
    targetFids,
    sourceIndex,
    true,
  );
  if (!newGeometry) {
    newGeometry = createGeometryForFeatureIdSet(
      geometry,
      featureIdAttr,
      targetFids,
      sourceIndex,
      false,
    );
  }

  if (!newGeometry || newGeometry.attributes.position.count === 0) {
    return null;
  }

  return newGeometry;
}

/**
 * 同一 OID 在父子 LOD 瓦片上常会同时存在。若对每个瓦片各建一层 split 高亮，
 * 半透明材质会叠加，视觉上比单层更「实」。对共享 OID 只保留三角形更多的瓦片。
 */
export function selectDominantTileMeshesForOidSet(
  candidateTiles: Iterable<Mesh>,
  oidSet: ReadonlySet<number>,
): Mesh[] {
  type TileEntry = { mesh: Mesh; triCount: number; oids: Set<number> };
  const entries: TileEntry[] = [];

  for (const tileMesh of candidateTiles) {
    const idMap = tileMesh.userData?.idMap as
      | Record<number, number>
      | undefined;
    if (!idMap) continue;

    const oidsOnMesh = new Set<number>();
    for (const oid of oidSet) {
      if (idMap[oid] !== undefined) oidsOnMesh.add(oid);
    }
    if (oidsOnMesh.size === 0) continue;

    const probe = buildMergedSplitGeometryForTileMesh(tileMesh, oidSet);
    if (!probe) continue;
    const triCount = probe.index?.count ?? 0;
    disposeMergedSplitGeometryCacheEntry(probe, tileMesh);
    if (triCount === 0) continue;

    entries.push({ mesh: tileMesh, triCount, oids: oidsOnMesh });
  }

  entries.sort((a, b) => b.triCount - a.triCount);

  const selected: TileEntry[] = [];
  for (const entry of entries) {
    let dominated = false;
    for (let i = selected.length - 1; i >= 0; i--) {
      const kept = selected[i]!;
      const sharesOid = [...entry.oids].some((oid) => kept.oids.has(oid));
      if (!sharesOid) continue;

      if (entry.triCount > kept.triCount) {
        selected.splice(i, 1);
      } else {
        dominated = true;
        break;
      }
    }
    if (!dominated) selected.push(entry);
  }

  return selected.map((e) => e.mesh);
}

/**
 * 由已构建的 split 几何创建 Mesh（独立材质）；可选标记由全局几何缓存托管，dispose 时不释放几何缓冲。
 */
export function createMergedSplitMeshFromGeometry(
  originalMesh: Mesh,
  newGeometry: BufferGeometry,
  oidSet: ReadonlySet<number>,
  options?: { splitGeometryManagedByCache?: boolean },
): Mesh | null {
  if (oidSet.size === 0) return null;

  const idMap = originalMesh.userData?.idMap as
    | Record<number, number>
    | undefined;
  if (!idMap) return null;

  const { meshFeatures, structuralMetadata } = originalMesh.userData;
  const { featureIds } = meshFeatures;
  const featureId = featureIds[0];

  const oidsOnMesh: number[] = [];
  for (const oid of oidSet) {
    if (idMap[oid] !== undefined) {
      oidsOnMesh.push(oid);
    }
  }
  oidsOnMesh.sort((a, b) => a - b);
  if (oidsOnMesh.length === 0) return null;
  const primaryOid = oidsOnMesh[0]!;

  const newMaterial = (originalMesh.material as Material).clone();
  const newMesh = new Mesh(newGeometry, newMaterial);
  newMesh.parent = originalMesh.parent;
  newMesh.position.copy(originalMesh.position);
  newMesh.rotation.copy(originalMesh.rotation);
  newMesh.scale.copy(originalMesh.scale);
  newMesh.matrixWorld.copy(originalMesh.matrixWorld);

  let propertyData: unknown = null;
  if (structuralMetadata && idMap[primaryOid] !== undefined) {
    try {
      propertyData = structuralMetadata.getPropertyTableData(
        featureId.propertyTable,
        idMap[primaryOid]!,
      );
    } catch {
      // ignore
    }
  }

  const userData: Record<string, unknown> = {
    ...originalMesh.userData,
    featureId: idMap[primaryOid],
    oid: primaryOid,
    collectorOids: oidsOnMesh,
    originalMesh: originalMesh,
    propertyData,
    isSplit: true,
    isMergedSplit: true,
  };
  if (options?.splitGeometryManagedByCache) {
    userData.splitGeometryManagedByCache = true;
  }
  newMesh.userData = userData;

  newMesh.name = `merged_features_${oidsOnMesh.length}_${primaryOid}`;
  return newMesh;
}

/**
 * 将同一瓦片 mesh 内、属于给定 OID 集合的所有 feature 合并为 **单个** Mesh（每瓦片最多一个）
 */
export function splitMeshByOidsMerged(
  originalMesh: Mesh,
  oidSet: ReadonlySet<number>,
): Mesh | null {
  const geom = buildMergedSplitGeometryForTileMesh(originalMesh, oidSet);
  if (!geom) return null;
  return createMergedSplitMeshFromGeometry(originalMesh, geom, oidSet);
}

/** 与贴图/环境等相关的材质字段（与瓦片共用同一引用时不能 dispose 材质） */
const TEXTURE_LIKE_MATERIAL_KEYS: readonly string[] = [
  "map",
  "lightMap",
  "bumpMap",
  "normalMap",
  "specularMap",
  "envMap",
  "alphaMap",
  "aoMap",
  "displacementMap",
  "emissiveMap",
  "gradientMap",
  "metalnessMap",
  "roughnessMap",
  "clearcoatNormalMap",
  "transmissionMap",
  "thicknessMap",
  "sheenColorMap",
  "specularIntensityMap",
  "anisotropyMap",
  "iridescenceMap",
  "iridescenceThicknessMap",
];

function getMeshMaterials(mesh: Mesh | undefined): Material[] {
  if (!mesh?.material) return [];
  const m = mesh.material;
  return Array.isArray(m) ? m : [m];
}

/**
 * 释放 clone 材质：与瓦片同引用的贴图只 detach，不 dispose；否则 dispose 贴图。
 * 最后 `material.dispose()` 释放着色器程序等；共享贴图已置空，避免误伤瓦片。
 */
function disposeSplitMaterialVsTile(
  mat: Material,
  tileMat: Material | undefined,
): void {
  const ra = mat as unknown as Record<string, unknown>;
  const rb = (tileMat ?? null) as unknown as Record<string, unknown> | null;

  for (const key of TEXTURE_LIKE_MATERIAL_KEYS) {
    const va = ra[key];
    if (va == null) continue;
    const vb = rb?.[key];
    const shared = vb != null && va === vb;
    if (shared) {
      ra[key] = null;
    } else {
      (va as Texture).dispose();
      ra[key] = null;
    }
  }
  mat.dispose();
}

/** 合并 split 与 buildMergedSplitGeometryForTileMesh 的来源一致，可能与 mesh.geometry 非同一引用 */
function getGeometrySourcesForTileFeatureMesh(
  tileMesh: Mesh,
): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  const gMesh = tileMesh.geometry as BufferGeometry | undefined;
  if (gMesh) out.push(gMesh);
  const mf = tileMesh.userData?.meshFeatures as
    | { geometry?: BufferGeometry }
    | undefined;
  const gMf = mf?.geometry;
  if (gMf && gMf !== gMesh) out.push(gMf);
  return out;
}

function splitIndexIsSharedWithAnySource(
  splitGeom: BufferGeometry,
  sources: BufferGeometry[],
): boolean {
  const idx = splitGeom.index;
  if (!idx) return false;
  for (const src of sources) {
    if (src.index && idx === src.index) return true;
  }
  return false;
}

function attributeIsSharedWithAnySource(
  splitGeom: BufferGeometry,
  sources: BufferGeometry[],
  name: string,
): boolean {
  const a = splitGeom.getAttribute(name);
  if (!a) return false;
  for (const src of sources) {
    const t = src.getAttribute(name);
    if (t && a === t) return true;
  }
  return false;
}

/**
 * 释放 tileMesh.userData 上缓存的合并 split BufferGeometry。
 * 合并几何与瓦片共享顶点属性引用；直接 `dispose()` 会从 WebGL 移除共享 BufferAttribute，瓦片会发瘪/缺面。
 * 需先从合并几何上 deleteAttribute 摘掉共享引用，再 dispose（仅清独立 index 与 dispose 事件）。
 */
export function disposeMergedSplitGeometryCacheEntry(
  mergedGeom: BufferGeometry,
  tileMesh: Mesh,
): void {
  const sources = getGeometrySourcesForTileFeatureMesh(tileMesh);
  if (sources.length === 0) {
    mergedGeom.dispose();
    return;
  }
  const names = Object.keys(mergedGeom.attributes);
  for (const name of names) {
    if (attributeIsSharedWithAnySource(mergedGeom, sources, name)) {
      mergedGeom.deleteAttribute(name);
    }
  }
  if (splitIndexIsSharedWithAnySource(mergedGeom, sources)) {
    mergedGeom.setIndex(null);
  }
  mergedGeom.dispose();
}

/** 仅释放与瓦片非共享的顶点属性（同引用则保留，避免误伤瓦片几何） */
function disposeSplitGeometryAttributesNotSharedWithSources(
  geom: BufferGeometry,
  sources: BufferGeometry[],
): void {
  if (sources.length === 0) return;

  const names = Object.keys(geom.attributes);
  for (const name of names) {
    if (attributeIsSharedWithAnySource(geom, sources, name)) {
      continue;
    }
    const attr = geom.getAttribute(name);
    geom.deleteAttribute(name);
    (attr as unknown as { dispose(): void }).dispose();
  }
}

/**
 * 释放 {@link splitMeshByOidsMerged} 生成 mesh 的独占资源。
 * - 材质：clone 与瓦片逐贴图比对引用；非共享贴图 dispose，共享贴图先 detach 再 `material.dispose()`，避免误伤瓦片。
 * - 几何：不得对整块 `geometry.dispose()`（会波及共享缓冲）；仅释放与瓦片非共享的 index 与 attributes。
 * - **不要**对 `THREE.Mesh` 调用 `dispose()`：核心库中 `Mesh` 无此方法。
 */
export function disposeMergedSplitMeshResources(mesh: Mesh): void {
  const builtKey = "_gltfParserStyleAppearanceBuilt";
  const built = mesh.userData?.[builtKey] as Object3D | undefined;
  if (built) {
    built.removeFromParent();
    delete mesh.userData[builtKey];
  }
  mesh.removeFromParent();

  const tileMesh = mesh.userData?.originalMesh as Mesh | undefined;
  const tileMats = getMeshMaterials(tileMesh);

  const mats = mesh.material;
  const list = Array.isArray(mats) ? mats : [mats];

  for (let i = 0; i < list.length; i++) {
    const mat = list[i];
    if (!mat) continue;
    const tileMat = tileMats[i] ?? tileMats[0];
    disposeSplitMaterialVsTile(mat, tileMat);
  }

  /**
   * splitGeometryManagedByCache为true时,只释放材质
   * mesh.geometry 不是 split mesh 独占的，而是挂在 瓦片源 mesh 的 userData 缓存里（按 OID 集合键复用），
   * 所以需要从 userData 缓存里删除，避免后续释放瓦片几何缓存时仍被 split Mesh 引用
   */
  if (mesh.userData?.splitGeometryManagedByCache) {
    (mesh as unknown as { geometry: BufferGeometry | null }).geometry = null;
    return;
  }

  const geom = mesh.geometry;
  if (!geom) return;

  const sources = tileMesh
    ? getGeometrySourcesForTileFeatureMesh(tileMesh)
    : [];

  if (!splitIndexIsSharedWithAnySource(geom, sources)) {
    const idx = geom.index;
    if (idx) {
      (idx as unknown as { dispose(): void }).dispose();
      geom.setIndex(null);
    }
  }

  disposeSplitGeometryAttributesNotSharedWithSources(geom, sources);
}

/** 瓦片内原始 feature mesh（非 split 子网格） */
function isFeatureSourceMesh(mesh: Mesh): boolean {
  const u = mesh.userData;
  return Boolean(u?.meshFeatures && u?.structuralMetadata && !u?.isSplit);
}

/**
 * 内部数据钩子：在原始属性表数据基础上派生/注入额外字段（如层级 `_path`）。
 * 返回新对象；约定不修改入参。
 */
export type InternalData = (
  oid: number,
  data: Record<string, unknown>,
) => Record<string, unknown>;

/**
 * 从瓦片中获取所有 OID
 */
export function getAllOidsFromTiles(tiles: TilesRenderer): number[] {
  const oidSet = new Set<number>();

  tiles.group.traverse((child: Object3D) => {
    const mesh = child as Mesh;
    if (!isFeatureSourceMesh(mesh)) return;
    const idMap = mesh.userData.idMap as Record<number, number> | undefined;
    if (!idMap) return;
    for (const oid of Object.keys(idMap).map(Number)) {
      oidSet.add(oid);
    }
  });

  return Array.from(oidSet);
}

/**
 * 根据 OID 获取属性数据（从瓦片 structuralMetadata）
 */
export function getPropertyDataByOid(
  tiles: TilesRenderer,
  oid: number,
  internalData?: InternalData,
): Record<string, unknown> | null {
  let result: Record<string, unknown> | null = null;

  tiles.group.traverse((child: Object3D) => {
    if (result) return;

    const mesh = child as Mesh;
    if (!isFeatureSourceMesh(mesh)) return;
    const idMap = mesh.userData.idMap as Record<number, number> | undefined;
    if (!idMap || idMap[oid] === undefined) return;

    const { meshFeatures, structuralMetadata } = mesh.userData;
    const featureId = meshFeatures.featureIds[0];
    const fid = idMap[oid];

    try {
      const data = structuralMetadata.getPropertyTableData(
        featureId.propertyTable,
        fid,
      ) as Record<string, unknown>;
      result = internalData ? internalData(oid, data) : data;
    } catch {
      // ignore
    }
  });

  return result;
}

/**
 * 单次遍历场景构建 OID → 属性表数据。
 * 批量样式/筛选时使用，避免对每个 OID 重复 traverse（O(n×场景节点)）。
 */
export function getPropertyDataMapFromTiles(
  tiles: TilesRenderer,
  internalData?: InternalData,
): Map<number, Record<string, unknown> | null> {
  const map = new Map<number, Record<string, unknown> | null>();

  tiles.group.traverse((child: Object3D) => {
    const mesh = child as Mesh;
    if (!isFeatureSourceMesh(mesh)) return;
    const idMap = mesh.userData.idMap as Record<number, number> | undefined;
    if (!idMap) return;

    const { meshFeatures, structuralMetadata } = mesh.userData;
    const featureId = meshFeatures.featureIds[0];
    const propertyTable = featureId.propertyTable;

    for (const oid of Object.keys(idMap).map(Number)) {
      const fid = idMap[oid];
      if (fid === undefined) continue;

      const existing = map.get(oid);
      if (existing != null) continue;

      try {
        const data = structuralMetadata.getPropertyTableData(
          propertyTable,
          fid,
        ) as Record<string, unknown>;
        map.set(oid, internalData ? internalData(oid, data) : data);
      } catch {
        if (!map.has(oid)) {
          map.set(oid, null);
        }
      }
    }
  });

  return map;
}

/**
 * 根据OID获取包含该OID的瓦片mesh
 */
export function getTileMeshesByOid(tiles: TilesRenderer, oid: number): Mesh[] {
  const tileMeshes: Mesh[] = [];

  tiles.group.traverse((child: Object3D) => {
    const mesh = child as Mesh;
    if (isFeatureSourceMesh(mesh) && checkMeshContainsOid(mesh, oid)) {
      tileMeshes.push(mesh);
    }
  });

  return tileMeshes;
}

function checkMeshContainsOid(mesh: Mesh, oid: number): boolean {
  const idMap = mesh.userData.idMap;

  if (!idMap) {
    return false;
  }

  return idMap[oid] !== undefined;
}
