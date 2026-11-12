/**
 * 玩家（Player）
 * ------------------------------------------------------------
 * 职责：
 *   1. 维护玩家状态（位置 / 速度 / 朝向 / 着地 / 飞行 等）；
 *   2. 绑定玩家相关按键（Space 跳跃缓冲 / F 飞行切换 / R 回出生点）；
 *   3. 每帧推进物理与移动（步行碰撞滑行、台阶跨越、跳跃、飞行）；
 *   4. 每帧同步第三人称角色模型（person.update 由 update 内部调用）；
 *   5. 每帧更新第三人称相机（平滑跟随 / 落地缓冲 / 防穿墙 / 动态 FOV）；
 *   6. exitThirdPerson() 退出第三人称 / enterThirdPerson() 恢复第三人称（OrbitControls
 *      的创建销毁由外部经 onViewToggle 回调处理；FOV 在激活时从相机读取、退出时恢复）；
 *   7. toggleView(isActive?) 切换第三人称 / OrbitControls 视角（已绑定 V 键，任何模式下均可用；
 *      isActive=true 强制进入、false 强制退出，不传则取反当前状态）；
 *   8. initialize(object3d, opts?) 封装初始化流程：登记碰撞体 → 加载角色模型 → 构建碰撞数据 → 定位出生点并就位
 *      （opts.spawnPoint 指定出生点，合法时直接使用，否则回退到 findSpawn 自动寻找；
 *       DOM 相关操作如进度展示、错误提示、启动渲染循环由外部处理）。
 *
 * 用法：
 *   const player = new Player({ camera, config: CONFIG, collidersBounds });
 *   scene.add(player.object3D);                 // 角色模型容器由外部挂到场景
 *   // collidersBounds（THREE.Box3）为碰撞世界初始包围盒，需在场景与碰撞体就绪后计算传入
 *   // 支持 Y-UP（默认）与 Z-UP：在 CONFIG 中传 upAxis: 'z' 即可，会同步到碰撞世界与角色模型
 *   await player.initialize(gltf.scene, { onProgress }); // 一步完成：登记碰撞体 → 加载角色模型 → 构建碰撞数据 → 定位出生点并就位
 *   player.clearColliders();                     // 需要更换碰撞体时清空后重新 initialize / refreshColliders
 *   player.toggleView(false);                    // 手动切换视角（可选；内部已绑定 V 键随时切换）
 *                                                // isActive=true 强制进入第三人称、false 强制退出，不传则取反当前状态
 *   // 主循环中：
 *   if (!paused) player.update(dt);              // 内部每帧同步角色模型、更新相机并增量构建碰撞数据（登记由业务代码控制）
 * ------------------------------------------------------------
 */
import * as THREE from 'three';
import { CollisionWorld, type UpAxis, type Penetration } from './CollisionWorld';

/** 穿透检测结果（转发 collision.ts 的类型，供 Player.findSpawn 使用） */
export type { Penetration };
import { Person, type AnimClipNames } from './PersonModel';
import { Keyboard } from './KeyBind';

/** 玩家体型常量（碰撞半径 / 身高 / 视线高度） */
export const PLAYER = { radius: 0.35, height: 1.8, eyeHeight: 1.62 } as const;

/** 游戏运行配置（移动 / 相机 / 角色模型等），所有字段均可省略并使用默认值 */
export interface GameConfig {
  /** 第三人称角色模型（.glb）地址（必填；传空字符串则不显示角色） */
  charUrl: string;
  /** 角色模型各动画状态使用的 clip 名称（必填；名称不区分大小写） */
  animClips: AnimClipNames;
  /** 重力加速度 */
  gravity?: number;
  /** 步行速度 */
  walkSpeed?: number;
  /** 奔跑速度 */
  runSpeed?: number;
  /** 起跳初速度 */
  jumpSpeed?: number;
  /** 最大下落速度 */
  maxFallSpeed?: number;
  /** 飞行速度 */
  flySpeed?: number;
  /** 可自动跨越的台阶高度 */
  stepHeight?: number;
  /** 鼠标视角灵敏度 */
  lookSensitivity?: number;
  /** 单次位移子步长，防止高速穿透 */
  maxSubStep?: number;
  /** 空间网格索引边长（米） */
  gridCell?: number;
  /** 第三人称相机与角色的距离 */
  camDist?: number;
  /** 世界上方向轴：'y'（默认，Y-UP）或 'z'（Z-UP） */
  upAxis?: UpAxis;
  /** Person 模型缩放（默认 1，等比缩放角色模型） */
  personScale?: number;
  /** 角色模型原生朝向：'+z'（glTF 惯例，默认）或 '-z'（如 Soldier.glb） */
  personFacing?: '+z' | '-z';
}

