import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { ViewCube } from './ViewCube';
import { Toolbar, CameraMode } from './Toolbar';

/** 世界坐标上方向轴：'Y_UP' 表示 Y 轴向上，'Z_UP' 表示 Z 轴向上 */
export type UpAxis = 'Y_UP' | 'Z_UP';

export interface ViewerControlsOptions {
  /**
   * 挂载容器（DOM 元素）。工具栏与 ViewCube 的悬浮层以 absolute 定位放置其中，
   * 因此容器应为非 static 定位（如 position: relative），由外部负责设置。
   */
  container: HTMLElement;
  /** 外部创建并完成画布挂载/尺寸设置的渲染器（ViewerControls 仅负责自适应尺寸与 ViewCube 叠加渲染） */
  renderer: THREE.WebGLRenderer;
  /**
   * 外部创建的相机（含位置、朝向、aspect 等全部初始状态）。
   * 注意：相机 up 向量由 upAxis 配置决定，ViewerControls 会在构造 OrbitControls 前
   * 覆盖设置（OrbitControls 构造时会基于 camera.up 缓存内部旋转基准）。
   * 轨道目标（controls.target）默认为原点，如需修改请在构造后设置。
   */
  camera: THREE.PerspectiveCamera;
  /**
   * 世界坐标的上方向轴。
   * - 'Y_UP'：Y 轴向上（three.js 默认习惯），相机 up = (0,1,0)；
   * - 'Z_UP'：Z 轴向上（CAD 常用习惯），相机 up = (0,0,1)；
   * 默认 'Z_UP'。仅构造时生效，不支持运行时切换。
   */
  upAxis?: UpAxis;
  /**
   * 是否启用 ViewCube（右上角视角立方体）。
   * - 默认 true（启用）：每帧同步姿态并叠加渲染；
   * - 为 false 时隐藏 ViewCube 及其交互层，update/renderViewCube 均跳过它；
   * - 运行时可随时通过 setViewCubeEnabled() 切换。
   */
  viewCubeEnabled?: boolean;
  /**
   * 关注的模型包围盒（不会变化）。仅保存为属性备用，构造后不可修改。
   * 传入的 Box3 会被复制，外部后续修改不影响内部保存的值。
   */
  sceneBBox?: THREE.Box3;
}

/** 极角安全边界：距极点约 0.57°，避免 lookAt 与球坐标退化 */
const PHI_EPS = 0.01;

interface FaceTween {
  t: number;
  duration: number;
  fromTheta: number;
  toTheta: number;
  fromPhi: number;
  toPhi: number;
  dist: number;
  target: THREE.Vector3;
}

/**
 * ViewerControls - 基于 Three.js 的 CAD 风格三维查看器。
 *
 * - renderer、camera、scene 均由外部创建：renderer（含画布挂载）与 camera 通过构造参数传入，scene 由外部闭包持有；
 * - ViewerControls 不决定何时渲染场景，也不持有场景；场景渲染时机与逻辑完全由外部掌控；
 * - 渲染循环由外部驱动：外部每帧调用 update(deltaTime) 更新相机/控制器/ViewCube 姿态，
 *   自行渲染场景，并在场景渲染之后调用 renderViewCube() 叠加渲染 ViewCube；
 * - ViewerControls 负责相机/控制器与工具栏；尺寸自适应（相机 aspect 与 renderer 画布）完全由外部负责；
 * - 通过 upAxis 配置支持 Y-UP / Z-UP 世界（默认 Z-UP），构造时据此设置相机 up 向量，
 *   并同步 ViewCube 的面标签与对齐方式；
 * - 容器 DOM 仅在构造时使用，不作为成员保存。
 */
export class ViewerControls {
  /** 相机操作模式，外部通过 ViewerControls.CameraMode 访问 */
  public static readonly CameraMode = CameraMode;

  public readonly renderer: THREE.WebGLRenderer;
  public readonly camera: THREE.PerspectiveCamera;
  public readonly controls: OrbitControls;
  public readonly toolbar: Toolbar;
  public readonly viewCube: ViewCube;

  /** 场景包围盒（构造时传入，不会变化，仅保存备用） */
  public readonly sceneBBox: THREE.Box3 | null;

  /** 世界坐标上方向轴（构造时确定，不可变更） */
  public readonly upAxis: UpAxis;

  private tween: FaceTween | null = null;
  private disposed = false;
  private viewCubeEnabled = true;

