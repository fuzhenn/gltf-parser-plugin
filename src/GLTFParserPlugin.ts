import {
  Box3,
  DoubleSide,
  Intersection,
  Material,
  Mesh,
  Object3D,
  Vector2,
  WebGLRenderer,
} from "three";
import {
  FeatureIdUniforms,
  FeatureInfo,
  buildOidToFeatureIdMap,
  getSplitMeshesFromTile,
  getTileMeshesByOid,
  queryFeatureFromIntersection,
} from "./mesh-helper";

import { MeshCollector, type MeshHelperHost } from "./MeshCollector";
import { GLTFWorkerLoader } from "./GLTFWorkerLoader";
import type { MaterialBuilder } from "./types";
import { setMaxWorkers } from "./utils";
import { tileCache } from "./db";
import { TilesRenderer } from "3d-tiles-renderer";

interface TileWithCache {
  cached?: {
    scene: Object3D;
  };
}

/**
 * structure.json 中的树节点结构
 */
export interface StructureNode {
  id?: number;
  name?: string;
  bbox?: number[];
  children?: StructureNode[];
  [key: string]: unknown;
}

/**
 * structure.json 的完整数据结构
 */
export interface StructureData {
  defaultTree?: number;
  idField?: string;
  trees: StructureNode[];
}

/**
 * modelInfo.json 的数据结构
 */
export interface ModelInfo {
  animatable: boolean;
  images: number;
  materials: number;
  pbr: boolean;
  textures: number;
  triangles: number;
  vertices: number;
}

/**
 * GLTFParserPlugin configuration options
 */
export interface GLTFParserPluginOptions {
  /**
   * WebGLRenderer instance, required for mesh helper features (hideByOids, etc.)
   */
  renderer?: WebGLRenderer;
  /**
   * Whether to enable metadata support
   * Includes EXT_mesh_features and EXT_structural_metadata extensions
   * @default true
   */
  metadata?: boolean;
  /**
   * Maximum number of workers in the worker pool
   * Maximum value is navigator.hardwareConcurrency
   * @default navigator.hardwareConcurrency
   */
  maxWorkers?: number;

  /**
   * Custom material builder function
   * Used to handle GLTF material extensions or custom material logic
   */
  materialBuilder?: MaterialBuilder;

  /**
   * Callback function before parsing
   * Used to preprocess the buffer before parsing GLTF
   */
  beforeParseTile?: (
    buffer: ArrayBuffer,
    tile: any,
    extension: any,
    uri: string,
    abortSignal: AbortSignal,
  ) => Promise<ArrayBuffer>;

  /**
   * Whether to enable IndexedDB caching for tile data
   * @default false
   */
  useIndexedDB?: boolean;
}

export class GLTFParserPlugin implements MeshHelperHost {
  name = "GLTFParserPlugin";

  private tiles: (TilesRenderer & Record<string, any>) | null = null;
  private _loader: GLTFWorkerLoader | null = null;
  private readonly _gltfRegex = /\.(gltf|glb)$/g;
  private readonly _options: GLTFParserPluginOptions;

  // --- Structure data properties ---
  private _structureData: StructureData | null = null;
  private _oidNodeMap: Map<number, StructureNode> = new Map();
  private _structurePromise: Promise<StructureData | null> | null = null;

  // --- Model info properties ---
  private _modelInfo: ModelInfo | null = null;
  private _modelInfoPromise: Promise<ModelInfo | null> | null = null;

  // --- Interaction filter properties ---
  private _frozenOids: Set<number> = new Set();
  private _isolatedOids: Set<number> = new Set();
  private _trackedMeshes: Map<number, Set<Mesh>> = new Map();
  private _meshListeners: Map<
    Mesh,
    { onAdded: () => void; onRemoved: () => void }
  > = new Map();
  private _isPluginRemoving = false;

  // --- Mesh helper properties ---
  oids: number[] = [];
  private renderer: WebGLRenderer | null = null;
  private splitMeshCache: Map<string, Mesh[]> = new Map();
  private maxUniformVectors: number = 1024;
  private featureIdCount: number = 32;
  private collectors: Set<MeshCollector> = new Set();
  private collectorCache: Map<number, MeshCollector> = new Map();

