import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { ClippingPlane } from './ClippingPlane';

/** 操作柄箭头的基准方向（几何体沿 +Y 生成，再整体对齐到法线方向） */
const HANDLE_UP = new THREE.Vector3(0, 1, 0);

/** 操作柄在屏幕上的固定显示长度（像素） */
const SCREEN_LENGTH_PX = 100;

/** 操作柄默认（非激活）透明度 */
const OPACITY_INACTIVE = 0.6;

/** 操作柄激活（悬停 / 拖拽）时的透明度 */
const OPACITY_ACTIVE = 1;

/** 临时向量（避免每帧分配） */
const _worldPos = new THREE.Vector3();

/**
 * ClippingPlaneHandle - 剖切面操作柄（白色三维箭头）的可视化构造与鼠标交互。
 *
 * 可视化：圆柱杆 + 圆锥头沿 +Y 生成，通过 setDirection() 对齐剖切面法线；
 *   另含一个不可见的放大命中代理以扩大拾取范围。关闭深度测试并提高
 *   renderOrder，保证手柄被模型遮挡时仍可见可点。
 *
 * 交互：在 window 捕获阶段监听 pointer 事件（先于 OrbitControls 与其他
 *   自定义拖拽逻辑触发），命中操作柄时拦截事件，把指针位移投影到剖切面
 *   法线方向，换算为沿法线的偏移量并更新剖切面；悬停时显示抓手光标。
 */
export class ClippingPlaneHandle {
  /** 操作柄可视化对象（含杆、锥头与命中代理），由外部加入场景渲染 */
  public readonly object3d: THREE.Group;

  private shaft: THREE.Mesh;
  private cone: THREE.Mesh;
  /** 不可见的放大命中代理（扩大拾取范围） */
  private handleHit: THREE.Mesh;
  private handleMaterial: THREE.MeshBasicMaterial;
  /** 操作柄几何总长（杆 + 锥头，世界单位，缩放前），用于换算屏幕固定尺寸 */
  private readonly baseLength: number;

  // ---------- 鼠标交互状态 ----------
  private canvas: HTMLElement | null = null;
  private controls: OrbitControls | null = null;
  private plane: ClippingPlane | null = null;
  /** 正在拖拽的指针 id，null 表示未在拖拽 */
  private dragPointerId: number | null = null;
  /** 拖拽平面（垂直于相机视线、过手柄原点）与拖拽起点及起点沿法线偏移量 */
  private readonly dragPlane = new THREE.Plane();
  private readonly dragStartPoint = new THREE.Vector3();
  private dragStartOffset = 0;
  private readonly raycaster = new THREE.Raycaster();

