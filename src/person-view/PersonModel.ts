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
 *   person.update(dt, player, !paused);     // 主循环中每帧调用
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
}

/** 把角度归一到 (-PI, PI] */
function shortestAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

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
  /** 角色朝向（面向移动方向） */
  yaw = 0;
  /** 各动画状态使用的 clip 名称 */
  animClips: AnimClipNames;
  /** 角色模型缩放 */
  scale: number;

  constructor({ url, parent, walkSpeed, upAxis = 'y', animClips, scale = 1 }: PersonOptions) {
    this.url = url;
    this.parent = parent;
    this.walkSpeed = walkSpeed;
    this.upAxis = upAxis;
    this.animClips = { ...DEFAULT_ANIM_CLIPS, ...animClips };
    this.scale = scale;
  }

  /** 切换动画：淡入新动作、淡出旧动作（名称不区分大小写） */
  setAction(name: string, fade: number = 0.22): void {
    const next = this.actions[name.toLowerCase()];
    if (!next || next === this.current) return;
    next.reset();
    if (this.current) next.crossFadeFrom(this.current, fade, true);
    next.play();
    this.current = next;
  }

  /** 载入角色模型，并准备 idle / walking / running / jump 动画 */
  async load(): Promise<void> {
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
    /* 水平速度：水平两轴为 Y-UP (x,z) / Z-UP (x,y) */
    const spdH = zUp ? Math.hypot(player.vel.x, player.vel.y) : Math.hypot(player.vel.x, player.vel.z);
    let targetYaw = this.yaw;
    let anim: string | null = null;

    if (player.fly) {
      /* 飞行时面向镜头前方（两种 up 轴下与 Player 的 yaw 约定保持一致） */
      targetYaw = zUp ? -player.yaw : player.yaw + Math.PI;
      anim = spdH > 0.6 ? this.animClips.walking : this.animClips.idle;
    } else if (player.jumping) {
      /* 仅空格起跳后播放 Jump 动画；悬空行走（无地面保持高度）不进入 Jump */
      anim = this.actions[this.animClips.jump.toLowerCase()] ? this.animClips.jump : null;
    } else if (spdH > 0.5) {
      /* 面向移动方向；速度超过步行上限则切换为跑步动画 */
      targetYaw = zUp ? Math.atan2(player.vel.x, -player.vel.y) : Math.atan2(player.vel.x, player.vel.z);
      anim = (spdH > this.walkSpeed + 0.4) ? this.animClips.running : this.animClips.walking;
    } else {
      anim = this.animClips.idle;
    }

    this.yaw += shortestAngle(targetYaw - this.yaw) * (1 - Math.exp(-14 * dt));
    if (zUp) this.root.rotation.z = this.yaw;   // 绕世界上轴旋转
    else this.root.rotation.y = this.yaw;

    if (anim) this.setAction(anim);
    if (advanceAnim && this.mixer) this.mixer.update(dt);
  }
}
