/**
 * 碰撞世界（CollisionWorld）
 * ------------------------------------------------------------
 * 把「空间索引 + 三角面精确碰撞 + 地面高度采样 + 出生点搜索」封装在一起，
 * 与具体的玩家/相机逻辑解耦：对外只暴露纯几何查询接口。
 *
 * 核心思路：
 *   1. 包围盒 + 空间网格（gridCell）→ 快速筛掉远处的碰撞体；
 *   2. 三角面 BVH（three-mesh-bvh）→ 精确的球体 vs 三角面穿透检测；
 *   3. 沿身体轴布置若干采样球，取最深穿透并沿法线推出（贴墙自动滑行）；
 *   4. 脚下多点向下射线 → 取可站立面（中心射线允许向上吸附，实现上台阶/被屋面托回）。
 *
 * 典型用法：
 *   const world = new CollisionWorld({ gridCell: 16, stepHeight: 0.5, radius: 0.35 });
 *   world.upAxis = 'z';               // 可选：Z-UP 世界（默认 Y-UP）
 *   world.add(mesh);                  // 逐个登记 Mesh（不遍历子节点；业务侧可先按与相机的距离排序）
 *   await world.build({ onProgress: (p, tip) => setProgress(p, tip) });
 *   const meshes = world.queryNearby(px, pz, radius + 1.6);
 *   world.resolvePenetration(pos, meshes, pos.y);
 *   const g = world.sampleGround(pos, meshes, 0.5, 0.8);
 *   const spawn = findSpawn(world);   // findSpawn 定义在 main.ts
 *
 * 增量构建：
 *   build() 是幂等的，可以每帧调用。每个网格的处理结果缓存在 mesh.userData.collisionCache，
 *   已处理过的网格会被跳过，只为新增（或 invalidate 过的）网格计算包围盒 / 铺网格 / 建 BVH。
 *   构建受每帧时间预算限制（frameBudgetMs，默认 4ms）：每帧至少处理一个模型，
 *   预算用完即让出到下一帧，未处理完的模型由后续帧继续（requestAnimationFrame 保证持续推进）。
 *   若动态物体移动或换了几何，调用 world.invalidate(mesh)（换几何时同时把 cv.bvh 置回 false）即可。
 *
 * 每帧「清空 + 重新登记」：
 *   world.clear();                                   // 只清 mesh 与空间索引
 *   world.add(mesh);                                 // 逐个重新登记（同样不遍历子节点）
 *   await world.build();                             // 只重铺索引，不会重复构建 BVH
 * ------------------------------------------------------------
 */
import * as THREE from 'three';

/** 世界上方向轴：'y' 为 Y-UP（默认），'z' 为 Z-UP */
export type UpAxis = 'y' | 'z';

/** 穿透检测结果：是否有穿透、深度与推出向量（世界空间增量） */
export interface Penetration {
  has: boolean;
  depth: number;
  dx: number;
  dy: number;
  dz: number;
}

/** 挂在 mesh.userData.collisionCache 上的碰撞缓存 */
export interface CollisionCache {
  /** 世界空间包围盒 */
  box: THREE.Box3;
  /** 三个轴缩放绝对值的平均 */
  avgScale: number;
  /** 是否已铺进空间索引 */
  indexed: boolean;
  /** 是否已构建三角面 BVH */
  bvh: boolean;
  /** 是否因跨度过大而进了全局列表 largeMeshes */
  large: boolean;
  /** 占用的空间网格 key，便于失效时精确移除 */
  keys: string[];
}

