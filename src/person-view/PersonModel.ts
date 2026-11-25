/**
 * 第三人称角色（Person）
 * ------------------------------------------------------------
 * 职责：
 *   1. 载入 GLTF 角色模型并挂到场景（开启阴影 / 关闭视锥剔除）；
 *   2. 构建 AnimationMixer 与各动画动作（idle / walking / running / jump…）；
 *   3. 每帧根据玩家状态同步模型位置、朝向与动画状态机。
 *
 * 用法：
 *   const person = new Person({ url: './Xbot.glb', walkSpeed: CONFIG.walkSpeed });
 *   // Z-UP 世界传 upAxis: 'z'，模型会自动立起并绕世界上轴旋转
 *   await person.load();                    // 载入模型与动画
 *   scene.add(person.root);                 // 由外部把角色根节点挂到场景
 *   person.playAction('wave', { loop: THREE.LoopOnce }); // 手动播放指定 clip（暂停自动状态机）
 *   person.releaseAction();                 // 恢复自动状态机
 *   person.update(dt, player);              // 由 Player.update 内部每帧调用（advanceAnim 默认 true）
 *
 * 动画事件（on 返回取消订阅函数）：
 *   const off = person.on('animchange', (e) => {
 *     console.log(e.previousClip, '->', e.clip, 'state =', e.state, e.manual ? '(手动)' : '(自动)');
 *   });
 *   person.on('animfinish', (e) => console.log('播放结束', e.clip));
 *   off();                                  // 取消订阅
 * ------------------------------------------------------------
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { UpAxis } from './CollisionWorld';

/** Person 依赖的最小玩家状态子集（Player 满足该接口） */
export interface PlayerState {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  yaw: number;
  grounded: boolean;
  /** 是否处于跳跃动作中（仅按空格起跳后为 true），jump 动画只跟随该标志 */
  jumping: boolean;
  fly: boolean;
}

/** 动画状态 -> 动画 clip 名称（clip 名匹配时不区分大小写） */
export interface AnimClipNames {
  /** 待机 */
  idle: string;
  /** 步行 */
  walking: string;
  /** 奔跑 */
  running: string;
  /** 跳跃 */
  jump: string;
}

/** 动画 clip 名称默认值（与模型内置 clip 同名） */
export const DEFAULT_ANIM_CLIPS: Readonly<AnimClipNames> = {
  idle: 'idle',
  walking: 'walking',
  running: 'running',
  jump: 'jump'
};

export interface PersonOptions {
  /** 角色模型（.glb）地址 */
  url: string;
  /** 角色模型根节点挂载到的父对象（由调用方负责把它加入场景） */
  parent: THREE.Object3D;
  /** 步行速度上限，用于区分走 / 跑动画 */
  walkSpeed: number;
  /** 世界上方向轴：'y'（默认，Y-UP）或 'z'（Z-UP，模型会自动立起） */
  upAxis?: UpAxis;
  /** 各动画状态使用的 clip 名称（可部分覆盖默认值） */
  animClips?: Partial<AnimClipNames>;
  /** 角色模型缩放（默认 1，等比缩放模型） */
  scale?: number;
  /** 模型原生朝向：'+z'（glTF 惯例，默认）或 '-z'（如 Soldier.glb） */
  facing?: '+z' | '-z';
}

/** 手动播放动画的可选项 */
export interface PlayActionOptions {
  /** 淡入时长（秒，默认 0.22） */
  fade?: number;
  /** 循环模式：默认 THREE.LoopRepeat；THREE.LoopOnce 表示播放一次（其余模式见 three 文档） */
  loop?: THREE.AnimationActionLoopStyles;
  /** 配合 LoopOnce 使用：播完后停在末帧（默认 false，播完回到起始姿态） */
  clampWhenFinished?: boolean;
}