/** GameConfig 可选字段默认值（不含必填的 charUrl / animClips）：构造 Player 时与传入配置合并 */
export const DEFAULT_CONFIG: Required<Omit<GameConfig, 'charUrl' | 'animClips'>> = {
  gravity: 26,
  walkSpeed: 4.6,
  runSpeed: 8.2,
  jumpSpeed: 8.4,
  maxFallSpeed: 60,
  flySpeed: 24,
  stepHeight: 0.5,
  lookSensitivity: 0.0022,
  maxSubStep: 0.25,
  gridCell: 16,
  camDist: 4.2,
  upAxis: 'y',
  personScale: 1,
  personFacing: '+z'
};

export interface PlayerOptions {
  /** 相机（飞行时按视线方向移动） */
  camera: THREE.PerspectiveCamera;
  /** 移动相关配置 */
  config: GameConfig;
  /** 碰撞世界初始包围盒（世界范围，用于出生点探测与掉出场景保护） */
  collidersBounds: THREE.Box3;
  /** 视角模式切换回调（true=激活玩家第三人称控制，false=退出，交由外部 OrbitControls 处理） */
  onViewToggle?: (isActive: boolean) => void;
}

/** 朝向基向量：Y-UP 与 Z-UP 共用同一套 yaw 约定（yaw=0 朝水平 -h1 方向） */
function setBasis(yaw: number, fwd: THREE.Vector3, right: THREE.Vector3, upIdx: 1 | 2): void {
  const s = Math.sin(yaw), c = Math.cos(yaw);
  if (upIdx === 2) {
    /* Z-UP：水平面为 x/y，上轴为 z；right = fwd × up */
    fwd.set(-s, -c, 0);
    right.set(-c, s, 0);
  } else {
    /* Y-UP：水平面为 x/z，上轴为 y */
    fwd.set(-s, 0, -c);
    right.set(c, 0, -s);
  }
}

/* 复用临时向量，避免每帧分配 */
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _wish = new THREE.Vector3();
const _target = new THREE.Vector3();
const _flyMove = new THREE.Vector3();
const _focus = new THREE.Vector3();
const _lookDir = new THREE.Vector3();
const _camGoal = new THREE.Vector3();
const _rayDir = new THREE.Vector3();
const camRay = new THREE.Raycaster();

export class Player {
  /** 碰撞世界（内部创建并持有；公开以便 findSpawn 等做出生点探测） */
  readonly collision: CollisionWorld;
  keyboard: Keyboard;
  camera: THREE.PerspectiveCamera;
  config: Required<GameConfig>;
  /** 世界上方向轴（来自 config.upAxis，默认 'y'；并会同步到碰撞世界与角色模型） */
  upAxis: UpAxis = 'y';
  /** 上方向单位向量（随 upAxis 确定） */
  readonly up = new THREE.Vector3(0, 1, 0);
  /** 上方向 / 水平第二轴的分量索引：Y-UP→1/2，Z-UP→2/1（水平第一轴恒为 x） */
  private _upIdx: 1 | 2 = 1;
  private _h1Idx: 1 | 2 = 2;
  /** 第三人称角色（载入与姿态控制封装在 person.ts） */
  person: Person | null;
  /** 角色模型容器：需要被添加到 scene 的 Object3D（构造后由外部 scene.add(this.object3D)） */
  readonly object3D = new THREE.Group();
  spawnPoint = new THREE.Vector3(0, 2, 0);

  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  vy = 0;
  yaw = 0;
  pitch = -0.18;
  grounded = false;
  /** 悬空状态：走到脚下没有地面的位置时保持当前高度，不下坠 */
  hovering = false;
  /** 是否处于跳跃动作中（仅按空格起跳后为 true，落地/悬空/飞行时清除），供动画状态机使用 */
  jumping = false;
  groundY = 0;
  coyote = 0;
  jumpBuffer = 0;
  fly = false;
  /** 相机跟随用的平滑脚底高度 */
  smoothY = 0;
  /** 落地缓冲下压量 */
  landDip = 0;
  landDipVel = 0;
  /** 基线 FOV：激活（含构造时）从 camera.fov 读取，退出第三人称时恢复给相机 */
  fovBase = 75;
  /** 当前动态 FOV（围绕 fovBase 平滑过渡；退出第三人称时恢复 fovBase） */
  fovCurrent = 75;
  /** 玩家是否激活（第三人称控制；false 时相机交给外部创建的 OrbitControls） */
  isActive = true;
  /** 视角模式切换回调（退出/进入第三人称时触发；OrbitControls 创建销毁由外部处理） */
  onViewToggle: ((isActive: boolean) => void) | null = null;
  /** 已绑定的按键取消订阅函数（退出第三人称时用于解绑） */
  private _unbinds: Array<() => void> = [];
  /** KeyV（视角切换）的取消订阅函数：该键在任何模式下都保持有效 */
  private _unbindToggle: (() => void) | null = null;

