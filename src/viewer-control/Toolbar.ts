import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export enum CameraMode {
  /** 默认模式：左键旋转、右键平移、滚轮缩放；单指触控旋转 */
  Default = 'default',
  /** 旋转模式：左键和右键按下拖拽均为旋转相机；单指触控旋转 */
  Rotate = 'rotate',
  /** 平移模式：左键和右键按下拖拽均为平移相机；单指触控平移 */
  Pan = 'pan',
  /** 缩放模式：左键和右键按下拖拽均为缩放相机；单指触控缩放 */
  Zoom = 'zoom',
}

/**
 * Toolbar - 独立的工具栏组件，供 Viewer 创建、由外部程序使用。
 *
 * Toolbar 不创建容器、不构造按钮、不关心任何样式。工具栏容器与按钮均由
 * 外部程序自行创建、设置样式并挂载。Toolbar 负责按钮点击后的行为 —— 即
 * 相机操作模式的切换；外部程序在按钮的 click 事件中调用 Toolbar 上的方法
 * （如 setCameraMode），按钮的外观与高亮状态也完全由外部程序自行维护。
 *
 * 移动端触控：每种模式下单指操作与鼠标左键一致 ——
 * Default / Rotate 模式单指旋转，Pan 模式单指平移，Zoom 模式单指缩放
 * （Zoom 的单指缩放由 Toolbar 在画布上监听 pointer 事件自行实现：
 * 按"拖动像素距离"缩放，OrbitControls 内置的拖拽缩放每个移动事件只按
 * 固定比例缩放一次，与拖动像素无关，手感迟钝）。
 * 其余模式 Toolbar 不监听任何事件。
 */
export class Toolbar {
  private controls: OrbitControls;
  private canvas: HTMLElement | null = null;
  private disposed = false;
  private mode: CameraMode = CameraMode.Default;

  /**
   * 缩放模式下的缩放速度（默认 1）。
   * 每 1px 拖动约缩放 1% × zoomSpeed；与滚轮缩放（controls.zoomSpeed）相互独立。
   */
  public zoomSpeed = 1;

  /** 缩放拖拽状态：正在拖拽的指针 id，null 表示未在拖拽 */
  private zoomPointerId: number | null = null;
  private zoomLastX = 0;
  private zoomLastY = 0;
  /** 拖拽起点，用于在位移超过阈值后判定主导轴（横向拖 or 纵向拖） */
  private zoomStartX = 0;
  private zoomStartY = 0;
  /** 本手势锁定的缩放轴；null 表示尚未判定 */
  private zoomAxis: 'x' | 'y' | null = null;

  private onPointerDown = (event: PointerEvent): void => {
    if (this.disposed || this.mode !== CameraMode.Zoom) return;
    // 已有指针在拖拽时又按下（如双指触控），放弃单指缩放，交给 OrbitControls 双指手势
    if (this.zoomPointerId !== null) {
      this.zoomPointerId = null;
      return;
    }
    // 鼠标仅响应左键 / 右键（中键走 OrbitControls 原生 dolly）
    if (event.pointerType === 'mouse' && event.button !== 0 && event.button !== 2) return;
    // 触控仅响应主指针
    if (event.pointerType !== 'mouse' && !event.isPrimary) return;

    this.zoomPointerId = event.pointerId;
    this.zoomLastX = event.clientX;
    this.zoomLastY = event.clientY;
    this.zoomStartX = event.clientX;
    this.zoomStartY = event.clientY;
    this.zoomAxis = null;
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (this.disposed || this.zoomPointerId === null || event.pointerId !== this.zoomPointerId) return;
    if (this.mode !== CameraMode.Zoom) {
      this.zoomPointerId = null;
      return;
    }

    const dx = event.clientX - this.zoomLastX;
    const dy = event.clientY - this.zoomLastY;
    this.zoomLastX = event.clientX;
    this.zoomLastY = event.clientY;

    // 主导轴判定：累计位移超过阈值后锁定整段手势的缩放轴，避免横向拖拽时
    // clientY 在 0 附近随机抖动导致场景忽大忽小。阈值内（轻微抖动）不缩放。
    if (this.zoomAxis === null) {
      const distX = Math.abs(event.clientX - this.zoomStartX);
      const distY = Math.abs(event.clientY - this.zoomStartY);
      if (Math.max(distX, distY) < 3) return;
      this.zoomAxis = distY >= distX ? 'y' : 'x';
    }

    const d = this.zoomAxis === 'y' ? dy : dx;
    if (d === 0) return;

    // 拖动距离按像素比例换算为缩放步数：每 1px 约 1%，拖得越快缩得越快。
    // 纵向向上拖（dy < 0）为放大，横向向左拖（dx < 0）为放大。
    const scale = Math.pow(0.99, -d * this.zoomSpeed);
    this.applyDolly(scale);
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (this.zoomPointerId !== null && event.pointerId === this.zoomPointerId) {
      this.zoomPointerId = null;
      this.zoomAxis = null;
    }
  };