/** 把角度归一到 (-PI, PI] */
function shortestAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/**
 * 动画事件类型（需要通过 on 订阅关注的播放状态）：
 *   animstart  —— 动画开始播放（首个动作，或同名动作重新播放）；
 *   animchange —— 动画切换（自动状态机 idle / walking / running / jump 之间，或手动播放另一个 clip）；
 *   animloop   —— 当前动作完成一次循环（循环动画每次绕回开头都会触发）；
 *   animfinish —— 当前动作播放结束（LoopOnce 播完，含 clampWhenFinished 停在末帧的情况）。
 */
export type PersonAnimEventType = 'animstart' | 'animchange' | 'animloop' | 'animfinish';

/** 动画事件对象 */
export interface PersonAnimEvent {
  /** 事件类型 */
  type: PersonAnimEventType;
  /** 触发事件的动画动作 */
  action: THREE.AnimationAction;
  /** 动画 clip 名称（模型内置原始名称，大小写保持原样） */
  clip: string;
  /** 动画状态名：自动状态为 idle / walking / running / jump，手动播放时为 clip 名称（小写） */
  state: string;
  /** 切换前的 clip 名称（仅 animchange 非空，其余为 null） */
  previousClip: string | null;
  /** 切换前的动画动作（仅 animchange 非空，其余为 null） */
  previousAction: THREE.AnimationAction | null;
  /** 是否由手动播放（playAction）触发；false 表示自动状态机 */
  manual: boolean;
}

/** 动画事件回调 */
export type PersonAnimHandler = (event: PersonAnimEvent) => void;

export class Person {
  url: string;
  /** 角色模型根节点挂载到的父对象 */
  parent: THREE.Object3D;
  walkSpeed: number;
  /** 世界上方向轴 */
  upAxis: UpAxis;
  /** 模型根节点（位置与绕上轴的旋转挂在此节点上） */
  root: THREE.Object3D | null = null;
  /** AnimationMixer */
  mixer: THREE.AnimationMixer | null = null;
  /** 名称(小写) -> AnimationAction */
  actions: Record<string, THREE.AnimationAction> = {};
  /** 当前播放的动作 */
  current: THREE.AnimationAction | null = null;
  /** 是否处于手动指定动画状态（true 时 update 不再按玩家状态自动切换动画） */
  manualAnim = false;
  /** 角色朝向（面向移动方向） */
  yaw = 0;
  /** 各动画状态使用的 clip 名称 */
  animClips: AnimClipNames;
  /** 角色模型缩放 */
  scale: number;
  /** 模型原生朝向约定 */
  facing: '+z' | '-z';
  /** 动画事件回调表（事件类型 -> 回调列表） */
  private _animHandlers: Partial<Record<PersonAnimEventType, PersonAnimHandler[]>> = {};

  constructor({ url, parent, walkSpeed, upAxis = 'y', animClips, scale = 1, facing = '+z' }: PersonOptions) {
    this.url = url;
    this.parent = parent;
    this.walkSpeed = walkSpeed;
    this.upAxis = upAxis;
    this.animClips = { ...DEFAULT_ANIM_CLIPS, ...animClips };
    this.scale = scale;
    this.facing = facing;
  }

  /* ================= 动画事件 ================= */

  /**
   * 订阅动画播放状态事件。
   * @param type 事件类型：animstart / animchange / animloop / animfinish
   * @param handler 回调（参数见 PersonAnimEvent）
   * @returns 取消订阅函数
   */
  on(type: PersonAnimEventType, handler: PersonAnimHandler): () => void {
    const list = this._animHandlers[type] ?? (this._animHandlers[type] = []);
    list.push(handler);
    return () => this.off(type, handler);
  }

  /** 移除某个动画事件回调（不传 handler 则移除该类型全部回调） */
  off(type: PersonAnimEventType, handler?: PersonAnimHandler): void {
    if (!handler) { delete this._animHandlers[type]; return; }
    const list = this._animHandlers[type];
    if (!list) return;
    const i = list.indexOf(handler);
    if (i >= 0) list.splice(i, 1);
    if (!list.length) delete this._animHandlers[type];
  }