export interface CollisionWorldOptions {
  /** 空间网格边长（米） */
  gridCell?: number;
  /** 可自动跨越的台阶高度 */
  stepHeight?: number;
  /** 玩家碰撞半径 */
  radius?: number;
  /** 碰撞体沿身体轴的采样高度（相对脚底，沿上轴方向） */
  collideHeights?: number[];
  /** BVH 叶子节点最大三角面数 */
  targetLeafSize?: number;
  /** 世界上方向轴：'y'（默认，Y-UP）或 'z'（Z-UP） */
  upAxis?: UpAxis;
  /** 世界包围盒（外部指定）：传入后不再按网格汇总，build/clear 均以此为准 */
  worldBounds?: THREE.Box3;
  /** build 每帧的处理时间预算（毫秒），每帧至少处理一个模型，超出即让出到下一帧 */
  frameBudgetMs?: number;
}

/** 脚下多点采样偏移（单位为玩家半径的倍数；两轴为水平面两轴：Y-UP 为 x/z，Z-UP 为 x/y） */
const GROUND_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [0, 0], [0.75, 0], [-0.75, 0], [0, 0.75], [0, -0.75]
];
/** 让出主线程一帧，避免长时间构建阻塞渲染 */
const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

export class CollisionWorld {
  gridCell: number;
  stepHeight: number;
  radius: number;
  collideHeights: number[];
  targetLeafSize: number;
  /** build 每帧的处理时间预算（毫秒），每帧至少处理一个模型（可在运行期直接修改） */
  frameBudgetMs: number;

  /** 上方向轴内部值：'y' | 'z'（通过 upAxis 存取器修改，会同步派生量） */
  private _upAxis: UpAxis = 'y';
  /** 上方向的分量索引：Y-UP→1（y），Z-UP→2（z） */
  upIdx: 1 | 2 = 1;
  /** 水平第二轴的分量索引：Y-UP→2（z），Z-UP→1（y）；水平第一轴恒为 x(0) */
  h1Idx: 1 | 2 = 2;
  /** 向下的单位向量（随 upAxis 变化，射线检测复用） */
  private _down = new THREE.Vector3(0, -1, 0);

  /** 全部参与碰撞的网格 */
  meshes: THREE.Mesh[] = [];
  /** 尺寸过大的网格：不进网格索引，任何查询都参与 */
  largeMeshes: THREE.Mesh[] = [];
  /** 空间网格索引 */
  grid = new Map<string, THREE.Mesh[]>();
  /** 所有碰撞体的世界包围盒 */
  worldBounds = new THREE.Box3();
  /** BVH 是否可用（不可用时自动降级为基础射线检测） */
  bvhReady = false;
  /** 是否已加载并给 three-mesh-bvh 打过补丁（只做一次） */
  private _bvhPatched = false;
  /** BVH 模块是否加载失败过（失败后不再每帧重复尝试） */
  private _bvhFailed = false;
  /** 世界包围盒是否需要按缓存重算 */
  private _boundsDirty = false;
  /** 外部指定的世界包围盒（非空时 _rebuildBounds / clear 均以此为准，不再按网格汇总） */
  private _boundsOverride: THREE.Box3 | null = null;

  /** 进行中的 build Promise（防止外部每帧重复调用导致重入） */
  private _buildPromise: Promise<boolean> | null = null;
  /** 当前帧预算的计时起点 */
  private _frameStart = 0;

  /** 已登记的网格，避免同一个 mesh 被重复 add */
  private _registered = new Set<THREE.Mesh>();

  /* ---------- 复用的临时对象，避免每帧分配 ---------- */
  private _nearby: THREE.Mesh[] = [];
  private _nearbySet = new Set<THREE.Mesh>();
  private _scale = new THREE.Vector3();

  private _localC = new THREE.Vector3();
  private _localClosest = new THREE.Vector3();
  private _worldClosest = new THREE.Vector3();
  private _worldA = new THREE.Vector3();
  private _worldB = new THREE.Vector3();
  private _pen: Penetration = { has: false, depth: 0, dx: 0, dy: 0, dz: 0 };

  private _ray = new THREE.Raycaster();
  private _rayOrigin = new THREE.Vector3();
  private _rayHits: THREE.Intersection[] = [];

