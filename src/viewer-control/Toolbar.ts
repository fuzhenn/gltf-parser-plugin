import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { ClippingPlane, type ClippingAxis } from './ClippingPlane';
import { SectionBox, type SectionBoxOptions } from './SectionBox';
import type { UpAxis } from './ViewerControls';

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

export interface JumpToViewOptions {
  /**
   * 观察方向（世界坐标，自目标指向相机）。
   * 缺省时保持相机当前相对轨道目标的观察方向。
   */
  direction?: THREE.Vector3;
  /** 在内置 1.5 倍安全边距之上追加的留白比例（0.1 = 追加 10%）；默认 0 */
  padding?: number;
  /** 视口宽高比；缺省使用相机当前的 aspect */
  aspect?: number;
  /** 是否把轨道目标（controls.target）移动到包围盒中心；默认 true */
  moveTarget?: boolean;
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
  /** 场景包围盒（由 ViewerControls 传入），用于创建剖切面 */
  private sceneBBox: THREE.Box3 | null;
  /** 世界坐标上方向轴（由 ViewerControls 传入），创建剖切面 / 剖切框时向下传递 */
  private readonly upAxis: UpAxis;
  /** 当前剖切面，null 表示未创建 */
  private clippingPlane: ClippingPlane | null = null;
  /** 当前剖切框，null 表示未创建 */
  private sectionBox: SectionBox | null = null;

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

  constructor(controls: OrbitControls, sceneBBox?: THREE.Box3 | null, upAxis: UpAxis = 'Z_UP') {
    this.controls = controls;
    this.sceneBBox = sceneBBox ?? null;
    this.upAxis = upAxis;

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

  /**
   * 将相机视角调整到刚好可以完整显示 sceneBox（即时跳转，无动画）。
   *
   * sceneBox 为必填参数，相机参数完全基于它计算，不使用实例上的 sceneBBox。
   *
   * 距离计算：取包围盒最大边长 maxDim，按相机 FOV 反推观察距离 ——
   * 垂直方向 maxDim / (2·tan(fov/2))，水平方向按 aspect 换算水平 FOV 后同理，
   * 取两者较大者确保包围盒在两个方向都完整可见，再乘以 1.5 倍安全边距。
   * 正交相机按 maxDim × 2 取距离。
   * 观察方向缺省时保持相机当前的观察方向，仅调整距离与目标点。
   *
   * camera 缺省时使用 OrbitControls 绑定的相机；传入其他相机时仅调整其位置与朝向，
   * 不改动 controls.target。直接改写相机位置即可：外部渲染循环每帧调用
   * controls.update()，会基于新的相机位置重新计算内部球坐标。
   *
   * 包围盒为空时为空操作。
   */
  public jumpToView(sceneBox: THREE.Box3, camera?: THREE.Camera, options: Omit<JumpToViewOptions, 'sceneBox'> = {}): void {
    if (this.disposed) return;
    if (!sceneBox || sceneBox.isEmpty()) return;
    const cam = camera ?? this.controls.object;

    const center = sceneBox.getCenter(new THREE.Vector3());

    // 观察方向：优先用指定方向，否则保持当前相机相对目标的偏移方向
    const dir = options.direction
      ? options.direction.clone().normalize()
      : cam.position.clone().sub(this.controls.target);
    // 方向退化为零向量（如相机恰在目标点上）时兜底取对角方向
    if (dir.lengthSq() < 1e-12) dir.set(1, 1, 1).normalize();

    // 包围盒最大边长，据此按相机 FOV 反推观察距离
    const size = sceneBox.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);

    let dist: number;
    if (cam instanceof THREE.PerspectiveCamera) {
      const aspect = options.aspect ?? cam.aspect;
      const fov = THREE.MathUtils.degToRad(cam.fov);
      // 垂直 / 水平两个方向分别计算，取较大者确保包围盒完整在视野内
      const distanceV = maxDim / (2 * Math.tan(fov / 2));
      const fovHorizontal = 2 * Math.atan(Math.tan(fov / 2) * Math.max(aspect, 1e-6));
      const distanceH = maxDim / (2 * Math.tan(fovHorizontal / 2));
      dist = Math.max(distanceV, distanceH) * 1.5; // 1.5 倍安全边距

      if (options.aspect !== undefined) {
        cam.aspect = aspect;
        cam.updateProjectionMatrix();
      }
    } else {
      // 正交相机：不随距离改变视野大小，按经验值取 maxDim × 2
      dist = maxDim * 2;
    }

    dist = THREE.MathUtils.clamp(
      dist * (1 + Math.max(0, options.padding ?? 0)),
      this.controls.minDistance,
      this.controls.maxDistance,
    );

    // 仅当操作的是 OrbitControls 绑定的相机时才同步轨道目标，
    // 否则相机与控制器目标分离会导致后续交互跳变
    const moveTarget = options.moveTarget !== false && cam === this.controls.object;
    if (moveTarget) this.controls.target.copy(center);

    cam.position.copy(center).addScaledVector(dir, dist);
    cam.lookAt(center);
  }