  /** 派发动画事件（无订阅者时直接返回，零开销；回调内的订阅变更不影响本次派发） */
  private _emitAnim(type: PersonAnimEventType, action: THREE.AnimationAction, previous: THREE.AnimationAction | null, manual: boolean): void {
    const list = this._animHandlers[type];
    if (!list || !list.length) return;
    const event: PersonAnimEvent = {
      type,
      action,
      clip: action.getClip().name,
      state: this._stateOf(action),
      previousClip: previous ? previous.getClip().name : null,
      previousAction: previous,
      manual
    };
    for (const fn of list.slice()) fn(event);
  }

  /** 由动画动作推导状态名：自动状态取 idle / walking / running / jump，其余（手动 clip）取 clip 名（小写） */
  private _stateOf(action: THREE.AnimationAction): string {
    const clip = action.getClip().name.toLowerCase();
    for (const key of Object.keys(this.animClips) as Array<keyof AnimClipNames>) {
      if (this.animClips[key].toLowerCase() === clip) return key;
    }
    return clip;
  }

  /** mixer 循环回调：只关注当前动作（crossFade 中淡出的旧动作不派发） */
  private readonly _onMixerLoop = (e: { action: THREE.AnimationAction }): void => {
    if (e.action !== this.current) return;
    this._emitAnim('animloop', e.action, null, this.manualAnim);
  };

  /** mixer 结束回调（LoopOnce 播完）：只关注当前动作 */
  private readonly _onMixerFinished = (e: { action: THREE.AnimationAction }): void => {
    if (e.action !== this.current) return;
    this._emitAnim('animfinish', e.action, null, this.manualAnim);
  };

  /* ================= 动画切换 ================= */

  /** 切换动画：淡入新动作、淡出旧动作（名称不区分大小写） */
  setAction(name: string, fade: number = 0.22): void {
    const next = this.actions[name.toLowerCase()];
    if (!next || next === this.current) return;
    const prev = this.current;
    next.reset();
    if (prev) next.crossFadeFrom(prev, fade, true);
    next.play();
    this.current = next;
    this._emitAnim(prev ? 'animchange' : 'animstart', next, prev, false);
  }

  /**
   * 手动播放指定 clip（名称不区分大小写），并暂停自动动画状态机
   * （暂停后 update 仍同步位置 / 朝向，但不再切换动画）。
   * @returns 是否找到并播放了该 clip（模型未加载或名称不存在时返回 false，且不改变当前状态）
   */
  playAction(name: string, opts: PlayActionOptions = {}): boolean {
    const { fade = 0.22, loop = THREE.LoopRepeat, clampWhenFinished = false } = opts;
    const next = this.actions[name.toLowerCase()];
    if (!next) return false;
    this.manualAnim = true;
    next.setLoop(loop, loop === THREE.LoopOnce ? 1 : Infinity);
    next.clampWhenFinished = clampWhenFinished;
    const prev = this.current;
    this.current = next;
    if (next === prev) {
      /* 同名动作重新播放（用于 LoopOnce 动作的再次触发） */
      next.reset().setEffectiveWeight(1).play();
      this._emitAnim('animstart', next, null, true);
    } else {
      next.reset();
      if (prev) next.crossFadeFrom(prev, fade, true);
      next.play();
      this._emitAnim(prev ? 'animchange' : 'animstart', next, prev, true);
    }
    return true;
  }

  /** 结束手动动画、恢复自动状态机（默认淡回待机，随后由 update 按玩家状态切换） */
  releaseAction(fade: number = 0.22): void {
    if (!this.manualAnim) return;
    this.manualAnim = false;
    this.setAction(this.animClips.idle, fade);
  }