  /**
   * Create a GLTFParserPlugin instance
   * @param options configuration options
   */
  constructor(options?: GLTFParserPluginOptions) {
    this._options = {
      metadata: true,
      maxWorkers: navigator.hardwareConcurrency || 4,
      useIndexedDB: false,
      ...options,
    };

    if (options?.renderer) {
      this.renderer = options.renderer;
    }

    setMaxWorkers(this._options.maxWorkers!);
  }

  /**
   * Plugin initialization, called by TilesRenderer
   */
  init(tiles: TilesRenderer) {
    this.tiles = tiles;

    // --- GLTF loader setup ---
    this._loader = new GLTFWorkerLoader(tiles.manager, {
      metadata: this._options.metadata,
      materialBuilder: this._options.materialBuilder,
    });
    tiles.manager.addHandler(this._gltfRegex, this._loader);

    // --- Mesh helper setup ---
    if (this.renderer) {
      this._updateWebGLLimits();
    }

    tiles.addEventListener("load-model", this._onLoadModelCB);
    tiles.addEventListener("tiles-load-end", this._onTilesLoadEndCB);

    tiles.traverse((tile: any) => {
      const tileWithCache = tile as TileWithCache;
      if (tileWithCache.cached?.scene) {
        this._onLoadModel(tileWithCache.cached.scene);
      }
      return true;
    }, null);
  }

  // =============================================
  // GLTF Parser Methods
  // =============================================

  /**
   * Fetch tile data with IndexedDB caching support
   */
  async fetchData(
    url: string,
    options?: RequestInit,
  ): Promise<Response | ArrayBuffer | object> {
    const isJson = url.toLowerCase().endsWith(".json");
    if (!this._options.useIndexedDB || isJson) {
      return this.tiles!.fetchData(url, options);
    }

    try {
      const cachedData = await tileCache.get(url);

      if (cachedData) {
        return cachedData;
      }

      const response = await this.tiles!.fetchData(url, options);

      if (!response.ok) {
        return response;
      }

      const arrayBuffer = await response.arrayBuffer();

      tileCache.set(url, arrayBuffer).catch((err: unknown) => {
        console.warn("[GLTFParserPlugin] Failed to cache data:", err);
      });

      return arrayBuffer;
    } catch (error) {
      return this.tiles!.fetchData(url, options);
    }
  }

  /**
   * Clear all cached tile data from IndexedDB
   */
  async clearCache(): Promise<void> {
    await tileCache.clear();
    console.info("[GLTFParserPlugin] Cache cleared");
  }

  async parseTile(
    buffer: ArrayBuffer,
    tile: any,
    extension: any,
    uri: string,
    abortSignal: AbortSignal,
  ) {
    if (this._options.beforeParseTile) {
      buffer = await this._options.beforeParseTile(
        buffer,
        tile,
        extension,
        uri,
        abortSignal,
      );
    }
    return this.tiles!.parseTile(buffer, tile, extension, uri, abortSignal);
  }

  // =============================================
  // Structure Data Methods
  // =============================================

  private _getStructureUrl(): string | null {
    const rootURL = this.tiles?.rootURL as string | undefined;
    if (!rootURL) return null;
    return rootURL.replace(/[^/]+$/, "structure.json");
  }

  private _buildOidNodeMap(
    node: StructureNode,
    map: Map<number, StructureNode>,
  ): void {
    if (node.id !== undefined) {
      map.set(node.id, node);
    }
    if (node.children) {
      for (const child of node.children) {
        this._buildOidNodeMap(child, map);
      }
    }
  }

  private async _fetchStructureData(): Promise<StructureData | null> {
    const url = this._getStructureUrl();
    if (!url) {
      console.warn(
        "[GLTFParserPlugin] Cannot derive structure.json URL: tiles not initialized",
      );
      return null;
    }

    try {
      const response = await fetch(url);
      if (!response.ok) {
        console.warn(
          `[GLTFParserPlugin] Failed to fetch structure.json: ${response.status}`,
        );
        return null;
      }
      const data: StructureData = await response.json();
      this._structureData = data;

      this._oidNodeMap.clear();
      if (data.trees) {
        for (const tree of data.trees) {
          this._buildOidNodeMap(tree, this._oidNodeMap);
        }
      }

      return data;
    } catch (error) {
      console.error("[GLTFParserPlugin] Error loading structure.json:", error);
      return null;
    }
  }

  private async _ensureStructureLoaded(): Promise<StructureData | null> {
    if (this._structureData) return this._structureData;
    if (!this._structurePromise) {
      this._structurePromise = this._fetchStructureData();
    }
    return this._structurePromise;
  }