  constructor(options: ViewerControlsOptions) {
    const container = options.container;

    // 场景包围盒（不会变化），复制保存备用
    this.sceneBBox = options.sceneBBox ? options.sceneBBox.clone() : null;

    // 渲染器由外部创建并完成画布挂载，ViewerControls 不构造、不销毁、不挂载，
    // 尺寸自适应完全由外部负责
    this.renderer = options.renderer;

    // 相机由外部创建并完成初始状态设置，ViewerControls 不构造
    this.camera = options.camera;

    // 上方向轴配置（默认 Z-UP），据此设置相机 up 向量；
    // 必须在构造 OrbitControls 之前设置，OrbitControls 会基于 camera.up 缓存内部旋转基准
    this.upAxis = options.upAxis ?? 'Z_UP';
    if (this.upAxis === 'Z_UP') {
      this.camera.up.set(0, 0, 1);
    } else {
      this.camera.up.set(0, 1, 0);
    }

    // 轨道控制器（轨道目标默认为原点，外部可在构造后通过 controls.target 修改）
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.1;
    this.controls.update();

    // 工具栏（独立类）。Toolbar 不涉及 DOM、不构造按钮，容器与按钮均由外部程序创建并挂载
    this.toolbar = new Toolbar(this.controls, this.sceneBBox, this.upAxis);

    // ViewCube（独立类，叠加渲染在主画布右上角）
    this.viewCube = new ViewCube(this.renderer.domElement, container, {
      size: 120,
      margin: 10,
      upAxis: this.upAxis,
      onFaceClick: (dir) => this.flyToDirection(dir),
      onDragRotate: (rotY, rotX) => this.rotateByDrag(rotY, rotX),
    });

    // ViewCube 开关设置（默认启用）
    this.setViewCubeEnabled(options.viewCubeEnabled ?? true);
  }

  /**
   * 设置是否启用 ViewCube。
   * 禁用时会隐藏其交互层并跳过姿态同步与叠加渲染。
   */
  public setViewCubeEnabled(enabled: boolean): void {
    this.viewCubeEnabled = enabled;
    this.viewCube.setVisible(enabled);
  }

  /** 当前是否启用 ViewCube */
  public isViewCubeEnabled(): boolean {
    return this.viewCubeEnabled;
  }

  /** 将相机平滑重置到指定方向（ViewCube 点击时调用） */
  public flyToDirection(direction: THREE.Vector3, duration = 0.5): void {
    const target = this.controls.target;
    const dist = this.camera.position.distanceTo(target);
    // 内部球坐标计算统一在 Y-UP 基准系中进行（THREE.Spherical 以 +Y 为极轴），
    // Z-UP 时先把世界方向换算到该基准系
    const fromDir = this.worldToYUp(this.camera.position.clone().sub(target).normalize());
    const toDir = this.worldToYUp(direction.clone().normalize());

    // 在球坐标（方位角 theta / 极角 phi）空间插值，而不是大圆 slerp：
    // 大圆路径在靠近极点（上/下方向）时水平分量 (x,z) 趋近于 0，
    // 绕 Y 轴的旋转会被压缩到动画末尾的极短时间内，表现为转速突然变得非常快；
    // 球坐标插值让两个分量随缓动同步、均匀地变化，速度平稳。
    // 注意：OrbitControls 构造时缓存了基于 camera.up 的内部旋转基准，运行时不能修改 up；
    // 球坐标计算统一在 Y-UP 基准系中进行，并把极角限制在远离极点的范围。
    const from = new THREE.Spherical().setFromVector3(fromDir);
    const to = new THREE.Spherical().setFromVector3(toDir);
    from.phi = THREE.MathUtils.clamp(from.phi, PHI_EPS, Math.PI - PHI_EPS);
    to.phi = THREE.MathUtils.clamp(to.phi, PHI_EPS, Math.PI - PHI_EPS);
    // 方位角走最短路径
    if (to.theta - from.theta > Math.PI) to.theta -= Math.PI * 2;
    else if (to.theta - from.theta < -Math.PI) to.theta += Math.PI * 2;

    this.tween = {
      t: 0,
      duration,
      fromTheta: from.theta,
      toTheta: to.theta,
      fromPhi: from.phi,
      toPhi: to.phi,
      dist,
      target: target.clone(),
    };
    this.controls.enabled = false;
  }