  constructor({ camera, config, collidersBounds, onViewToggle }: PlayerOptions) {
    /* 合并默认值：传入项优先（charUrl / animClips 为必填，不经默认合并） */
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.collision = new CollisionWorld({
      gridCell: this.config.gridCell,
      stepHeight: this.config.stepHeight,
      radius: PLAYER.radius,
      upAxis: this.config.upAxis,
      worldBounds: collidersBounds
    });
    this.keyboard = new Keyboard({
      preventKeys: ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'KeyQ', 'KeyE']
    });
    this.camera = camera;
    /* 激活：从相机读取基线 FOV，动态 FOV 围绕它过渡 */
    this.fovBase = camera.fov;
    this.fovCurrent = camera.fov;
    this.onViewToggle = onViewToggle ?? null;

    /* 上轴配置：同步到自身的派生量与角色模型（碰撞世界已在构造时传入 upAxis） */
    this.upAxis = this.config.upAxis;
    this._upIdx = this.upAxis === 'z' ? 2 : 1;
    this._h1Idx = (3 - this._upIdx) as 1 | 2;
    this.up.set(0, 0, 0).setComponent(this._upIdx, 1);

    this.person = this.config.charUrl
      ? new Person({ url: this.config.charUrl, parent: this.object3D, walkSpeed: this.config.walkSpeed, upAxis: this.upAxis, animClips: this.config.animClips, scale: this.config.personScale, facing: this.config.personFacing })
      : null;