  private _fallbackRay = new THREE.Raycaster();
  private _fallbackHits: THREE.Intersection[] = [];
  private _fallbackDirs: THREE.Vector3[] = [];

  constructor({
    gridCell = 16,
    stepHeight = 0.5,
    radius = 0.35,
    collideHeights = [0.45, 1.0, 1.55],
    targetLeafSize = 10,
    upAxis = 'y',
    frameBudgetMs = 4,
    worldBounds
  }: CollisionWorldOptions = {}) {
    this.gridCell = gridCell;
    this.stepHeight = stepHeight;
    this.radius = radius;
    this.collideHeights = collideHeights.slice();
    this.targetLeafSize = targetLeafSize;
    this.frameBudgetMs = frameBudgetMs;
    this.upAxis = upAxis;
    /* 外部指定的世界包围盒：优先于按网格汇总的结果 */
    this._boundsOverride = worldBounds ? worldBounds.clone() : null;
    if (this._boundsOverride) this.worldBounds.copy(this._boundsOverride);
  }

  /** 世界上方向轴。修改时会同步派生量（向下射线方向 / 水平面两轴 / 兜底射线方向） */
  get upAxis(): UpAxis { return this._upAxis; }
  set upAxis(axis: UpAxis) {
    this._upAxis = axis;
    this.upIdx = axis === 'z' ? 2 : 1;
    this.h1Idx = (3 - this.upIdx) as 1 | 2;
    this._down.set(0, 0, 0).setComponent(this.upIdx, -1);
    /* 无 BVH 时的兜底射线：水平面内 8 个方向 */
    this._fallbackDirs.length = 0;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const d = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
      d.setComponent(this.h1Idx, Math.sin(a));
      d.setComponent(this.upIdx, 0);
      this._fallbackDirs.push(d);
    }
  }

  /* ================= 碰撞体登记 ================= */

  /** 内部：登记单个网格（重复登记会被忽略），返回是否为新登记 */
  private _addMesh(mesh: THREE.Mesh): boolean {
    if (this._registered.has(mesh)) return false;
    this._registered.add(mesh);
    this.meshes.push(mesh);
    return true;
  }

  /**
   * 登记单个网格作为碰撞体（不遍历子节点）。
   *
   * 只登记传入的 Mesh 本身；若要登记一个对象树，请在业务侧把其所有子节点整理成
   * 扁平 mesh 数组（可按与相机的距离排序）后逐个调用本方法。
   * 重复登记会被自动忽略。
   *
   * 注意：请确保调用前该对象的 matrixWorld 已更新（如 scene.add 后 updateMatrixWorld(true)），
   * 否则建立的包围盒会是旧的世界变换。
   */
  add(mesh: THREE.Mesh | null): THREE.Mesh[] {
    if (!mesh || !(mesh as THREE.Object3D).isObject3D || !(mesh as THREE.Mesh).isMesh) return [];
    return this._addMesh(mesh) ? [mesh] : [];
  }

  /**
   * 取（或创建）一个网格的碰撞缓存。
   * 缓存挂在 mesh.userData.collisionCache 上，build 只需看这些标记即可跳过已处理过的网格。
   */
  private _ensureCache(mesh: THREE.Mesh): CollisionCache {
    let cv = mesh.userData.collisionCache as CollisionCache | undefined;
    if (!cv) {
      cv = { box: new THREE.Box3(), avgScale: 1, indexed: false, bvh: false, large: false, keys: [] };
      mesh.userData.collisionCache = cv;
    }
    return cv;
  }

  /** 处理单个网格：计算世界包围盒 / 平均缩放，并铺进空间索引 */
  private _indexMesh(mesh: THREE.Mesh): void {
    const cv = this._ensureCache(mesh);
    cv.box.setFromObject(mesh);
    mesh.getWorldScale(this._scale);
    cv.avgScale = Math.max(1e-4,
      (Math.abs(this._scale.x) + Math.abs(this._scale.y) + Math.abs(this._scale.z)) / 3);

    const C = this.gridCell;
    const box = cv.box;
    /* 水平面两轴：Y-UP 为 x/z，Z-UP 为 x/y（上轴不参与水平索引） */
    const min0 = box.min.x, max0 = box.max.x;
    const min1 = box.min.getComponent(this.h1Idx), max1 = box.max.getComponent(this.h1Idx);
    const s0 = max0 - min0, s1 = max1 - min1;
    if (!isFinite(s0) || !isFinite(s1) || s0 > 200 || s1 > 200) {
      cv.large = true;                       // 跨度过大 → 任何查询都参与
      this.largeMeshes.push(mesh);
    } else {
      cv.large = false;
      const a0 = Math.floor(min0 / C), a1 = Math.floor(max0 / C);
      const b0 = Math.floor(min1 / C), b1 = Math.floor(max1 / C);
      for (let a = a0; a <= a1; a++) {
        for (let b = b0; b <= b1; b++) {
          const k = a + ',' + b;
          let arr = this.grid.get(k);
          if (!arr) { arr = []; this.grid.set(k, arr); }
          arr.push(mesh);
          cv.keys.push(k);
        }
      }
    }
    cv.indexed = true;
    this._boundsDirty = true;
  }

  /** 按各网格缓存重新汇总世界包围盒（有外部指定 worldBounds 时以外部为准） */
  private _rebuildBounds(): void {
    if (this._boundsOverride) {
      this.worldBounds.copy(this._boundsOverride);
      this._boundsDirty = false;
      return;
    }
    const b = this.worldBounds;
    b.makeEmpty();
    for (const m of this.meshes) {
      const cv = m.userData.collisionCache as CollisionCache | undefined;
      if (cv && cv.indexed) b.union(cv.box);
    }
    this._boundsDirty = false;
  }

  /**
   * 让某个网格的缓存失效（移动 / 缩放 / 替换几何后调用）。
   * 下次 build 会把它重新铺进索引，若几何变了还需把 cv.bvh 置回 false 以重建 BVH。
   */
  invalidate(mesh: THREE.Mesh): boolean {
    const cv = mesh.userData.collisionCache as CollisionCache | undefined;
    if (!cv || !cv.indexed) return false;
    if (cv.large) {
      const i = this.largeMeshes.indexOf(mesh);
      if (i !== -1) this.largeMeshes.splice(i, 1);
    } else {
      for (const k of cv.keys) {
        const arr = this.grid.get(k);
        if (!arr) continue;
        const j = arr.indexOf(mesh);
        if (j !== -1) arr.splice(j, 1);
        if (!arr.length) this.grid.delete(k);
      }
    }
    cv.keys.length = 0;
    cv.indexed = false;
    this._boundsDirty = true;
    return true;
  }

  /**
   * 清空当前登记的全部碰撞体与空间索引。
   *
   * 适用于「每帧 clear() 后重新 add 一批网格」的用法：
   *   - 网格列表、空间网格索引、全局大网格列表、世界包围盒统统清空；
   *   - 每个网格 userData.collisionCache 上的缓存予以保留：
   *       · indexed / large / keys 复位 → 重新 add 后会被重新铺进索引；
   *       · bvh 保留，且几何体上的 BVH 并未释放 → build 时无需重建 BVH（省掉最贵的一步）。
   * 若某个网格换了几何，请把它缓存里的 bvh 置回 false（或调用 invalidate）。
   */
  clear(): void {
    for (const m of this.meshes) {
      const cv = m.userData.collisionCache as CollisionCache | undefined;
      if (!cv) continue;
      cv.indexed = false;
      cv.large = false;
      cv.keys.length = 0;
    }
    this.meshes.length = 0;
    this._registered.clear();
    this.grid.clear();
    this.largeMeshes.length = 0;
    /* 有外部指定的世界包围盒时恢复之，否则清空 */
    if (this._boundsOverride) this.worldBounds.copy(this._boundsOverride);
    else this.worldBounds.makeEmpty();
    this._boundsDirty = false;
  }

  /* ================= 构建：包围盒 + 网格索引 + BVH ================= */

  /**
   * 构建碰撞数据（增量 / 幂等：可安全地在每一帧调用）
   *
   * - 防重入：外部可以每帧重复调用（requestAnimationFrame 保证每帧执行），
   *   同一时刻只会存在一个构建流程，构建期间重复调用会直接返回进行中的 Promise；
   * - 时间预算：每帧的处理时间不超过 frameBudgetMs（默认 4ms，可配置），
   *   且每帧至少处理一个模型；预算用完即让出到下一帧，未处理完的模型由后续帧继续。
   *
   * 依赖 mesh.userData.collisionCache 中的标记来判断网格是否已处理：
   *   - 已 indexed 的网格不会再被铺进空间索引；
   *   - 已 bvh 的网格不会再构建 BVH；
   *   - 没有新增内容时直接返回，不做任何遍历以外的开销。
   * 因此「每帧 add 一批不同的 mesh + 每帧 build」也不会重复处理旧网格。
   *
   * @param options.onProgress 进度回调（构建期间重复调用时，以首次调用的回调为准）
   * @returns BVH 是否可用
   */
  build({ onProgress }: { onProgress?: (progress: number, tip: string) => void } = {}): Promise<boolean> {
    if (this._buildPromise) return this._buildPromise;
    const p = this._buildCore(onProgress).finally(() => { this._buildPromise = null; });
    this._buildPromise = p;
    return p;
  }

  /** 记录当前帧预算的计时起点 */
  private _startBudget(): void {
    this._frameStart = performance.now();
  }

  /**
   * 当前帧预算是否已用完。
   * @param processed 本帧已处理的模型数（保证每帧至少处理一个模型，0 时永不让出）
   */
  private _budgetExceeded(processed: number): boolean {
    if (processed <= 0) return false;
    return performance.now() - this._frameStart >= this.frameBudgetMs;
  }

  private async _buildCore(onProgress?: (progress: number, tip: string) => void): Promise<boolean> {
    const report = onProgress || ((): void => {});
    this._startBudget();
    let processed = 0;                     // 本帧已处理的模型数

    /* --- 1. 增量铺进空间索引：只处理还没有缓存的网格 --- */
    let newCount = 0;
    for (let i = 0; i < this.meshes.length; i++) {
      const m = this.meshes[i];
      const cv = m.userData.collisionCache as CollisionCache | undefined;
      if (cv && cv.indexed) continue;        // 已处理过 → 跳过
      this._indexMesh(m);
      newCount++;
      processed++;
      if (this._budgetExceeded(processed)) { // 预算用完 → 让出到下一帧继续
        report(0.62, '建立空间索引…');
        await nextFrame();
        this._startBudget();
        processed = 0;
      }
    }
    if (this._boundsDirty) this._rebuildBounds();
    if (newCount > 0) report(0.62, '建立空间索引…');

    /* --- 2. 增量构建 BVH：只为还没有 BVH 的网格 --- */
    const pending: THREE.Mesh[] = [];
    for (const m of this.meshes) {
      const cv = m.userData.collisionCache as CollisionCache | undefined;
      if (!cv) continue;
      const g = m.geometry;
      // 缓存标记为已构建、且几何体上确实还挂着 BVH → 跳过
      if (cv.bvh && (!g || g.boundsTree)) continue;
      if (g && g.attributes.position && g.attributes.position.count >= 3) pending.push(m);
      else cv.bvh = true;                    // 没有可用的几何 → 视作已处理
    }

    if (pending.length === 0) return this.bvhReady;
    if (this._bvhFailed) return this.bvhReady;

    await nextFrame();
    this._startBudget();
    processed = 0;
    report(0.66, '构建碰撞体 BVH…');
    try {
      const bvhMod = await import('three-mesh-bvh');
      if (!this._bvhPatched) {
        THREE.BufferGeometry.prototype.computeBoundsTree = bvhMod.computeBoundsTree;
        THREE.BufferGeometry.prototype.disposeBoundsTree = bvhMod.disposeBoundsTree;
        THREE.Mesh.prototype.raycast = bvhMod.acceleratedRaycast;
        this._bvhPatched = true;
      }
      const total = pending.length;
      for (let i = 0; i < total; i++) {
        const m = pending[i];
        m.geometry.computeBoundsTree({ targetLeafSize: this.targetLeafSize });
        (m.userData.collisionCache as CollisionCache).bvh = true;
        processed++;
        if (this._budgetExceeded(processed)) { // 预算用完 → 让出到下一帧继续
          report(0.66 + ((i + 1) / total) * 0.32, `构建碰撞体 BVH ${i + 1} / ${total}`);
          await nextFrame();
          this._startBudget();
          processed = 0;
        }
      }
      this.bvhReady = true;
    } catch (e) {
      console.warn('[碰撞] three-mesh-bvh 加载失败，回退为基础射线检测：', e);
      this._bvhFailed = true;
      this.bvhReady = false;
    }
    return this.bvhReady;
  }

  /* ================= 空间查询 ================= */

  /**
   * 查询某个水平位置附近的候选碰撞体（返回的是内部复用数组，用完即弃）。
   * 参数为水平面两轴坐标：Y-UP 传 (x, z)，Z-UP 传 (x, y)。
   */
  queryNearby(h0: number, h1: number, radius: number): THREE.Mesh[] {
    const out = this._nearby;
    const seen = this._nearbySet;
    out.length = 0;
    seen.clear();
    for (const m of this.largeMeshes) { out.push(m); seen.add(m); }

    const C = this.gridCell;
    const a0 = Math.floor((h0 - radius) / C), a1 = Math.floor((h0 + radius) / C);
    const b0 = Math.floor((h1 - radius) / C), b1 = Math.floor((h1 + radius) / C);
    for (let a = a0; a <= a1; a++) {
      for (let b = b0; b <= b1; b++) {
        const arr = this.grid.get(a + ',' + b);
        if (!arr) continue;
        for (const m of arr) if (!seen.has(m)) { seen.add(m); out.push(m); }
      }
    }
    return out;
  }

  /* ================= 球体 vs 三角面 穿透检测 =================
   * 把玩家近似为沿身体轴分布的若干小球，求最深穿透并推出。
   * 接触点高度不超过「可跨越台阶高度」的面视为地面/台阶，不参与阻挡。
   */

  /**
   * 单个采样球与单个网格的穿透检测
   * @param cx 球心（世界坐标）
   * @param stepTopY 沿上轴低于此高度的接触面视为台阶/地面，可跨越
   * @param out 输出
   */
  collideMesh(mesh: THREE.Mesh, cx: number, cy: number, cz: number, radius: number, stepTopY: number, out: Penetration): void {
    const cv = mesh.userData.collisionCache as CollisionCache | undefined;
    const box = cv && cv.box;
    if (box && box.distanceToPoint(this._worldA.set(cx, cy, cz)) > radius + 0.05) return;

    const geom = mesh.geometry;
    const bvh = geom && geom.boundsTree;
    if (!bvh) { this.collideMeshByRays(mesh, cx, cy, cz, radius, stepTopY, out); return; }

    const localC = this._localC;
    const localClosest = this._localClosest;
    const worldClosest = this._worldClosest;
    const worldA = this._worldA;
    const worldB = this._worldB;

    const s = cv ? cv.avgScale : 1;
    localC.set(cx, cy, cz);
    mesh.worldToLocal(localC);
    const localRadius = radius / s;

    bvh.shapecast({
      intersectsBounds: (b) => b.distanceToPoint(localC) <= localRadius,
      intersectsTriangle: (tri) => {
        tri.closestPointToPoint(localC, localClosest);
        const d = localClosest.distanceTo(localC);
        if (d >= localRadius) return false;

        worldClosest.copy(localClosest);
        mesh.localToWorld(worldClosest);
        if (worldClosest.getComponent(this.upIdx) <= stepTopY) return false;   // 属于可跨越的台阶/地面

        const depth = localRadius - d;
        if (depth > out.depth) {
          worldA.copy(localC);
          mesh.localToWorld(worldA);
          if (d > 1e-6) localClosest.subVectors(localC, localClosest).normalize().multiplyScalar(depth);
          else localClosest.set(0, 0, 0).setComponent(this.upIdx, localRadius);   // 退化时沿上轴推出
          worldB.copy(localC).add(localClosest);
          mesh.localToWorld(worldB);
          out.has = true;
          out.depth = depth;
          out.dx = worldB.x - worldA.x;
          out.dy = worldB.y - worldA.y;
          out.dz = worldB.z - worldA.z;
        }
        return false;
      }
    });
  }

  /** 无 BVH 时的兜底方案：向四周打射线近似推开 */
  private collideMeshByRays(mesh: THREE.Mesh, cx: number, cy: number, cz: number, radius: number, stepTopY: number, out: Penetration): void {
    const ray = this._fallbackRay;
    const hits = this._fallbackHits;
    for (const dir of this._fallbackDirs) {
      ray.set(this._worldA.set(cx, cy, cz), dir);
      ray.near = 0;
      ray.far = radius;
      hits.length = 0;
      ray.intersectObject(mesh, false, hits);
      if (!hits.length) continue;
      const h = hits[0];
      if (h.point.getComponent(this.upIdx) <= stepTopY) continue;
      const depth = radius - h.distance;
      if (depth > out.depth) {
        out.has = true; out.depth = depth;
        out.dx = -dir.x * depth;                            // 水平第一轴恒为 x
        out.dy = this.h1Idx === 1 ? -dir.y * depth : 0;     // 水平第二轴（Z-UP 时为 y）
        out.dz = this.h1Idx === 2 ? -dir.z * depth : 0;     // 水平第二轴（Y-UP 时为 z）
      }
    }
  }

  /**
   * 把位置从几何体中推出（含头顶天花板处理）。只沿水平两轴修正，不改变上轴高度。
   * @param pos 会被就地修改（仅水平两轴：Y-UP 为 x/z，Z-UP 为 x/y）
   * @param meshes 候选碰撞体
   * @param feetY 脚底高度（沿上轴）
   */
  resolvePenetration(pos: THREE.Vector3, meshes: THREE.Mesh[], feetY: number = pos.getComponent(this.upIdx)): { collided: boolean; hitCeiling: boolean } {
    const pen = this._pen;
    const nHeights = this.collideHeights.length;
    let collided = false;
    let hitCeiling = false;

    for (let iter = 0; iter < 3; iter++) {
      let bestDepth = 0, bdx = 0, bdz = 0, bdy = 0, topContact = false;
      for (let i = 0; i < nHeights; i++) {
        /* 采样球心：水平两轴取 pos，上轴取 feetY + 采样高度 */
        const upC = feetY + this.collideHeights[i];
        const cx = pos.x;
        const cy = this.upIdx === 1 ? upC : pos.y;
        const cz = this.upIdx === 2 ? upC : pos.z;
        for (let n = 0; n < meshes.length; n++) {
          pen.has = false; pen.depth = 0;
          this.collideMesh(meshes[n], cx, cy, cz, this.radius, feetY + this.stepHeight, pen);
          if (pen.has && pen.depth > bestDepth) {
            bestDepth = pen.depth; bdx = pen.dx; bdy = pen.dy; bdz = pen.dz;
            topContact = (i === nHeights - 1);
          }
        }
      }
      if (bestDepth < 1e-3) break;
      collided = true;
      /* 只修正水平两轴分量 */
      pos.x += bdx;
      if (this.h1Idx === 1) pos.y += bdy; else pos.z += bdz;
      const pushUp = this.upIdx === 1 ? bdy : bdz;
      if (topContact && pushUp < -0.02) hitCeiling = true;   // 头顶撞到天花板
    }
    return { collided, hitCeiling };
  }

  /* ================= 地面高度采样 ================= */

  /**
   * 从水平坐标 (h0, h1)、沿上轴高度 originUp 处向下打一条射线，返回最近命中（无命中返回 null）。
   * Y-UP 时 h0/h1/originUp 即 (x, z, y)；Z-UP 时即 (x, y, z)。
   */
  castDown(h0: number, h1: number, originUp: number, distance: number, meshes: THREE.Mesh[]): THREE.Intersection | null {
    const ray = this._ray;
    ray.firstHitOnly = this.bvhReady;
    this._rayOrigin.set(h0, 0, 0);
    this._rayOrigin.setComponent(this.h1Idx, h1);
    this._rayOrigin.setComponent(this.upIdx, originUp);
    ray.set(this._rayOrigin, this._down);
    ray.near = 0;
    ray.far = distance;
    this._rayHits.length = 0;
    ray.intersectObjects(meshes, false, this._rayHits);
    return this._rayHits.length ? this._rayHits[0] : null;
  }

  /**
   * 取脚下多点射线的可站立面（返回值均为沿上轴的高度）
   * @param pos 脚底位置
   * @param meshes 候选碰撞体
   * @param upAllow 允许抬升（上台阶 / 被屋面托回）的最大高度
   * @param downLimit 向下识别地面的范围
   *
   * 注意：只有中心射线（GROUND_OFFSETS[0]）允许"向上吸附"。
   * 侧向射线只负责向下找地面，否则会出现两种抖动：
   *   1) 下落时脚边有路缘/台阶，射线打在其上表面把玩家顶起来 → 落点弹跳
   *   2) 走下台阶时被身后的台阶上表面吸住 → 台阶"粘脚"
   * 而中心射线的放宽是必要的：当玩家贴着屋檐跳、身体已进入建筑体积、
   * 脚底略低于屋面时，只能靠中心射线从上往下打到屋面把他托回房顶。
   */
  sampleGround(pos: THREE.Vector3, meshes: THREE.Mesh[], upAllow: number = this.stepHeight, downLimit: number = 0.8): { snapY: number; belowY: number } {
    const feetY = pos.getComponent(this.upIdx);
    const probeDown = Math.max(9, downLimit + 1);
    let snapY = -Infinity, belowY = -Infinity;
    const r = this.radius;
    for (let i = 0; i < GROUND_OFFSETS.length; i++) {
      const up = i === 0 ? upAllow : 0.05;
      const probeUp = up + 0.05;
      const hit = this.castDown(
        pos.x + GROUND_OFFSETS[i][0] * r,
        pos.getComponent(this.h1Idx) + GROUND_OFFSETS[i][1] * r,
        feetY + probeUp, probeUp + probeDown, meshes
      );
      if (!hit) continue;
      const y = hit.point.getComponent(this.upIdx);
      if (y > feetY + probeUp) continue;
      if (y > belowY) belowY = y;
      if (y >= feetY - downLimit && y > snapY) snapY = y;
    }
    return { snapY, belowY };
  }

  /* ================= 清理 ================= */

  /** 释放 BVH 与索引数据（与 clear 的区别：连网格上的缓存也一并销毁，BVH 真正释放） */
  dispose(): void {
    for (const m of this.meshes) {
      const cv = m.userData.collisionCache as CollisionCache | undefined;
      const g = m.geometry;
      if (cv && cv.bvh && g && g.boundsTree && typeof g.disposeBoundsTree === 'function') g.disposeBoundsTree();
      delete m.userData.collisionCache;
    }
    this.clear();
    this._bvhFailed = false;
    this.bvhReady = false;
  }
}

export default CollisionWorld;