  /**
   * 每帧更新：由外部渲染循环调用，
   * 驱动相机飞行动画、控制器阻尼与 ViewCube 姿态同步。
   */
  public update(deltaTime: number): void {
    if (this.disposed) return;

    this.updateFaceTween(deltaTime);
    if (!this.tween) this.controls.update();
    // ViewCube 姿态跟随相机同步变换（禁用时跳过）
    if (this.viewCubeEnabled) this.viewCube.update(this.camera);

    this.toolbar.updateClippingPlaneScreenSize();
    this.toolbar.updateSectionBoxArrowScreenSize();
    this.toolbar.getSectionBox()?.updatePlanes();
  }

  /**
   * 在主画布右上角叠加渲染 ViewCube。
   * 必须在外部渲染完场景之后调用，否则会被场景渲染的清屏覆盖。
   */
  public renderViewCube(): void {
    if (this.disposed || !this.viewCubeEnabled) return;
    this.viewCube.render(this.renderer);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.viewCube.dispose();
    this.toolbar.dispose();
    this.controls.dispose();
    // renderer 与渲染循环均由外部持有，这里不处理
  }

  /**
   * ViewCube 拖拽旋转：把拖拽增量换算为相机绕轨道目标的旋转，
   * 使场景与 ViewCube 一起随拖拽同步转动（方向与 OrbitControls 拖拽一致：抓取式跟随鼠标）。
   * rotY 为水平拖拽增量（右拖为正），rotX 为垂直拖拽增量（下拖为正）。
   */
  private rotateByDrag(rotY: number, rotX: number): void {
    // 拖拽时中止飞行动画并恢复控制器
    if (this.tween) {
      this.tween = null;
      this.controls.enabled = true;
    }

    const target = this.controls.target;
    const offset = this.worldToYUp(this.camera.position.clone().sub(target));
    const spherical = new THREE.Spherical().setFromVector3(offset);
    // OrbitControls 拖右时 theta 减小（相机绕向 -X）、拖下时 phi 减小（相机升高），
    // 这里取相反增量保持与主画布拖拽方向一致
    spherical.theta -= rotY;
    spherical.phi = THREE.MathUtils.clamp(spherical.phi - rotX, PHI_EPS, Math.PI - PHI_EPS);
    offset.setFromSpherical(spherical);
    this.yUpToWorld(offset);
    this.camera.position.copy(target).add(offset);
    this.camera.lookAt(target);
  }

  /** 世界方向 → Y-UP 基准系方向（原位修改并返回）。内部球坐标计算统一在该基准系进行 */
  private worldToYUp(v: THREE.Vector3): THREE.Vector3 {
    if (this.upAxis === 'Y_UP') return v;
    // 绕 X 轴 -90°：(x,y,z) → (x,z,-y)，使世界 +Z（Z-UP 的上方向）映射为 +Y
    // 注意：-y 需把 -0 归一为 0。否则上/下方向 (0,0,±1) 映射后 z 分量为 -0，
    // Spherical.setFromVector3 中 atan2(0, -0) 返回 π（而非 0），
    // 导致点击"上/下"面后相机固定从"后"侧倾斜到极点，ViewCube 上/下面文字上下颠倒
    const { x, y, z } = v;
    return v.set(x === 0 ? 0 : x, z, y === 0 ? 0 : -y);
  }

  /** Y-UP 基准系方向 → 世界方向（worldToYUp 的逆变换，原位修改并返回） */
  private yUpToWorld(v: THREE.Vector3): THREE.Vector3 {
    if (this.upAxis === 'Y_UP') return v;
    const { x, y, z } = v;
    return v.set(x, -z, y);
  }

  private updateFaceTween(delta: number): void {
    const tw = this.tween;
    if (!tw) return;
    tw.t = Math.min(1, tw.t + delta / tw.duration);
    const k = tw.t < 0.5 ? 2 * tw.t * tw.t : 1 - Math.pow(-2 * tw.t + 2, 2) / 2;

    const theta = THREE.MathUtils.lerp(tw.fromTheta, tw.toTheta, k);
    const phi = THREE.MathUtils.lerp(tw.fromPhi, tw.toPhi, k);
    const dir = this.yUpToWorld(new THREE.Vector3().setFromSphericalCoords(1, phi, theta));
    this.camera.position.copy(tw.target).addScaledVector(dir, tw.dist);
    this.camera.lookAt(tw.target);

    if (tw.t >= 1) {
      this.tween = null;
      this.controls.enabled = true;
      this.controls.update();
    }
  }
}