    this.bindInput();
  }

  /**
   * 初始化玩家（原 main.ts init 中的非 DOM 逻辑）：
   *   登记碰撞体 → 加载第三人称角色模型 → 构建碰撞数据 → 定位出生点并就位。
   * @param colliderRoot 碰撞体根节点（连同其所有后代网格登记为碰撞体；调用前请确保 matrixWorld 已更新）
   * @param opts.spawnPoint 指定出生点（可选）：合法时直接使用，不合法（不在世界内 / 脚下无地面 / 被碰撞体卡住）则回退到 findSpawn 自动寻找
   * @param opts.onProgress 加载进度回调（progress∈[0,1]，tip 为提示文案），外部可用来更新 DOM 加载条
   */
  async initialize(colliderRoot: THREE.Object3D, opts: { spawnPoint?: THREE.Vector3; onProgress?: (progress: number, tip: string) => void } = {}): Promise<void> {
    const progress = opts.onProgress ?? (() => {});

    /* 登记所有碰撞体（子网格扁平化后按与相机的距离排序，逐个登记） */
    this.registerColliders(colliderRoot);

    /* 加载第三人称角色模型（失败则进入无角色模式，不阻塞初始化） */
    progress(0.62, '加载角色模型…');
    if (this.person) {
      try {
        await this.person.load();
      } catch (err) {
        console.warn('角色模型加载失败，进入无角色模式', err);
      }
    }

    /* 构建碰撞数据（增量 / 幂等） */
    await this.buildCollision({ onProgress: progress });

    /* 定位出生点并就位（内部同步角色到出生点并让相机直接就位，避免开场从原点飞过来）：
       指定出生点合法时直接使用，否则回退到自动寻找 */
    progress(0.99, '定位出生点…');
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    const spawn = opts.spawnPoint;
    this.spawnPoint = (spawn && this.isSpawnValid(spawn)) ? spawn : this.findSpawn();
    this.resetToSpawn();
  }

  /**
   * 校验一个出生点是否合法（与 findSpawn 的挑选标准一致）：
   *   1. 位于碰撞世界包围盒内；
   *   2. 脚下（沿上方向下 2.5m 内）有地面；
   *   3. 身体各高度处没有被碰撞体卡住。
   */
  isSpawnValid(spawn: THREE.Vector3): boolean {
    const collision = this.collision;
    /* 必须在世界包围盒内 */
    if (collision.worldBounds.containsPoint(spawn) === false) return false;

    /* 脚下必须有地面（超过 stepHeight 一点的容差，允许略微贴地） */
    const meshes = collision.queryNearby(spawn.x, spawn.z, PLAYER.radius + 1.6);
    const hit = collision.castDown(spawn.x, spawn.z, spawn.y, 2.5, meshes);
    if (!hit) return false;

    /* 身体各高度处不得被碰撞体穿透（复用 findSpawn 的 blocked 判定） */
    const pen: Penetration = { has: false, depth: 0, dx: 0, dy: 0, dz: 0 };
    for (const h of collision.collideHeights) {
      for (const m of meshes) {
        pen.has = false; pen.depth = 0;
        collision.collideMesh(m, spawn.x, spawn.y + h, spawn.z, collision.radius + 0.05, spawn.y + collision.stepHeight, pen);
        if (pen.has && pen.depth > 0.02) return false;
      }
    }
    return true;
  }

  /** 绑定玩家相关按键（记录取消订阅函数，便于退出第三人称时解绑；KeyV 永远保持绑定） */
  bindInput(): void {
    const kb = this.keyboard;
    /* 先解绑旧回调再重绑：外部直接改 isActive 绕过 exitThirdPerson 时，避免重复注册
       （重复注册会让 fly 这类取反型回调被触发两次，等于没生效） */
    for (const off of this._unbinds) off();
    this._unbinds = [
      kb.onPress('Space', () => { this.jumpBuffer = 0.16; }),
      kb.onPress('KeyF', () => { this.fly = !this.fly; this.vel.set(0, 0, 0); this.vy = 0; this.hovering = false; this.jumping = false; }),
      kb.onPress('KeyR', () => this.resetToSpawn())
    ];
    /* KeyV 独立绑定：第三人称与 OrbitControls 模式下都能切换视角 */
    this._unbindToggle?.();
    this._unbindToggle = kb.onPress('KeyV', () => this.toggleView());
  }

  /* ================= 碰撞世界门面 ================= */

  /**
   * 把传入对象及其所有子节点整理成扁平的 mesh 数组，按与相机的距离由近到远排序，
   * 再逐个传给 collision.add 登记（登记顺序即 build 顺序 → 近处网格优先建索引与 BVH）。
   * 重复登记会被自动忽略。注意：调用前请确保该对象的 matrixWorld 已更新。
   */
  private registerColliders(object: THREE.Object3D | null): THREE.Mesh[] {
    const added: THREE.Mesh[] = [];
    if (!object || !object.isObject3D) return added;

    /* 1. 扁平化：收集全部后代 Mesh */
    const meshes: THREE.Mesh[] = [];
    object.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
    });
    if (!meshes.length) return added;

    /* 2. 按包围球中心与相机的距离升序排序（近 → 远） */
    const camPos = this.camera.position;
    const center = new THREE.Vector3();
    const entries = meshes.map((mesh) => {
      const g = mesh.geometry;
      if (g && !g.boundingSphere) g.computeBoundingSphere();
      const bs = g ? g.boundingSphere : null;
      if (bs) center.copy(bs.center).applyMatrix4(mesh.matrixWorld);
      else mesh.getWorldPosition(center);
      return { mesh, d2: center.distanceToSquared(camPos) };
    });
    entries.sort((a, b) => a.d2 - b.d2);

    /* 3. 逐个登记 */
    for (const { mesh } of entries) {
      const r = this.collision.add(mesh);
      if (r.length) added.push(mesh);
    }
    return added;
  }

  /**
   * 清空已登记的全部碰撞体（含空间索引），由业务代码决定何时重新登记。
   * 网格上的碰撞缓存（包围盒 / BVH）会保留，重新 add + build 后无需重建 BVH。
   */
  clearColliders(): void {
    this.collision.clear();
  }

  /**
   * 刷新碰撞体：清空现有碰撞体 → 登记传入 group（扁平化为 mesh 数组并按与相机的距离排序后逐个登记）
   * → 重新构建碰撞数据。适用于整体更换碰撞体来源的场景（如场景切换 / 动态建筑更新）。
   * @param group 碰撞体根节点（调用前请确保其 matrixWorld 已更新）
   * @param opts.onProgress 构建进度回调
   * @returns BVH 是否可用
   */
  async refreshColliders(group: THREE.Object3D | null, opts: { onProgress?: (progress: number, tip: string) => void } = {}): Promise<boolean> {
    this.clearColliders();
    this.registerColliders(group);
    return this.buildCollision(opts);
  }

  /**
   * 构建碰撞数据（增量 / 幂等：可安全地重复调用，只为新增网格建索引与 BVH）。
   * @param opts.onProgress 进度回调
   * @returns BVH 是否可用
   */
  async buildCollision(opts: { onProgress?: (progress: number, tip: string) => void } = {}): Promise<boolean> {
    return this.collision.build(opts);
  }

  /** BVH 是否可用（不可用时碰撞内部已自动降级为基础射线检测） */
  get bvhReady(): boolean {
    return this.collision.bvhReady;
  }

  /** 每帧增量构建碰撞数据（BVH 缓存在几何体上，不会重建） */
  private refreshCollision(): void {
    this.collision.build();
  }

  /**
   * 鼠标视角控制：由外部鼠标事件驱动（指针锁定或按住拖动均可调用）。
   * @param dx 水平位移（e.movementX）
   * @param dy 垂直位移（e.movementY）
   */
  look(dx: number, dy: number): void {
    if (!this.isActive) return;   // 未激活时视角由 OrbitControls 接管
    const sens = this.config.lookSensitivity;
    this.yaw -= dx * sens;
    this.pitch -= dy * sens;
    const lim = Math.PI / 2 - 0.02;
    this.pitch = Math.max(-lim, Math.min(lim, this.pitch));
  }

  /* ================= 第三人称 / three 默认交互切换 ================= */

  /**
   * 退出第三人称视角（OrbitControls 创建由 onViewToggle 回调方处理；FOV 在此处恢复为激活时记录的基线值）：
   *   1. 解绑玩家移动按键，清空按键状态；
   *   2. 退出指针锁定，把鼠标还给页面。
   */
  exitThirdPerson(): void {
    if (!this.isActive) return;
    this.isActive = false;
    for (const off of this._unbinds) off();
    this._unbinds = [];
    this.keyboard.clear();

    /* 恢复激活前相机的 FOV（消除第三人称动态 FOV 残留） */
    if (Math.abs(this.camera.fov - this.fovBase) > 0.01) {
      this.camera.fov = this.fovBase;
      this.camera.updateProjectionMatrix();
    }
    this.fovCurrent = this.fovBase;

    /* 释放指针锁定（main.ts 的 pointerlockchange 已按 isActive 守卫，不会弹出暂停遮罩） */
    if (document.pointerLockElement) document.exitPointerLock();

    this.onViewToggle?.(false);
  }

  /** 恢复第三人称视角：OrbitControls 销毁由回调方处理；按当前相机方向恢复 yaw/pitch，保证视角连续 */
  enterThirdPerson(): void {
    if (this.isActive) return;
    this.isActive = true;
    /* 激活：从当前相机读取基线 FOV（退出时恢复该值），动态 FOV 围绕它过渡 */
    this.fovBase = this.camera.fov;
    this.fovCurrent = this.camera.fov;
    this.onViewToggle?.(true);

    /* 由当前相机视线方向反推 yaw / pitch（与 updateCamera 的正推公式互为逆运算） */
    this.camera.getWorldDirection(_lookDir);
    const lim = Math.PI / 2 - 0.02;
    this.pitch = Math.max(-lim, Math.min(lim, Math.asin(THREE.MathUtils.clamp(_lookDir.getComponent(this._upIdx), -1, 1))));
    if (this._upIdx === 2) {
      this.yaw = Math.atan2(-_lookDir.x, -_lookDir.y);
    } else {
      this.yaw = Math.atan2(-_lookDir.x, -_lookDir.z);
    }

    this.bindInput();
    this.updateCamera(1);   // 立即让相机回到角色身后的第三人称机位
  }

  /**
   * 切换激活状态（第三人称 / three 默认交互 OrbitControls）。
   * @param isActive 可选：true 强制进入第三人称，false 强制退出；不传则取反当前状态
   */
  toggleView(isActive?: boolean): void {
    const next = isActive ?? !this.isActive;
    if (next) this.enterThirdPerson();
    else this.exitThirdPerson();
  }

  resetToSpawn(): void {
    this.pos.copy(this.spawnPoint);
    this.vel.set(0, 0, 0);
    this.vy = 0;
    this.grounded = true;
    this.hovering = false;
    this.jumping = false;
    const up0 = this.spawnPoint.getComponent(this._upIdx);
    this.groundY = up0;
    this.smoothY = up0;
    this.landDip = 0;
    this.landDipVel = 0;
    /* 立即同步角色模型到出生点，并让相机直接就位（避免开场 / 回出生点时从原点飞过来） */
    if (this.person) this.person.update(0, this, false);
    this.updateCamera(1);
  }

  /** 自动寻找一个「脚下有地面且没被建筑包住」的出生点（原 main.ts 的 findSpawn，经 this.collision 探测） */
  private findSpawn(): THREE.Vector3 {
    const collision = this.collision;
    const bounds = collision.worldBounds;
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const span = Math.min(Math.max(size.x, size.z) * 0.5, 120);
    const probeTop = bounds.max.y + 5;
    const pen: Penetration = { has: false, depth: 0, dx: 0, dy: 0, dz: 0 };
    const N = 5;
    let fallback: THREE.Vector3 | null = null;

    for (let ring = 0; ring < 3; ring++) {
      const s = span * (1 + ring * 0.7);
      const meshes = collision.queryNearby(center.x, center.z, s + 40).slice();
      for (let i = 0; i < N; i++) {
        for (let j = 0; j < N; j++) {
          const x = center.x + (i / (N - 1) - 0.5) * s;
          const z = center.z + (j / (N - 1) - 0.5) * s;
          const hit = collision.castDown(x, z, probeTop, probeTop - bounds.min.y + 10, meshes);
          if (!hit) continue;
          const y = hit.point.y;
          if (!fallback) fallback = new THREE.Vector3(x, y, z);
          let blocked = false;
          for (const h of collision.collideHeights) {
            for (const m of meshes) {
              pen.has = false; pen.depth = 0;
              collision.collideMesh(m, x, y + h, z, collision.radius + 0.05, y + collision.stepHeight, pen);
              if (pen.has && pen.depth > 0.02) { blocked = true; break; }
            }
            if (blocked) break;
          }
          if (!blocked) return new THREE.Vector3(x, y, z);
        }
      }
    }
    return fallback || new THREE.Vector3(center.x, bounds.min.y + 2, center.z);
  }

  /** 依据当前朝向与按键得出水平期望方向，同时刷新 _fwd / _right */
  private readWishDir(): THREE.Vector3 {
    setBasis(this.yaw, _fwd, _right, this._upIdx);
    const kb = this.keyboard;
    let ix = 0, iz = 0;
    if (kb.hasAny('KeyW', 'ArrowUp')) iz += 1;
    if (kb.hasAny('KeyS', 'ArrowDown')) iz -= 1;
    if (kb.hasAny('KeyD', 'ArrowRight')) ix += 1;
    if (kb.hasAny('KeyA', 'ArrowLeft')) ix -= 1;
    _wish.set(0, 0, 0).addScaledVector(_fwd, iz).addScaledVector(_right, ix);
    if (_wish.lengthSq() > 0) _wish.normalize();
    return _wish;
  }

  private updateFly(dt: number, running: boolean): void {
    const cfg = this.config;
    const kb = this.keyboard;
    let f = 0, r = 0, u = 0;
    if (kb.hasAny('KeyW', 'ArrowUp')) f += 1;
    if (kb.hasAny('KeyS', 'ArrowDown')) f -= 1;
    if (kb.hasAny('KeyD', 'ArrowRight')) r += 1;
    if (kb.hasAny('KeyA', 'ArrowLeft')) r -= 1;
    if (kb.hasAny('Space', 'KeyE')) u += 1;
    if (kb.hasAny('ControlLeft', 'KeyQ')) u -= 1;

    _flyMove.set(0, 0, 0).addScaledVector(_fwd, f).addScaledVector(_right, r).addScaledVector(this.up, u);
    if (_flyMove.lengthSq() > 0) _flyMove.normalize();
    const spd = running ? cfg.runSpeed : cfg.walkSpeed;
    const k = 1 - Math.exp(-10 * dt);
    this.vel.x += (_flyMove.x * spd - this.vel.x) * k;
    this.vel.y += (_flyMove.y * spd - this.vel.y) * k;
    this.vel.z += (_flyMove.z * spd - this.vel.z) * k;
    this.pos.addScaledVector(this.vel, dt);
    this.vy = 0;
    this.grounded = false;
    this.jumping = false;
    this.groundY = this.pos.getComponent(this._upIdx);
  }

  /** 每帧推进物理与移动，随后同步角色模型与第三人称相机 */
  update(dt: number): void {
    if (!this.isActive) return;   // OrbitControls 模式下玩家物理暂停
    const cfg = this.config;
    this.refreshCollision();   // 清空 + 重新登记 + 增量构建（碰撞查询前保证索引最新）
    const wish = this.readWishDir();
    const running = this.keyboard.hasAny('ShiftLeft', 'ShiftRight');
    const upIdx = this._upIdx, h1Idx = this._h1Idx;

    if (this.fly) {
      this.updateFly(dt, running);
      this.syncVisual(dt);
      return;
    }

    /* --- 水平加速度（水平两轴：x 与 h1） --- */
    const maxSpeed = running ? cfg.runSpeed : cfg.walkSpeed;
    _target.copy(wish).multiplyScalar(maxSpeed);
    const k = 1 - Math.exp(-(this.grounded ? 14 : 3.5) * dt);
    this.vel.x += (_target.x - this.vel.x) * k;
    this.vel.setComponent(h1Idx, this.vel.getComponent(h1Idx) + (_target.getComponent(h1Idx) - this.vel.getComponent(h1Idx)) * k);

    /* --- 跳跃：缓冲 + 土狼时间 --- */
    if (this.jumpBuffer > 0) this.jumpBuffer -= dt;
    if (this.coyote > 0) this.coyote -= dt;
    if (this.jumpBuffer > 0 && (this.grounded || this.coyote > 0)) {
      this.vy = cfg.jumpSpeed;
      this.grounded = false;
      this.hovering = false;
      this.jumping = true;
      this.coyote = 0;
      this.jumpBuffer = 0;
    }

    const meshes = this.collision.queryNearby(this.pos.x, this.pos.getComponent(h1Idx), PLAYER.radius + 1.6);

    /* --- 水平移动：切分子步长，边走边解算穿透（实现贴墙自动滑行） --- */
    const dx = this.vel.x * dt, dh1 = this.vel.getComponent(h1Idx) * dt;
    const dist = Math.hypot(dx, dh1);
    const steps = Math.max(1, Math.ceil(dist / cfg.maxSubStep));
    const s0 = dx / steps, s1 = dh1 / steps;
    for (let i = 0; i < steps; i++) {
      const p0 = this.pos.x, p1 = this.pos.getComponent(h1Idx);
      this.pos.x += s0;
      this.pos.setComponent(h1Idx, this.pos.getComponent(h1Idx) + s1);
      const hit = this.collision.resolvePenetration(this.pos, meshes, this.pos.getComponent(upIdx));
      if (hit.hitCeiling) this.vy = Math.min(this.vy, 0);
      if (Math.abs(this.pos.x - p0) < 1e-5 && Math.abs(this.pos.getComponent(h1Idx) - p1) < 1e-5) break;
    }

    /* --- 垂直（沿上轴）移动：先探测后推进，绝不超过地面，落地无超调 --- */
    const wasGrounded = this.grounded;
    // 抬升容差始终保留 stepHeight：房顶/台阶的"托回"依赖它（见 sampleGround 说明），
    // 而"下落被路缘弹起""下台阶粘脚"由 sampleGround 里只放宽中心射线来规避
    const upAllow = cfg.stepHeight;
    const preVy = this.vy - cfg.gravity * dt;
    const downLimit = Math.max(0.8, Math.abs(Math.min(preVy, 0)) * dt + 0.3);
    // 先在当前位置采样地面：判断脚下（含悬空恢复所需的更深区域）是否有地面
    const g0 = this.collision.sampleGround(this.pos, meshes, upAllow, downLimit);

    /* --- 悬空保护：下落时脚下完全没有地面 → 保持当前高度，不下坠（含跳跃越过悬空区） --- */
    if (this.vy <= 0 && g0.belowY === -Infinity) this.hovering = true;
    if (this.hovering) {
      // 悬空行走：锁定高度；下方重新出现地面 → 恢复正常物理，落回地面
      this.vy = 0;
      this.grounded = false;
      this.jumping = false;
      if (g0.belowY > -Infinity) this.hovering = false;
    } else {
      this.vy = Math.max(preVy, -cfg.maxFallSpeed);
      const dy = this.vy * dt;
      const vySteps = Math.max(1, Math.ceil(Math.abs(dy) / cfg.maxSubStep));
      const stepY = dy / vySteps;
      let landed = false;
      let impactSpeed = 0;

      for (let i = 0; i < vySteps; i++) {
        const g = this.collision.sampleGround(this.pos, meshes, upAllow, downLimit);
        if (g.belowY > -Infinity) this.groundY = g.belowY;
        const nextUp = this.pos.getComponent(upIdx) + stepY;
        if (this.vy <= 0 && g.snapY > -Infinity && g.snapY >= nextUp - 1e-4) {
          // 这一步会穿到地面下方 → 精确停在接触面上（贴合地面 / 自动登上台阶）
          impactSpeed = -this.vy;
          this.pos.setComponent(upIdx, g.snapY);
          this.vy = 0;
          this.groundY = g.snapY;
          landed = true;
          break;
        }
        this.pos.setComponent(upIdx, nextUp);
      }
      this.grounded = landed;
      if (landed) {
        this.coyote = 0.12;
        this.jumping = false;
        // 落地冲击 → 让镜头轻微下压再回弹，消除"硬刹停"的顿挫
        if (!wasGrounded && impactSpeed > 3.5) {
          this.landDip = Math.min(impactSpeed * 0.011, 0.2);
          this.landDipVel = 0;
        }
      }
    }

    /* --- 掉出场景保护 --- */
    if (this.pos.getComponent(upIdx) < this.collision.worldBounds.min.getComponent(upIdx) - 80) this.resetToSpawn();

    this.syncVisual(dt);
  }

  /** 每帧同步角色模型姿态与第三人称相机（物理更新后调用，避免使用上一帧位置） */
  private syncVisual(dt: number): void {
    if (this.person) this.person.update(dt, this);
    this.updateCamera(dt);
  }

  /**
   * 每帧更新第三人称相机：脚底平滑跟随、落地缓冲弹簧、防穿墙拉近、动态 FOV。
   * @param dt 帧间隔（秒）；初始化让相机直接就位时可传 1
   */
  updateCamera(dt: number): void {
    /* 退出第三人称后相机交给外部的 OrbitControls，本方法不接管机位 */
    if (!this.isActive) return;
    /* 脚底高度平滑：贴地/上台阶时缓动跟随，空中精确跟随，避免台阶抬升与落地造成镜头跳动 */
    const posUp = this.pos.getComponent(this._upIdx);
    if (this.grounded && !this.fly) {
      this.smoothY += (posUp - this.smoothY) * (1 - Math.exp(-20 * dt));
    } else {
      this.smoothY = posUp;
      this.landDip = 0;
      this.landDipVel = 0;
    }
    /* 落地缓冲弹簧（轻微欠阻尼，产生一次小幅回弹） */
    const stiffness = 160;
    this.landDipVel += (-stiffness * this.landDip - 1.7 * Math.sqrt(stiffness) * this.landDipVel) * dt;
    this.landDip += this.landDipVel * dt;

    /* 相机注视点：角色胸口高度（沿上轴），水平取 pos */
    _focus.copy(this.pos);
    _focus.setComponent(this._upIdx, this.smoothY + PLAYER.height * 0.85 - this.landDip);

    /* 由 yaw / pitch 得出视线方向，相机放在注视点后方 camDist 处 */
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    if (this._upIdx === 2) {
      /* Z-UP：水平朝向在 x/y 平面，俯仰分量沿 z */
      _lookDir.set(-Math.sin(this.yaw) * cp, -Math.cos(this.yaw) * cp, sp);
    } else {
      _lookDir.set(-Math.sin(this.yaw) * cp, sp, -Math.cos(this.yaw) * cp);
    }

    let dist = this.fly ? this.config.camDist * 1.6 : this.config.camDist;
    /* 防穿墙：从注视点向相机方向投射射线，有遮挡则拉近相机 */
    if (this.collision.meshes.length) {
      camRay.set(_focus, _rayDir.copy(_lookDir).negate());
      camRay.far = dist;
      camRay.near = 0;
      const hits = camRay.intersectObjects(this.collision.meshes, false);
      if (hits.length) dist = Math.max(0.6, hits[0].distance - 0.25);
    }
    _camGoal.copy(_focus).addScaledVector(_lookDir, -dist);
    /* 相机不要低于脚底（沿上轴） */
    const minUp = this.smoothY + 0.25;
    if (_camGoal.getComponent(this._upIdx) < minUp) _camGoal.setComponent(this._upIdx, minUp);

    this.camera.position.lerp(_camGoal, 1 - Math.exp(-16 * dt));
    this.camera.lookAt(_focus);

    const spdH = Math.hypot(this.vel.x, this.vel.getComponent(this._h1Idx));
    const running = this.keyboard.hasAny('ShiftLeft', 'ShiftRight');
    const targetFov = this.fovBase + (this.fly ? 3 : (running && spdH > 1 ? 7 : 0));
    this.fovCurrent += (targetFov - this.fovCurrent) * (1 - Math.exp(-6 * dt));
    if (Math.abs(this.camera.fov - this.fovCurrent) > 0.01) {
      this.camera.fov = this.fovCurrent;
      this.camera.updateProjectionMatrix();
    }
  }
}