  /**
   * 创建沿指定轴（x / y / z）的剖切面，大小与位置基于 ViewerControls 的 sceneBBox。
   * 已存在剖切面时会先移除旧的再创建新的。
   * 返回创建的 ClippingPlane（无 sceneBBox 或已释放时返回 null）。
   */
  public createClippingPlane(axis: ClippingAxis): ClippingPlane | null {
    if (this.disposed || !this.sceneBBox) return null;
    this.removeClippingPlane();
    this.clippingPlane = new ClippingPlane(this.sceneBBox, axis, { upAxis: this.upAxis });
    // 操作柄的指针交互（命中拦截 / 法线方向拖拽 / 悬停光标）由 ClippingPlaneHandle 自行监听
    if (this.canvas) this.clippingPlane.handle.attachInteraction(this.canvas, this.controls, this.clippingPlane);
    // 旋转手柄（两个圆环）的指针交互（绕圆环法线旋转剖切面），须在平移手柄之后绑定
    if (this.canvas) {
      this.clippingPlane.rotationHandle.attachInteraction(this.canvas, this.controls, this.clippingPlane);
    }
    return this.clippingPlane;
  }

  /** 移除当前剖切面（可视化对象同时从场景中摘除） */
  public removeClippingPlane(): void {
    if (this.clippingPlane) {
      this.clippingPlane.dispose();
      this.clippingPlane = null;
    }
  }

  /** 当前剖切面；未创建时返回 null */
  public getClippingPlane(): ClippingPlane | null {
    return this.clippingPlane;
  }

  /** 当前剖切面的可视化对象（含面片、边框与操作柄）；未创建时返回 null */
  public getClippingObject(): THREE.Group | null {
    return this.clippingPlane ? this.clippingPlane.object3d : null;
  }

  /** 是否已创建剖切面 */
  public hasClippingPlane(): boolean {
    return this.clippingPlane !== null;
  }

  /**
   * 返回剖切面结果（可直接作为 renderer.clippingPlanes 或
   * material.clippingPlanes 使用）；未创建剖切面时返回空数组。
   * 返回的是内部 Plane 实例，剖切面位置/方向更新时原地同步，无需重复获取。
   */
  /**
   * 每帧更新剖切面操作柄的屏幕显示尺寸（固定 100 像素长度），
   * 由外部渲染循环在渲染前调用；未创建剖切面时为空操作。
   */
  public updateClippingPlaneScreenSize(): void {
    if (this.disposed || !this.clippingPlane || !this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    this.clippingPlane.updateHandleScreenSize(this.controls.object, rect.height);
  }

  public getClippingPlanes(): THREE.Plane[] {
    return this.clippingPlane ? [this.clippingPlane.getPlane()] : [];
  }

  /**
   * 创建 Revit 风格的剖切框，大小与位置基于 ViewerControls 的 sceneBBox。
   * 已存在剖切框时会先移除旧的再创建新的。
   * 拖拽剖切框期间由 Toolbar 内部暂停 / 恢复 OrbitControls，避免两个控制器抢占指针。
   * 返回创建的 SectionBox（无 sceneBBox 或已释放时返回 null）；
   * 其 object3d 与 gizmoHelper 需由外部加入场景渲染。
   */
  public createSectionBox(options: Omit<SectionBoxOptions, 'onDraggingChange'> = {}): SectionBox | null {
    if (this.disposed || !this.sceneBBox || !this.canvas) return null;
    this.removeSectionBox();
    this.sectionBox = new SectionBox(this.controls.object, this.canvas, this.sceneBBox, {
      ...options,
      // 调用方未显式指定时沿用 Viewer 的 upAxis，保证 Y-UP 下竖直方向约束正确
      upAxis: options.upAxis ?? this.upAxis,
      onDraggingChange: (dragging) => {
        // 拖拽剖切框期间暂停轨道相机，避免两个控制器抢占指针
        this.controls.enabled = !dragging;
      },
    });
    return this.sectionBox;
  }

  /** 移除当前剖切框（可视化对象同时从场景中摘除，事件与资源一并释放） */
  public removeSectionBox(): void {
    if (this.sectionBox) {
      this.sectionBox.dispose();
      this.sectionBox = null;
    }
  }

  /** 当前剖切框；未创建时返回 null */
  public getSectionBox(): SectionBox | null {
    return this.sectionBox;
  }

  /** 是否已创建剖切框 */
  public hasSectionBox(): boolean {
    return this.sectionBox !== null;
  }

  /** 返回剖切框的 6 个裁剪平面；未创建剖切框时返回空数组（原地同步，无需重复获取） */
  public getSectionBoxPlanes(): THREE.Plane[] {
    return this.sectionBox ? this.sectionBox.getPlanes() : [];
  }

  public dispose(): void {
    if (this.disposed) return;
    this.removeClippingPlane();
    this.removeSectionBox();
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
