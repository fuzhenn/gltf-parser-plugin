import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { ClippingPlane } from './ClippingPlane';

/** 圆环几何默认位于 XY 平面，其法线为 +Z（对齐目标即旋转轴） */
const TORUS_NORMAL = new THREE.Vector3(0, 0, 1);
/** 求圆环初始法线时的参考向量（避免与剖切面法线平行） */
const REF_UP = new THREE.Vector3(0, 1, 0);
const REF_X = new THREE.Vector3(1, 0, 0);

/** 未激活时显示的圆弧角度（30°），激活时恢复为完整圆环 */
const INACTIVE_ARC_ANGLE = Math.PI / 3;
/** 未激活时的不透明度（激活时恢复为 0.9） */
const INACTIVE_OPACITY = 0.35;
const ACTIVE_OPACITY = 0.9;

/**
 * ClippingPlaneRotationHandle - 剖切面旋转手柄（两个圆环）的可视化构造与鼠标交互。
 *
 * 可视化：两个圆环（TorusGeometry）均位于剖切面的垂面内（圆环平面 ⊥ 剖切面，
 *   且两个圆环平面互相垂直）。每个圆环的法线（即旋转轴）落在剖切面内，
 *   拖拽某个圆环即让剖切面绕该圆环的法线方向旋转。
 *
 * 旋转角度与拖拽幅度的一致性：拖拽时把"起点处圆环切线方向"投影到屏幕，
 *   并计算圆环上该点沿切线扫过单位弧度对应的屏幕像素数 K（像素/弧度），
 *   之后 dAngle = 指针沿屏幕切线方向的位移 / K。该映射只依赖圆环自身的
 *   屏幕投影，与相机处于圆环哪个方位无关 —— 无论从哪个角度看，鼠标拖过
 *   同样的屏幕弧长都对应同样的旋转角度（相当于沿投影椭圆的切向直接"拨动"
 *   圆环，而非固定灵敏度）。
 *
 * 交互：与 ClippingPlaneHandle 相同，在 window 捕获阶段监听 pointer 事件，
 *   命中圆环时拦截事件并禁用 OrbitControls；悬停显示抓手光标并高亮圆环。
 */
export class ClippingPlaneRotationHandle {
  /** 旋转手柄可视化对象（含两个圆环与命中代理），由外部加入场景渲染 */
  public readonly object3d: THREE.Group;

  /** 两个圆环的可视化网格 */
  private readonly rings: THREE.Mesh[] = [];
  /** 两个圆环的不可见放大命中代理 */
  private readonly ringHits: THREE.Mesh[] = [];
  /** 未激活时显示的 30° 圆弧几何 / 激活时显示的完整圆环几何 */
  private readonly arcGeometries: THREE.TorusGeometry[] = [];
  private readonly fullGeometries: THREE.TorusGeometry[] = [];
  /** 命中代理几何：未激活时为与显示圆弧对齐的加粗圆弧 / 激活时为完整加粗圆环 */
  private readonly arcHitGeometries: THREE.TorusGeometry[] = [];
  private readonly fullHitGeometries: THREE.TorusGeometry[] = [];
  private readonly materials: THREE.MeshBasicMaterial[] = [];
  /** 两个圆环的基色（悬停/拖拽时高亮为白色） */
  private readonly baseColors = [0xffa640, 0x5fd68a];
  private readonly highlightColor = 0xffffff;