  constructor(controls: OrbitControls) {
    this.controls = controls;

    // 缩放模式的自定义拖拽缩放监听（挂在画布上，OrbitControls 在拖拽期间
    // 会对画布做指针捕获，因此指针移出画布也能持续收到 move 事件）
    this.canvas = this.controls.domElement instanceof HTMLElement ? this.controls.domElement : null;
    const el = this.canvas;
    if (el) {
      el.addEventListener('pointerdown', this.onPointerDown);
      el.addEventListener('pointermove', this.onPointerMove);
      el.addEventListener('pointerup', this.onPointerUp);
      el.addEventListener('pointercancel', this.onPointerUp);
    }

    // 初始为默认相机模式
    this.setCameraMode(CameraMode.Default);
  }

  /** 切换相机操作模式（由外部程序在按钮 click 事件中调用） */
  public setCameraMode(mode: CameraMode): void {
    if (this.disposed) return;
    this.mode = mode;
    switch (mode) {
      case CameraMode.Rotate:
        // 左键与右键按下拖拽均旋转相机；单指触控旋转
        this.controls.mouseButtons = {
          LEFT: THREE.MOUSE.ROTATE,
          MIDDLE: THREE.MOUSE.DOLLY,
          RIGHT: THREE.MOUSE.ROTATE,
        };
        this.controls.touches = {
          ONE: THREE.TOUCH.ROTATE,
          TWO: THREE.TOUCH.DOLLY_PAN,
        };
        break;
      case CameraMode.Pan:
        // 左键与右键按下拖拽均平移相机；单指触控平移
        this.controls.mouseButtons = {
          LEFT: THREE.MOUSE.PAN,
          MIDDLE: THREE.MOUSE.DOLLY,
          RIGHT: THREE.MOUSE.PAN,
        };
        this.controls.touches = {
          ONE: THREE.TOUCH.PAN,
          TWO: THREE.TOUCH.DOLLY_PAN,
        };
        break;
      case CameraMode.Zoom:
        // 左键与右键拖拽由 Toolbar 自行处理（按像素比例缩放），
        // 不映射给 OrbitControls（未映射的键其内部状态为 NONE，不产生动作）。
        // 中键保留原生 dolly；单指触控同样不映射，交由 Toolbar 自定义缩放处理，
        // 双指触控保留 OrbitControls 的 DOLLY_PAN 手势。
        this.controls.mouseButtons = {
          MIDDLE: THREE.MOUSE.DOLLY,
        };
        this.controls.touches = {
          ONE: null,
          TWO: THREE.TOUCH.DOLLY_PAN,
        };
        break;
      case CameraMode.Default:
      default:
        // 默认模式：左键旋转、右键平移；单指触控旋转
        this.controls.mouseButtons = {
          LEFT: THREE.MOUSE.ROTATE,
          MIDDLE: THREE.MOUSE.DOLLY,
          RIGHT: THREE.MOUSE.PAN,
        };
        this.controls.touches = {
          ONE: THREE.TOUCH.ROTATE,
          TWO: THREE.TOUCH.DOLLY_PAN,
        };
        break;
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    const el = this.canvas;
    if (el) {
      el.removeEventListener('pointerdown', this.onPointerDown);
      el.removeEventListener('pointermove', this.onPointerMove);
      el.removeEventListener('pointerup', this.onPointerUp);
      el.removeEventListener('pointercancel', this.onPointerUp);
    }
    this.disposed = true;
  }

  /**
   * 沿目标方向对相机做乘法缩放（dolly）。
   * 直接改写相机位置即可：外部渲染循环每帧调用 controls.update()，
   * 其会基于新的相机位置重新计算内部球坐标，无需（也不能）调用其私有 API。
   * 乘法缩放与当前相机-目标距离成比例，天然尺度无关，无需按场景大小调整速度。
   */
  private applyDolly(scale: number): void {
    const camera = this.controls.object;
    const target = this.controls.target;

    const offset = camera.position.clone().sub(target);
    const dist = offset.length();
    if (dist <= 0) return;

    // 遵守 controls 的距离限制（与滚轮缩放行为一致）
    const newDist = THREE.MathUtils.clamp(dist * scale, this.controls.minDistance, this.controls.maxDistance);

    camera.position.copy(target).addScaledVector(offset.divideScalar(dist), newDist);
  }
}