  /** 载入角色模型，并准备 idle / walking / running / jump 动画（已加载时直接返回，防止重复创建模型实例） */
  async load(): Promise<void> {
    if (this.root) return;
    const gltf = await new GLTFLoader().loadAsync(this.url);
    const model = gltf.scene;
    model.scale.setScalar(this.scale);
    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) { mesh.castShadow = true; mesh.frustumCulled = false; }
    });

    /* GLTF 模型按 Y-UP 约定制作：Z-UP 世界中先用 holder 绕 X 转 90° 把模型立起（+Y → +Z），
     * 外层 root 只负责位置与绕世界上轴的旋转，两者互不干扰 */
    const holder = new THREE.Group();
    holder.add(model);
    if (this.upAxis === 'z') holder.rotation.x = Math.PI / 2;

    const root = new THREE.Group();
    root.add(holder);
    this.parent.add(root);

    const mixer = new THREE.AnimationMixer(model);
    /* 循环 / 播放结束事件由 mixer 派发，转发为 Person 的动画事件（只关注当前动作） */
    mixer.addEventListener('loop', this._onMixerLoop);
    mixer.addEventListener('finished', this._onMixerFinished);
    const actions: Record<string, THREE.AnimationAction> = {};
    for (const clip of gltf.animations) actions[clip.name.toLowerCase()] = mixer.clipAction(clip);
    this.root = root;
    this.mixer = mixer;
    this.actions = actions;
    this.setAction(this.animClips.idle, 0);
  }

  /**
   * 每帧同步角色位置 / 朝向 / 动画。
   * @param dt 帧间隔（秒）
   * @param player 玩家状态（pos / vel / yaw / grounded / fly）
   * @param advanceAnim false 时（暂停）不推进动画时间
   */
  update(dt: number, player: PlayerState, advanceAnim: boolean = true): void {
    if (!this.root) return;
    this.root.position.copy(player.pos);

    const zUp = this.upAxis === 'z';
    /* 模型原生朝向与朝向公式（按 +Z 约定编写）相差 180° 时，统一叠加偏移修正 */
    const yawOffset = this.facing === '-z' ? Math.PI : 0;
    /* 水平速度：水平两轴为 Y-UP (x,z) / Z-UP (x,y) */
    const spdH = zUp ? Math.hypot(player.vel.x, player.vel.y) : Math.hypot(player.vel.x, player.vel.z);
    let targetYaw = this.yaw;
    let anim: string | null = null;

    if (player.fly) {
      /* 飞行时面向镜头前方（两种 up 轴下与 Player 的 yaw 约定保持一致） */
      targetYaw = zUp ? -player.yaw + yawOffset : player.yaw + Math.PI + yawOffset;
      anim = spdH > 0.6 ? this.animClips.walking : this.animClips.idle;
    } else if (player.jumping) {
      /* 仅空格起跳后播放 Jump 动画；悬空行走（无地面保持高度）不进入 Jump */
      anim = this.actions[this.animClips.jump.toLowerCase()] ? this.animClips.jump : null;
    } else if (spdH > 0.5) {
      /* 面向移动方向；速度超过步行上限则切换为跑步动画 */
      targetYaw = zUp
        ? Math.atan2(player.vel.x, -player.vel.y) + yawOffset
        : Math.atan2(player.vel.x, player.vel.z) + yawOffset;
      anim = (spdH > this.walkSpeed + 0.4) ? this.animClips.running : this.animClips.walking;
    } else {
      anim = this.animClips.idle;
    }

    this.yaw += shortestAngle(targetYaw - this.yaw) * (1 - Math.exp(-14 * dt));
    if (zUp) this.root.rotation.z = this.yaw;   // 绕世界上轴旋转
    else this.root.rotation.y = this.yaw;

    /* 手动指定动画期间只同步位置 / 朝向，不覆盖动画（见 playAction / releaseAction） */
    if (anim && !this.manualAnim) this.setAction(anim);
    if (advanceAnim && this.mixer) this.mixer.update(dt);
  }
}