  /**
   * 两个圆环的法线（各自旋转轴），恒垂直于剖切面法线且互相垂直。
   * 由 setFromNormal() 随剖切面法线持续正交化更新，保证旋转过程中圆环稳定。
   */
  private readonly ringAxes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)];
  private axesInitialized = false;
  private activeRing = -1;

  // ---------- 鼠标交互状态 ----------
  private canvas: HTMLElement | null = null;
  private controls: OrbitControls | null = null;
  private plane: ClippingPlane | null = null;
  /** 正在拖拽的指针 id，null 表示未在拖拽 */
  private dragPointerId: number | null = null;
  private readonly raycaster = new THREE.Raycaster();

  // ---------- 拖拽快照（开始拖拽时定格，期间不随圆环重建而变化） ----------
  /** 本手势的旋转轴（被拖圆环的法线，世界坐标） */
  private readonly dragAxis = new THREE.Vector3();
  /** 圆环平面内与旋转轴垂直的正交基 A/B：圆环上角度 θ 处的点 = center + r(cosθ·A + sinθ·B) */
  private readonly dragBasisA = new THREE.Vector3();
  private readonly dragBasisB = new THREE.Vector3();
  /** 圆环中心（世界坐标） */
  private readonly dragCenter = new THREE.Vector3();
  /** 拖拽起始角与上次已应用角（弧度） */
  private dragStartAngle = 0;
  private dragLastAngle = 0;
  /** 起点处圆环切线的屏幕投影方向（单位，像素坐标） */
  private readonly dragScreenTangent = new THREE.Vector2();
  /** 圆环上该点沿切线扫过 1 弧度对应的屏幕像素数 */
  private dragPixelsPerRadian = 1;
  /** 拖拽起始的指针屏幕坐标（像素） */
  private readonly dragStartScreen = new THREE.Vector2();

  constructor(size: number) {
    const ringRadius = size * 0.22;
    const tubeRadius = size * 0.002;
    const hitTubeRadius = size * 0.014;

    for (let i = 0; i < 2; i++) {
      const material = new THREE.MeshBasicMaterial({
        color: this.baseColors[i],
        depthTest: false,
        transparent: true,
        opacity: INACTIVE_OPACITY,
        toneMapped: false,
        side: THREE.DoubleSide,
      });
      this.materials.push(material);

      const arcGeometry = new THREE.TorusGeometry(ringRadius, tubeRadius, 8, 96, INACTIVE_ARC_ANGLE);
      const fullGeometry = new THREE.TorusGeometry(ringRadius, tubeRadius, 8, 96);
      this.arcGeometries.push(arcGeometry);
      this.fullGeometries.push(fullGeometry);

      // 初始为未激活状态：仅显示 30° 圆弧
      const ring = new THREE.Mesh(arcGeometry, material);
      ring.renderOrder = 999;
      this.rings.push(ring);

      // 不可见的放大命中代理（material.visible = false 不参与渲染，但仍可被射线拾取）。
      // 未激活时命中范围仅为与显示圆弧对齐的加粗圆弧，避免悬停在未显示的圆环部分时误激活
      this.arcHitGeometries.push(new THREE.TorusGeometry(ringRadius, hitTubeRadius, 8, 48, INACTIVE_ARC_ANGLE));
      this.fullHitGeometries.push(new THREE.TorusGeometry(ringRadius, hitTubeRadius, 8, 48));
      const hit = new THREE.Mesh(
        this.arcHitGeometries[i],
        new THREE.MeshBasicMaterial({ visible: false }),
      );
      hit.userData.ringIndex = i;
      this.ringHits.push(hit);
    }

    this.object3d = new THREE.Group();
    this.object3d.add(...this.rings, ...this.ringHits);
  }

  /**
   * 依据剖切面当前法线更新两个圆环的朝向（每次剖切面旋转后由 ClippingPlane 调用）。
   * 首次调用时从法线派生两条互相垂直的面内轴；之后只做持续正交化，
   * 保证连续旋转时两个圆环（及其颜色对应的旋转轴）不会跳变互换。
   */
  public setFromNormal(normal: THREE.Vector3): void {
    const n = normal.clone().normalize();
    if (!this.axesInitialized) {
      const ref = Math.abs(n.dot(REF_UP)) < 0.99 ? REF_UP : REF_X;
      this.ringAxes[0].crossVectors(ref, n).normalize();
      this.axesInitialized = true;
    } else {
      // 把已有轴投影回新的剖切面内（去掉法线分量），保持连续性
      this.ringAxes[0].addScaledVector(n, -this.ringAxes[0].dot(n)).normalize();
    }
    // 第二条轴由叉积保证与法线、第一条轴都垂直
    this.ringAxes[1].crossVectors(n, this.ringAxes[0]).normalize();

    for (let i = 0; i < 2; i++) {
      const q = new THREE.Quaternion().setFromUnitVectors(TORUS_NORMAL, this.ringAxes[i]);
      // 圆环平面包含剖切面法线（箭头方向）：计算 +法线在圆环局部坐标下对应的角度，
      // 再绕圆环自身法线旋转，使 30° 圆弧的中点始终位于箭头顶部方向对应的圆环点上
      const localX = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
      const localY = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
      const targetAngle = Math.atan2(normal.dot(localY), normal.dot(localX));
      const arcOffset = targetAngle - INACTIVE_ARC_ANGLE / 2;
      const arcQuat = new THREE.Quaternion().setFromAxisAngle(TORUS_NORMAL, arcOffset);
      this.rings[i].quaternion.copy(q).multiply(arcQuat);
      // 命中代理同样对齐圆弧偏转：未激活时其加粗圆弧几何与显示的 30° 圆弧重合
      this.ringHits[i].quaternion.copy(q).multiply(arcQuat);
    }
  }

  /**
   * 判断射线是否命中某个圆环，返回圆环索引（0/1），未命中返回 -1。
   * @param raycaster 由外部根据指针位置与相机构建的射线
   */
  public hitTest(raycaster: THREE.Raycaster): number {
    const hits = raycaster.intersectObjects([...this.rings, ...this.ringHits], false);
    if (hits.length === 0) return -1;
    const index = hits[0].object.userData.ringIndex;
    return typeof index === 'number' ? index : -1;
  }

  /** 是否正在拖拽旋转手柄 */
  public isDragging(): boolean {
    return this.dragPointerId !== null;
  }

  /** 释放可视化资源并解绑交互监听（geometry/material） */
  public dispose(): void {
    this.detachInteraction();
    for (const geometry of this.arcGeometries) geometry.dispose();
    for (const geometry of this.fullGeometries) geometry.dispose();
    this.arcGeometries.length = 0;
    this.fullGeometries.length = 0;
    for (const geometry of this.arcHitGeometries) geometry.dispose();
    for (const geometry of this.fullHitGeometries) geometry.dispose();
    this.arcHitGeometries.length = 0;
    this.fullHitGeometries.length = 0;
    for (const hit of this.ringHits) {
      (hit.material as THREE.Material).dispose();
    }
    for (const material of this.materials) material.dispose();
    this.rings.length = 0;
    this.ringHits.length = 0;
    this.materials.length = 0;
    this.object3d.removeFromParent();
  }

  // ---------- 鼠标交互：绑定 / 解绑 ----------

  /**
   * 绑定交互：在 window 捕获阶段挂载 pointer 监听（先于 OrbitControls 触发），
   * 命中圆环时拦截事件，绕该圆环法线方向旋转剖切面。
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
      this.setRingHighlight(this.activeRing, false);
      this.activeRing = -1;
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
    // 平移箭头手柄已开始拖拽（其监听先注册且已 preventDefault）时不再响应
    if (event.defaultPrevented || plane.handle.isDragging()) return;

    const raycaster = this.makeRaycaster(event);
    if (!raycaster) return;
    // 平移操作柄被命中（悬停）时优先响应平移，旋转手柄不激活
    if (plane.handle.hitTest(raycaster)) return;
    const ringIndex = this.hitTest(raycaster);
    if (ringIndex < 0 || !this.beginDrag(ringIndex, event, raycaster, controls.object)) return;

    // 命中圆环：拦截事件（阻止 OrbitControls / 其他手柄响应），开始旋转拖拽
    event.stopPropagation();
    event.preventDefault();
    this.activeRing = ringIndex;
    this.setRingHighlight(ringIndex, true);
    this.dragPointerId = event.pointerId;
    controls.enabled = false;
    if (!canvas.hasPointerCapture(event.pointerId)) canvas.setPointerCapture(event.pointerId);
    canvas.style.cursor = 'grabbing';
  };

  private onPointerMove = (event: PointerEvent): void => {
    const { canvas, plane } = this;
    if (!canvas || !plane) return;

    // 拖拽中：按屏幕切向位移换算旋转角并应用
    if (this.dragPointerId !== null) {
      if (event.pointerId !== this.dragPointerId) return;
      this.dragTo(event);
      return;
    }

    // 非拖拽时：悬停在圆环上显示抓手光标并高亮对应圆环
    if (event.target !== canvas || event.pointerType !== 'mouse') return;
    // 鼠标按下拖拽中（场景内其他交互，如旋转 / 平移 / 缩放）不激活旋转手柄
    if (event.buttons !== 0) return;
    if (plane.handle.isDragging()) return;
    const raycaster = this.makeRaycaster(event);
    if (!raycaster) return;
    // 悬停在平移操作柄上时不激活旋转手柄（不高亮圆环、不显示抓手光标）
    const ringIndex = plane.handle.hitTest(raycaster) ? -1 : this.hitTest(raycaster);
    if (ringIndex !== this.activeRing) {
      this.setRingHighlight(this.activeRing, false);
      this.setRingHighlight(ringIndex, true);
      this.activeRing = ringIndex;
    }
    canvas.style.cursor = ringIndex >= 0 ? 'grab' : '';
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (this.dragPointerId === null || event.pointerId !== this.dragPointerId) return;
    this.dragPointerId = null;
    this.setRingHighlight(this.activeRing, false);
    this.activeRing = -1;
    if (this.controls) this.controls.enabled = true;
    if (this.canvas) {
      if (this.canvas.hasPointerCapture(event.pointerId)) {
        this.canvas.releasePointerCapture(event.pointerId);
      }
      this.canvas.style.cursor = '';
    }
  };

  // ---------- 拖拽实现 ----------

  /**
   * 尝试开始旋转拖拽：定格本手势的旋转轴 / 正交基 / 屏幕切向与像素-弧度比。
   * @returns 是否成功开始拖拽
   */
  private beginDrag(ringIndex: number, event: PointerEvent, raycaster: THREE.Raycaster, camera: THREE.Camera): boolean {
    const plane = this.plane;
    if (!plane) return false;

    // 拾取点即拖拽起始的圆环上的点
    const hits = raycaster.intersectObjects([this.rings[ringIndex], this.ringHits[ringIndex]], false);
    if (hits.length === 0) return false;

    const axis = this.ringAxes[ringIndex];
    // 与旋转轴垂直的面内正交基：取另一个圆环的法线为 A（两轴互相垂直）
    const a = this.ringAxes[1 - ringIndex];
    const b = new THREE.Vector3().crossVectors(axis, a).normalize();

    const center = this.object3d.getWorldPosition(new THREE.Vector3());
    const grab = hits[0].point.clone().sub(center);
    const startAngle = Math.atan2(grab.dot(b), grab.dot(a));

    const rect = this.canvas!.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const ringRadius = (this.rings[ringIndex].geometry as THREE.TorusGeometry).parameters.radius;

    // 起点处的屏幕切向与"像素/弧度"比例：比较 θ0 与 θ0+dθ 两点的屏幕投影。
    // 该比例等于圆环屏幕投影椭圆在起点处的切向速率，与相机方位无关，
    // 从而保证旋转角与鼠标拖拽幅度（屏幕弧长）处处一致。
    const dTheta = 0.01;
    const p0 = pointOnRing(center, a, b, ringRadius, startAngle);
    const p1 = pointOnRing(center, a, b, ringRadius, startAngle + dTheta);
    const s0 = this.worldToScreen(p0, camera, rect);
    const s1 = this.worldToScreen(p1, camera, rect);
    const tangent = s1.clone().sub(s0);
    const pixelsPerRadian = tangent.length() / dTheta;
    if (pixelsPerRadian <= 0) return false;

    // 退化保护：从几乎平行于圆环平面的视角抓住轮廓点时切向投影趋近 0，
    // 限制最小比例（按圆环屏幕半径的一小部分），避免极微小抖动导致疯转。
    const centerScreen = this.worldToScreen(center, camera, rect);
    const screenRadius = s0.distanceTo(centerScreen);
    const clamped = Math.max(pixelsPerRadian, screenRadius * 0.1, 1e-3);

    this.dragAxis.copy(axis);
    this.dragBasisA.copy(a);
    this.dragBasisB.copy(b);
    this.dragCenter.copy(center);
    this.dragStartAngle = startAngle;
    this.dragLastAngle = startAngle;
    this.dragScreenTangent.copy(tangent.normalize());
    this.dragPixelsPerRadian = clamped;
    this.dragStartScreen.set(event.clientX - rect.left, event.clientY - rect.top);
    return true;
  }

  /** 拖拽中：指针沿屏幕切向的位移换算为绕轴旋转角（绝对角度，无累计漂移） */
  private dragTo(event: PointerEvent): void {
    const plane = this.plane;
    if (!plane || !this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const current = new THREE.Vector2(event.clientX - rect.left, event.clientY - rect.top);
    const deltaPixels = current.sub(this.dragStartScreen).dot(this.dragScreenTangent);
    const targetAngle = this.dragStartAngle + deltaPixels / this.dragPixelsPerRadian;
    const deltaAngle = targetAngle - this.dragLastAngle;
    if (deltaAngle === 0) return;
    this.dragLastAngle = targetAngle;
    plane.rotateAroundWorldAxis(this.dragAxis, deltaAngle);
  }

  /** 高亮 / 恢复圆环颜色（悬停与拖拽反馈）；激活时恢复完整圆环与不透明度 */
  private setRingHighlight(ringIndex: number, highlighted: boolean): void {
    if (ringIndex < 0) return;
    this.materials[ringIndex].color.setHex(highlighted ? this.highlightColor : this.baseColors[ringIndex]);
    this.materials[ringIndex].opacity = highlighted ? ACTIVE_OPACITY : INACTIVE_OPACITY;
    this.rings[ringIndex].geometry = highlighted ? this.fullGeometries[ringIndex] : this.arcGeometries[ringIndex];
    // 命中范围随激活状态切换：未激活时仅显示圆弧可命中，激活后整圈可命中
    this.ringHits[ringIndex].geometry = highlighted
      ? this.fullHitGeometries[ringIndex]
      : this.arcHitGeometries[ringIndex];
  }

  /** 世界坐标点 → 屏幕像素坐标（左上角为原点） */
  private worldToScreen(point: THREE.Vector3, camera: THREE.Camera, rect: DOMRect): THREE.Vector2 {
    const v = point.clone().project(camera);
    return new THREE.Vector2((v.x + 1) / 2 * rect.width, (1 - v.y) / 2 * rect.height);
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

/** 计算圆环上角度 θ 处的世界坐标点 */
function pointOnRing(
  center: THREE.Vector3,
  basisA: THREE.Vector3,
  basisB: THREE.Vector3,
  radius: number,
  angle: number,
): THREE.Vector3 {
  return center
    .clone()
    .addScaledVector(basisA, Math.cos(angle) * radius)
    .addScaledVector(basisB, Math.sin(angle) * radius);
}