  constructor(size: number) {
    const shaftLength = size * 0.1;
    const coneHeight = size * 0.05;
    const coneRadius = size * 0.02;
    const shaftRadius = size * 0.006;
    this.baseLength = shaftLength + coneHeight;

    // 关闭深度测试并提高 renderOrder，保证手柄被模型遮挡时仍可见可点
    this.handleMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      depthTest: false,
      transparent: true,
      opacity: OPACITY_INACTIVE,
      toneMapped: false,
    });

    this.shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(shaftRadius, shaftRadius, shaftLength, 16),
      this.handleMaterial,
    );
    this.shaft.position.y = shaftLength / 2;
    this.shaft.renderOrder = 999;

    this.cone = new THREE.Mesh(new THREE.ConeGeometry(coneRadius, coneHeight, 24), this.handleMaterial);
    this.cone.position.y = shaftLength + coneHeight / 2;
    this.cone.renderOrder = 999;

    // 不可见的放大命中代理（material.visible = false 不参与渲染，但仍可被射线拾取）
    this.handleHit = new THREE.Mesh(
      new THREE.CylinderGeometry(coneRadius * 2.5, coneRadius * 2.5, shaftLength + coneHeight, 8),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    this.handleHit.position.y = (shaftLength + coneHeight) / 2;

    this.object3d = new THREE.Group();
    this.object3d.add(this.shaft, this.cone, this.handleHit);
  }

  /** 操作柄始终指向剖切面法线方向（flip / 位置变化时由 ClippingPlane 调用） */
  public setDirection(normal: THREE.Vector3): void {
    this.object3d.quaternion.setFromUnitVectors(HANDLE_UP, normal);
  }

  /** 设置激活状态：激活（悬停 / 拖拽）时透明度为 1，否则为默认透明度 */
  public setActive(active: boolean): void {
    this.handleMaterial.opacity = active ? OPACITY_ACTIVE : OPACITY_INACTIVE;
  }

  /**
   * 固定操作柄在屏幕上的显示长度（SCREEN_LENGTH_PX 像素）：
   * 依据手柄到相机的距离换算每像素对应的世界单位数，反推整体缩放系数。
   * 由渲染循环每帧调用，相机移动 / 缩放时手柄在屏幕上的大小保持不变。
   * @param camera 当前渲染相机（支持透视 / 正交）
   * @param viewportHeightPx 视口高度（像素）
   */
  public updateScreenSize(camera: THREE.Camera, viewportHeightPx: number): void {
    if (viewportHeightPx <= 0) return;
    const distance = camera.position.distanceTo(this.object3d.getWorldPosition(_worldPos));
    let visibleHeight: number;
    if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
      const persp = camera as THREE.PerspectiveCamera;
      visibleHeight = (2 * Math.tan(THREE.MathUtils.degToRad(persp.fov) / 2) * distance) / persp.zoom;
    } else if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
      const ortho = camera as THREE.OrthographicCamera;
      visibleHeight = (ortho.top - ortho.bottom) / ortho.zoom;
    } else {
      return;
    }
    const worldPerPixel = visibleHeight / viewportHeightPx;
    this.object3d.scale.setScalar((SCREEN_LENGTH_PX * worldPerPixel) / this.baseLength);
  }

  /**
   * 判断射线是否命中操作柄（用于悬停光标反馈与拖拽起点判定）。
   * @param raycaster 由外部根据指针位置与相机构建的射线
   */
  public hitTest(raycaster: THREE.Raycaster): boolean {
    return raycaster.intersectObjects([this.shaft, this.cone, this.handleHit], false).length > 0;
  }

  /** 是否正在拖拽平移手柄（供其他手柄互斥判断） */
  public isDragging(): boolean {
    return this.dragPointerId !== null;
  }

  /** 释放可视化资源并解绑交互监听（geometry/material） */
  public dispose(): void {
    this.detachInteraction();
    this.shaft.geometry.dispose();
    this.cone.geometry.dispose();
    this.handleHit.geometry.dispose();
    (this.handleHit.material as THREE.Material).dispose();
    this.handleMaterial.dispose();
    this.object3d.removeFromParent();
  }

  // ---------- 鼠标交互：绑定 / 解绑 ----------

  /**
   * 绑定交互：在 window 捕获阶段挂载 pointer 监听（先于 OrbitControls 与
   * 其他拖拽逻辑触发），命中操作柄时拦截事件，只允许沿剖切面法线方向拖动。
   * 重复调用会先解绑旧的再绑定新的。
   */
  public attachInteraction(canvas: HTMLElement, controls: OrbitControls, plane: ClippingPlane): void {
    this.detachInteraction();
    this.canvas = canvas;
    this.controls = controls;
    this.plane = plane;
    window.addEventListener('pointerdown', this.onPointerDown, true);
    window.addEventListener('pointermove', this.onPointerMove, true);
    window.addEventListener('pointerup', this.onPointerUp, true);
    window.addEventListener('pointercancel', this.onPointerUp, true);
  }

  /** 解绑交互监听；若正在拖拽则一并复位拖拽相关状态 */
  public detachInteraction(): void {
    window.removeEventListener('pointerdown', this.onPointerDown, true);
    window.removeEventListener('pointermove', this.onPointerMove, true);
    window.removeEventListener('pointerup', this.onPointerUp, true);
    window.removeEventListener('pointercancel', this.onPointerUp, true);
    if (this.dragPointerId !== null) {
      this.dragPointerId = null;
      if (this.controls) this.controls.enabled = true;
      if (this.canvas) this.canvas.style.cursor = '';
    }
    this.canvas = null;
    this.controls = null;
    this.plane = null;
  }

  // ---------- 指针事件处理 ----------

  private onPointerDown = (event: PointerEvent): void => {
    const { canvas, controls, plane } = this;
    if (!canvas || !controls || !plane) return;
    // 仅响应画布上的左键 / 主指针（触控）
    if (event.target !== canvas) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (event.pointerType !== 'mouse' && !event.isPrimary) return;
    // 鼠标按下时已有其他按键处于按下状态（正在场景中进行其他拖拽交互），不激活
    if (event.pointerType === 'mouse' && event.buttons !== 1) return;

    if (plane.rotationHandle.isDragging()) return;

    const raycaster = this.makeRaycaster(event);
    if (!raycaster || !this.beginDrag(raycaster, controls.object)) return;

    // 命中操作柄：拦截事件（阻止 OrbitControls / 自定义缩放响应），开始法线方向拖拽
    event.stopPropagation();
    event.preventDefault();
    this.setActive(true);
    this.dragPointerId = event.pointerId;
    controls.enabled = false;
    if (!canvas.hasPointerCapture(event.pointerId)) canvas.setPointerCapture(event.pointerId);
    canvas.style.cursor = 'grabbing';
  };

  private onPointerMove = (event: PointerEvent): void => {
    const { canvas, plane } = this;
    if (!canvas || !plane) return;

    // 拖拽中：交点位移投影到法线方向，更新剖切面位置
    if (this.dragPointerId !== null) {
      if (event.pointerId !== this.dragPointerId) return;
      const raycaster = this.makeRaycaster(event);
      if (raycaster) this.dragTo(raycaster);
      return;
    }

    // 非拖拽时：悬停在操作柄上显示抓手光标并高亮（透明度 1）
    if (event.target !== canvas || event.pointerType !== 'mouse') return;
    // 鼠标按下拖拽中（场景内其他交互，如旋转 / 平移 / 缩放）不激活操作柄
    if (event.buttons !== 0) return;
    const raycaster = this.makeRaycaster(event);
    if (!raycaster) return;
    const hit = this.hitTest(raycaster);
    this.setActive(hit);
    canvas.style.cursor = hit ? 'grab' : '';
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (this.dragPointerId === null || event.pointerId !== this.dragPointerId) return;
    this.dragPointerId = null;
    if (this.controls) this.controls.enabled = true;
    if (this.canvas) {
      if (this.canvas.hasPointerCapture(event.pointerId)) {
        this.canvas.releasePointerCapture(event.pointerId);
      }
      // 拖拽结束：根据指针当前位置是否仍悬停在手柄上恢复透明度与光标
      const raycaster = this.makeRaycaster(event);
      const hit = raycaster !== null && this.hitTest(raycaster);
      this.setActive(hit);
      this.canvas.style.cursor = hit ? 'grab' : '';
    }
  };

  // ---------- 拖拽实现 ----------

  /**
   * 尝试开始拖拽操作柄：射线命中操作柄时锁定拖拽状态。
   * 拖拽平面取"过手柄原点、垂直于相机视线"的平面，保证拖动手感稳定。
   * @returns 是否命中并成功开始拖拽
   */
  private beginDrag(raycaster: THREE.Raycaster, camera: THREE.Camera): boolean {
    const plane = this.plane;
    if (!plane) return false;
    if (!this.hitTest(raycaster)) return false;
    const origin = this.object3d.getWorldPosition(new THREE.Vector3());
    const camDir = camera.getWorldDirection(new THREE.Vector3());
    this.dragPlane.setFromNormalAndCoplanarPoint(camDir, origin);
    if (!raycaster.ray.intersectPlane(this.dragPlane, this.dragStartPoint)) return false;
    this.dragStartOffset = plane.getOffsetAlongNormal();
    return true;
  }

  /**
   * 拖拽中：把指针射线与拖拽平面的交点相对起点的位移投影到（旋转后的）
   * 剖切面法线方向，换算为沿法线的偏移量并更新剖切面（只在法线方向上移动）。
   */
  private dragTo(raycaster: THREE.Raycaster): void {
    const plane = this.plane;
    if (!plane) return;
    const point = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(this.dragPlane, point)) return;
    const deltaAlongNormal = point.sub(this.dragStartPoint).dot(plane.getPlane().normal);
    plane.setOffsetAlongNormal(this.dragStartOffset + deltaAlongNormal);
  }

  /** 由指针事件构建 NDC 射线（基于画布尺寸与相机） */
  private makeRaycaster(event: PointerEvent): THREE.Raycaster | null {
    const canvas = this.canvas;
    const controls = this.controls;
    if (!canvas || !controls) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, controls.object);
    return this.raycaster;
  }
}