  /**
   * 根据 oid 获取 structure.json 中对应的节点树数据
   * 包含 bbox、children、name 等完整结构信息
   * 首次调用时会自动从 tileset URL 推导并请求 structure.json
   */
  async getNodeTreeByOid(oid: number): Promise<StructureNode | null> {
    await this._ensureStructureLoaded();
    return this._oidNodeMap.get(oid) ?? null;
  }

  /**
   * 根据 oid 数组批量获取 structure.json 中对应的节点树数据
   */
  async getNodeTreeByOids(oids: number[]): Promise<Map<number, StructureNode>> {
    await this._ensureStructureLoaded();
    const result = new Map<number, StructureNode>();
    for (const oid of oids) {
      const node = this._oidNodeMap.get(oid);
      if (node) {
        result.set(oid, node);
      }
    }
    return result;
  }

  /**
   * 获取完整的 structure.json 数据
   * 首次调用时会自动请求
   */
  async getStructureData(): Promise<StructureData | null> {
    return this._ensureStructureLoaded();
  }

  // =============================================
  // Spatial Query Methods
  // =============================================

  private _pointInPolygon(px: number, py: number, polygon: Vector2[]): boolean {
    let inside = false;
    const n = polygon.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = polygon[i].x,
        yi = polygon[i].y;
      const xj = polygon[j].x,
        yj = polygon[j].y;
      if (
        yi > py !== yj > py &&
        px < ((xj - xi) * (py - yi)) / (yj - yi) + xi
      ) {
        inside = !inside;
      }
    }
    return inside;
  }

  private _segmentsIntersect(
    ax1: number,
    ay1: number,
    ax2: number,
    ay2: number,
    bx1: number,
    by1: number,
    bx2: number,
    by2: number,
  ): boolean {
    const cross = (
      ox: number,
      oy: number,
      ax: number,
      ay: number,
      bx: number,
      by: number,
    ) => (ax - ox) * (by - oy) - (ay - oy) * (bx - ox);

    const d1 = cross(bx1, by1, bx2, by2, ax1, ay1);
    const d2 = cross(bx1, by1, bx2, by2, ax2, ay2);
    const d3 = cross(ax1, ay1, ax2, ay2, bx1, by1);
    const d4 = cross(ax1, ay1, ax2, ay2, bx2, by2);

    if (
      ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
      ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
    ) {
      return true;
    }

    const onSeg = (
      px: number,
      py: number,
      qx: number,
      qy: number,
      rx: number,
      ry: number,
    ) =>
      Math.min(px, qx) <= rx &&
      rx <= Math.max(px, qx) &&
      Math.min(py, qy) <= ry &&
      ry <= Math.max(py, qy);

    if (d1 === 0 && onSeg(bx1, by1, bx2, by2, ax1, ay1)) return true;
    if (d2 === 0 && onSeg(bx1, by1, bx2, by2, ax2, ay2)) return true;
    if (d3 === 0 && onSeg(ax1, ay1, ax2, ay2, bx1, by1)) return true;
    if (d4 === 0 && onSeg(ax1, ay1, ax2, ay2, bx2, by2)) return true;

    return false;
  }

  private _polygonIntersectsRect(
    polygon: Vector2[],
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
  ): boolean {
    const n = polygon.length;

    for (let i = 0; i < n; i++) {
      const p = polygon[i];
      if (p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY) {
        return true;
      }
    }

    if (
      this._pointInPolygon(minX, minY, polygon) ||
      this._pointInPolygon(maxX, minY, polygon) ||
      this._pointInPolygon(maxX, maxY, polygon) ||
      this._pointInPolygon(minX, maxY, polygon)
    ) {
      return true;
    }

    const rx = [minX, maxX, maxX, minX];
    const ry = [minY, minY, maxY, maxY];

    for (let i = 0; i < n; i++) {
      const a = polygon[i];
      const b = polygon[(i + 1) % n];
      for (let j = 0; j < 4; j++) {
        const k = (j + 1) % 4;
        if (
          this._segmentsIntersect(
            a.x,
            a.y,
            b.x,
            b.y,
            rx[j],
            ry[j],
            rx[k],
            ry[k],
          )
        ) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * 选择包围盒范围内的构件（包含相交和包含两种情况）
   * @param box 查询用的 Box3 范围，坐标系与 structure.json 中 bbox 一致
   * @returns 范围内所有构件的 oid 数组
   */
  async selectByBox(box: Box3): Promise<number[]> {
    await this._ensureStructureLoaded();
    const result: number[] = [];
    const nodeBox = new Box3();

    for (const [oid, node] of this._oidNodeMap) {
      if (!node.bbox || node.bbox.length < 6) continue;
      nodeBox.min.set(node.bbox[0], node.bbox[1], node.bbox[2]);
      nodeBox.max.set(node.bbox[3], node.bbox[4], node.bbox[5]);
      if (box.intersectsBox(nodeBox)) {
        result.push(oid);
      }
    }

    return result;
  }

  /**
   * 选择多边形（平面投影）范围内的构件（包含相交和包含两种情况）
   * @param polygon 多边形顶点数组（Vector2），按顺序连接构成闭合多边形
   * @param axis 投影平面，决定使用 bbox 的哪两个轴做 2D 判定
   *   - 'xz'（默认）：俯视图，取 bbox 的 x/z 坐标
   *   - 'xy'：正视图，取 bbox 的 x/y 坐标
   *   - 'yz'：侧视图，取 bbox 的 y/z 坐标
   * @returns 范围内所有构件的 oid 数组
   */
  async selectByPolygon(
    polygon: Vector2[],
    axis: "xy" | "xz" | "yz" = "xz",
  ): Promise<number[]> {
    await this._ensureStructureLoaded();
    const result: number[] = [];

    for (const [oid, node] of this._oidNodeMap) {
      if (!node.bbox || node.bbox.length < 6) continue;

      let minU: number, minV: number, maxU: number, maxV: number;
      switch (axis) {
        case "xy":
          minU = node.bbox[0];
          minV = node.bbox[1];
          maxU = node.bbox[3];
          maxV = node.bbox[4];
          break;
        case "xz":
          minU = node.bbox[0];
          minV = node.bbox[2];
          maxU = node.bbox[3];
          maxV = node.bbox[5];
          break;
        case "yz":
          minU = node.bbox[1];
          minV = node.bbox[2];
          maxU = node.bbox[4];
          maxV = node.bbox[5];
          break;
      }

      if (this._polygonIntersectsRect(polygon, minU, minV, maxU, maxV)) {
        result.push(oid);
      }
    }

    return result;
  }

  // =============================================
  // Model Info Methods
  // =============================================

  private _getModelInfoUrl(): string | null {
    const rootURL = this.tiles?.rootURL as string | undefined;
    if (!rootURL) return null;
    return rootURL.replace(/[^/]+$/, "modelInfo.json");
  }

  private async _fetchModelInfo(): Promise<ModelInfo | null> {
    const url = this._getModelInfoUrl();
    if (!url) {
      console.warn(
        "[GLTFParserPlugin] Cannot derive modelInfo.json URL: tiles not initialized",
      );
      return null;
    }

    try {
      const response = await fetch(url);
      if (!response.ok) {
        console.warn(
          `[GLTFParserPlugin] Failed to fetch modelInfo.json: ${response.status}`,
        );
        return null;
      }
      const data: ModelInfo = await response.json();
      this._modelInfo = data;
      return data;
    } catch (error) {
      console.error("[GLTFParserPlugin] Error loading modelInfo.json:", error);
      return null;
    }
  }

  private async _ensureModelInfoLoaded(): Promise<ModelInfo | null> {
    if (this._modelInfo) return this._modelInfo;
    if (!this._modelInfoPromise) {
      this._modelInfoPromise = this._fetchModelInfo();
    }
    return this._modelInfoPromise;
  }

  /**
   * 获取 modelInfo.json 数据
   * 包含模型的基本信息：动画支持、材质数量、顶点数、三角形数等
   * 首次调用时会自动从 tileset URL 推导并请求 modelInfo.json
   */
  async getModelInfo(): Promise<ModelInfo | null> {
    return this._ensureModelInfoLoaded();
  }

  // =============================================
  // Mesh Helper Methods (from MaptalksTilerPlugin)
  // =============================================

  /**
   * Load model callback
   */
  private _onLoadModelCB = ({ scene }: { scene: Object3D }) => {
    this._onLoadModel(scene);
  };

  /**
   * Tiles load end callback
   */
  private _onTilesLoadEndCB = () => {
    this._notifyCollectors();
  };

  private _onLoadModel(scene: Object3D) {
    this.splitMeshCache.clear();

    buildOidToFeatureIdMap(scene);
    scene.traverse((c) => {
      if ((c as Mesh).material) {
        this._setupMaterial(c as Mesh);
      }
    });
  }

  private _notifyCollectors(): void {
    for (const collector of this.collectors) {
      collector._updateMeshes();
    }
  }

  _registerCollector(collector: MeshCollector): void {
    this.collectors.add(collector);
  }

  _unregisterCollector(collector: MeshCollector): void {
    const oid = collector.getOid();
    this.collectors.delete(collector);
    this.collectorCache.delete(oid);

    const tracked = this._trackedMeshes.get(oid);
    if (tracked) {
      for (const mesh of tracked) {
        this._untrackMesh(mesh);
      }
      this._trackedMeshes.delete(oid);
    }
  }

  private _updateWebGLLimits() {
    const gl = this.renderer!.getContext();
    const maxVectors = gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS);
    this.maxUniformVectors = maxVectors;
  }

  /**
   * Dynamically calculate FEATURE_ID_COUNT based on WebGL limits and current oid count
   */
  private _calculateFeatureIdCount(): number {
    const maxUniformVectors = this.maxUniformVectors;
    const currentOidCount = this.oids.length;

    if (currentOidCount > maxUniformVectors) {
      throw new Error(
        `The number of OIDs to hide (${currentOidCount}) exceeds the WebGL MAX_FRAGMENT_UNIFORM_VECTORS limit (${maxUniformVectors}).`,
      );
    }

    const minFeatureIdCount = 32;

    if (currentOidCount <= minFeatureIdCount) {
      return minFeatureIdCount;
    }

    const powerOf2 = Math.ceil(Math.log2(currentOidCount));
    return Math.pow(2, powerOf2);
  }

  /**
   * Set up shader modification for hiding specific features
   */
  private _setupMaterial(mesh: Mesh) {
    const material = mesh.material as Material;

    if (material.userData._meshHelperSetup) {
      return;
    }
    material.userData._meshHelperSetup = true;

    material.side = DoubleSide;

    const previousOnBeforeCompile = material.onBeforeCompile;

    if (!material.defines) {
      material.defines = {};
    }

    material.userData._materialFeatureIdCount = this.featureIdCount;

    Object.defineProperty(material.defines, "FEATURE_ID_COUNT", {
      get: () => {
        if (material.userData._materialFeatureIdCount !== this.featureIdCount) {
          material.userData._materialFeatureIdCount = this.featureIdCount;
          material.needsUpdate = true;
        }
        return material.userData._materialFeatureIdCount;
      },
      enumerable: true,
      configurable: true,
    });

    material.onBeforeCompile = (shader, renderer) => {
      previousOnBeforeCompile?.call(material, shader, renderer);

      if (shader.vertexShader.includes("varying float vFeatureId;")) {
        return;
      }

      shader.uniforms.hiddenFeatureIds = new FeatureIdUniforms(mesh, this);

      shader.vertexShader = shader.vertexShader.replace(
        "#include <common>",
        `#include <common>
             attribute float _feature_id_0;
             varying float vFeatureId;`,
      );

      shader.vertexShader = shader.vertexShader.replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
             vFeatureId = _feature_id_0;`,
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <common>",
        `#include <common>
             uniform float hiddenFeatureIds[FEATURE_ID_COUNT];
             varying float vFeatureId;
      
             bool shouldHideFeature(float featureId) {
               for(int i = 0; i < FEATURE_ID_COUNT; i++) {
                 if(abs(hiddenFeatureIds[i] - featureId) < 0.001) {
                   return true;
                 }
               }
               return false;
             }`,
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        "void main() {",
        `void main() {
           if(shouldHideFeature(vFeatureId)) {
             discard;
           }`,
      );
    };
  }

  /**
   * Query feature information from intersection
   * Respects freeze and isolate filters
   */
  queryFeatureFromIntersection(hit: Intersection): FeatureInfo {
    const result = queryFeatureFromIntersection(hit);

    if (result.isValid && result.oid !== undefined) {
      if (this._frozenOids.has(result.oid)) {
        return { isValid: false, error: "Component is frozen" };
      }
      if (this._isolatedOids.size > 0 && !this._isolatedOids.has(result.oid)) {
        return { isValid: false, error: "Component is not in isolated set" };
      }
    }

    return result;
  }

  // =============================================
  // Interaction Filter Methods
  // =============================================

  private _isOidBlocked(oid: number): boolean {
    if (this._frozenOids.has(oid)) return true;
    if (this._isolatedOids.size > 0 && !this._isolatedOids.has(oid))
      return true;
    return false;
  }

  private _trackMesh(mesh: Mesh, oid: number): void {
    if (this._meshListeners.has(mesh)) return;

    const onAdded = () => {
      if (this._isPluginRemoving) return;
      mesh.userData._detachedParent = null;
      if (this._isOidBlocked(oid) && mesh.parent) {
        const parent = mesh.parent;
        this._isPluginRemoving = true;
        mesh.userData._detachedParent = parent;
        parent.remove(mesh);
        this._isPluginRemoving = false;
      }
    };

    const onRemoved = () => {
      if (this._isPluginRemoving) return;
      mesh.userData._detachedParent = null;
    };

    mesh.addEventListener("added", onAdded);
    mesh.addEventListener("removed", onRemoved);
    this._meshListeners.set(mesh, { onAdded, onRemoved });
  }

  private _untrackMesh(mesh: Mesh): void {
    const listeners = this._meshListeners.get(mesh);
    if (listeners) {
      mesh.removeEventListener("added", listeners.onAdded);
      mesh.removeEventListener("removed", listeners.onRemoved);
      this._meshListeners.delete(mesh);
    }
    mesh.userData._detachedParent = null;
  }

  private _onCollectorMeshChange(oid: number, newMeshes: Mesh[]): void {
    const tracked = this._trackedMeshes.get(oid);
    const newSet = new Set(newMeshes);

    if (tracked) {
      for (const mesh of tracked) {
        if (!newSet.has(mesh)) {
          this._untrackMesh(mesh);
          tracked.delete(mesh);
        }
      }
    }

    const trackSet = tracked || new Set<Mesh>();
    for (const mesh of newMeshes) {
      if (!trackSet.has(mesh)) {
        this._trackMesh(mesh, oid);
        trackSet.add(mesh);
      }
    }
    this._trackedMeshes.set(oid, trackSet);
  }

  private _syncCollectorMeshes(): void {
    this._isPluginRemoving = true;

    for (const [oid, collector] of this.collectorCache) {
      const blocked = this._isOidBlocked(oid);

      for (const mesh of collector.meshes) {
        if (!this._meshListeners.has(mesh)) continue;

        if (blocked) {
          if (mesh.parent && !mesh.userData._detachedParent) {
            const parent = mesh.parent;
            mesh.userData._detachedParent = parent;
            // parent.remove(mesh);
            this.unhideByOids([oid]);
          }
        } else {
          const storedParent = mesh.userData._detachedParent;
          if (storedParent && !mesh.parent) {
            storedParent.add(mesh);
            mesh.userData._detachedParent = null;
          }
        }
      }
    }

    this._isPluginRemoving = false;
  }

  /**
   * 冻结指定构件，被冻结的构件不再响应任何交互和事件
   */
  freezeByOids(oids: number[]): void {
    for (const oid of oids) {
      this._frozenOids.add(oid);
    }
    this._syncCollectorMeshes();
  }

  /**
   * 冻结单个构件
   */
  freezeByOid(oid: number): void {
    this._frozenOids.add(oid);
    this._syncCollectorMeshes();
  }

  /**
   * 解冻指定构件
   */
  unfreezeByOids(oids: number[]): void {
    for (const oid of oids) {
      this._frozenOids.delete(oid);
    }
    this._syncCollectorMeshes();
  }

  /**
   * 解冻单个构件
   */
  unfreezeByOid(oid: number): void {
    this._frozenOids.delete(oid);
    this._syncCollectorMeshes();
  }

  /**
   * 解冻全部构件
   */
  unfreeze(): void {
    this._frozenOids.clear();
    this._syncCollectorMeshes();
  }

  /**
   * 获取当前被冻结的 OID 数组
   */
  getFrozenOids(): number[] {
    return Array.from(this._frozenOids);
  }

  /**
   * 隔离指定构件，隔离模式下只有被隔离的构件才能响应交互和事件
   */
  isolateByOids(oids: number[]): void {
    for (const oid of oids) {
      this._isolatedOids.add(oid);
    }
    this._syncCollectorMeshes();
  }

  /**
   * 往隔离集合中添加单个构件
   */
  isolateByOid(oid: number): void {
    this._isolatedOids.add(oid);
    this._syncCollectorMeshes();
  }

  /**
   * 取消隔离指定构件
   */
  unisolateByOids(oids: number[]): void {
    for (const oid of oids) {
      this._isolatedOids.delete(oid);
    }
    this._syncCollectorMeshes();
  }

  /**
   * 从隔离集合中移除单个构件
   */
  unisolateByOid(oid: number): void {
    this._isolatedOids.delete(oid);
    this._syncCollectorMeshes();
  }

  /**
   * 取消全部隔离，恢复所有构件的交互能力
   */
  unisolate(): void {
    this._isolatedOids.clear();
    this._syncCollectorMeshes();
  }

  /**
   * 获取当前被隔离的 OID 数组
   */
  getIsolatedOids(): number[] {
    return Array.from(this._isolatedOids);
  }

  /**
   * 内部方法：根据 oid 获取 mesh 数组
   */
  _getMeshesByOidInternal(oid: number): Mesh[] {
    const tileMeshes = getTileMeshesByOid(this.tiles!, oid);

    const allSplitMeshes: Mesh[] = [];

    for (const tileMesh of tileMeshes) {
      const cacheKey = `${oid}_${tileMesh.uuid}`;

      let splitMeshes = this.splitMeshCache.get(cacheKey);

      if (!splitMeshes) {
        splitMeshes = getSplitMeshesFromTile(tileMesh, oid);
        this.splitMeshCache.set(cacheKey, splitMeshes);
      }
      allSplitMeshes.push(...splitMeshes);
    }

    return allSplitMeshes;
  }

  /**
   * 根据 oid 获取 MeshCollector
   * MeshCollector 会监听瓦片变化，自动更新 meshes 并触发 mesh-change 事件
   * 内部缓存：相同 oid 多次调用会返回同一个 collector 实例
   */
  getMeshCollectorByOid(oid: number): MeshCollector {
    const existing = this.collectorCache.get(oid);
    if (existing) {
      return existing;
    }
    const collector = new MeshCollector(oid, this);
    this.collectorCache.set(oid, collector);

    this._onCollectorMeshChange(oid, collector.meshes);

    collector.addEventListener("mesh-change", (event) => {
      this._onCollectorMeshChange(oid, event.meshes);
    });

    return collector;
  }

  /**
   * Hide the corresponding part of the original mesh according to the OID array
   */
  hideByOids(oids: number[]): void {
    this.oids = oids;
    this.featureIdCount = this._calculateFeatureIdCount();
  }

  /**
   * Restore the display of the corresponding mesh according to the OID array
   */
  unhideByOids(oids: number[]): void {
    const oidSet = new Set(oids);
    const newOids = this.oids.filter((existingOid) => !oidSet.has(existingOid));
    this.oids = newOids;
    this.featureIdCount = this._calculateFeatureIdCount();
  }

  /**
   * Restore the original materials of the mesh
   */
  unhide(): void {
    this.oids = [];
    this.featureIdCount = this._calculateFeatureIdCount();
  }

  /**
   * Get the current feature ID count
   */
  getFeatureIdCount(): number {
    return this.featureIdCount;
  }

  /**
   * Plugin disposal
   */
  dispose() {
    if (this.tiles) {
      this.tiles.manager.removeHandler(this._gltfRegex);
      this.tiles.removeEventListener("load-model", this._onLoadModelCB);
      this.tiles.removeEventListener("tiles-load-end", this._onTilesLoadEndCB);
    }

    if (this._loader) {
      this._loader.removeListeners();
    }

    for (const collector of this.collectors) {
      collector.dispose();
    }
    this.collectors.clear();
    this.collectorCache.clear();

    this.splitMeshCache.clear();

    this._structureData = null;
    this._oidNodeMap.clear();
    this._structurePromise = null;

    // Clear model info data
    this._modelInfo = null;
    this._modelInfoPromise = null;

    for (const [, meshSet] of this._trackedMeshes) {
      for (const mesh of meshSet) {
        this._untrackMesh(mesh);
      }
    }
    this._trackedMeshes.clear();
    this._meshListeners.clear();
    this._frozenOids.clear();
    this._isolatedOids.clear();

    this._loader = null;
    this.tiles = null;
  }
}
