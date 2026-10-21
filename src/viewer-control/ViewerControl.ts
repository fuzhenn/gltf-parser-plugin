import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { ViewCube } from './ViewCube';
import { Toolbar, CameraMode } from './Toolbar';

export interface ViewerControlOptions {
  /**
   * 挂载容器（DOM 元素）。工具栏与 ViewCube 的悬浮层以 absolute 定位放置其中，
   * 因此容器应为非 static 定位（如 position: relative），由外部负责设置。
   */
  container: HTMLElement;
  /** 外部创建并完成画布挂载/尺寸设置的渲染器（ViewerControl 仅负责自适应尺寸与 ViewCube 叠加渲染） */
  renderer: THREE.WebGLRenderer;
  /**
   * 外部创建的相机（含位置、朝向、up 向量、aspect 等全部初始状态）。
   * 注意：up 向量需在传入前设置好，OrbitControls 构造时会基于它缓存内部旋转基准。
   * 轨道目标（controls.target）默认为原点，如需修改请在构造后设置。
   */
  camera: THREE.PerspectiveCamera;
}

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
 * ViewerControl - 基于 Three.js 的 CAD 风格三维查看器。
 *
 * - renderer、camera、scene 均由外部创建：renderer（含画布挂载）与 camera 通过构造参数传入，scene 由外部闭包持有；
 * - ViewerControl 不决定何时渲染场景，也不持有场景；场景渲染时机与逻辑完全由外部掌控；
 * - 渲染循环由外部驱动：外部每帧调用 update(deltaTime) 更新相机/控制器/ViewCube 姿态，
 *   自行渲染场景，并在场景渲染之后调用 renderViewCube() 叠加渲染 ViewCube；
 * - ViewerControl 负责相机/控制器与工具栏；尺寸自适应（相机 aspect 与 renderer 画布）完全由外部负责；
 * - 容器 DOM 仅在构造时使用，不作为成员保存。
 */
export class ViewerControl {
  /** 相机操作模式，外部通过 ViewerControl.CameraMode 访问 */
  public static readonly CameraMode = CameraMode;

  public readonly renderer: THREE.WebGLRenderer;
  public readonly camera: THREE.PerspectiveCamera;
  public readonly controls: OrbitControls;
  public readonly toolbar: Toolbar;
  public readonly viewCube: ViewCube;

  private tween: FaceTween | null = null;
  private disposed = false;

  constructor(options: ViewerControlOptions) {
    const container = options.container;

    // 渲染器由外部创建并完成画布挂载，ViewerControl 不构造、不销毁、不挂载，
    // 尺寸自适应完全由外部负责
    this.renderer = options.renderer;

    // 相机由外部创建并完成初始状态设置，ViewerControl 不构造
    this.camera = options.camera;

    // 轨道控制器（轨道目标默认为原点，外部可在构造后通过 controls.target 修改）
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.1;
    this.controls.update();

    // 工具栏（独立类）。Toolbar 不涉及 DOM、不构造按钮，容器与按钮均由外部程序创建并挂载
    this.toolbar = new Toolbar(this.controls);

    // ViewCube（独立类，叠加渲染在主画布右上角）
    this.viewCube = new ViewCube(this.renderer.domElement, container, {
      size: 120,
      margin: 10,
      onFaceClick: (dir) => this.flyToDirection(dir),
    });
  }

  /** 将相机平滑重置到指定方向（ViewCube 点击时调用） */
  public flyToDirection(direction: THREE.Vector3, duration = 0.5): void {
    const target = this.controls.target;
    const dist = this.camera.position.distanceTo(target);
    const fromDir = this.camera.position.clone().sub(target).normalize();
    const toDir = direction.clone().normalize();

    // 在球坐标（方位角 theta / 极角 phi）空间插值，而不是大圆 slerp：
    // 大圆路径在靠近极点（上/下方向）时水平分量 (x,z) 趋近于 0，
    // 绕 Y 轴的旋转会被压缩到动画末尾的极短时间内，表现为转速突然变得非常快；
    // 球坐标插值让两个分量随缓动同步、均匀地变化，速度平稳。
    // 注意：OrbitControls 构造时缓存了基于 camera.up 的内部基准四元数，
    // 运行时不能修改 up，因此始终用 up=(0,1,0)，并把极角限制在远离极点的范围。
    const PHI_EPS = 0.01; // 距极点约 0.57°，避免 lookAt 退化
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
    // ViewCube 姿态跟随相机同步变换
    this.viewCube.update(this.camera);
  }

  /**
   * 在主画布右上角叠加渲染 ViewCube。
   * 必须在外部渲染完场景之后调用，否则会被场景渲染的清屏覆盖。
   */
  public renderViewCube(): void {
    if (this.disposed) return;
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

  private updateFaceTween(delta: number): void {
    const tw = this.tween;
    if (!tw) return;
    tw.t = Math.min(1, tw.t + delta / tw.duration);
    const k = tw.t < 0.5 ? 2 * tw.t * tw.t : 1 - Math.pow(-2 * tw.t + 2, 2) / 2;

    const theta = THREE.MathUtils.lerp(tw.fromTheta, tw.toTheta, k);
    const phi = THREE.MathUtils.lerp(tw.fromPhi, tw.toPhi, k);
    const dir = new THREE.Vector3().setFromSphericalCoords(1, phi, theta);
    this.camera.position.copy(tw.target).addScaledVector(dir, tw.dist);
    this.camera.lookAt(tw.target);

    if (tw.t >= 1) {
      this.tween = null;
      this.controls.enabled = true;
      this.controls.update();
    }
  }
}
