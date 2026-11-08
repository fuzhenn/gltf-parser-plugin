import * as THREE from 'three';
import { ClippingPlaneHandle } from './ClippingPlaneHandle';
import { ClippingPlaneRotationHandle } from './ClippingPlaneRotationHandle';
import type { UpAxis } from './ViewerControls';

/** 剖切面轴向（沿 x / y / z 轴创建） */
export type ClippingAxis = 'x' | 'y' | 'z';

export interface ClippingPlaneOptions {
  /** 剖切面沿轴向在包围盒内的位置比例（0 = min，1 = max），默认 0.5（包围盒中心） */
  positionT?: number; // 兼容保留：初始化时换算为沿法线的偏移量
  /** 法线方向：1 = 沿轴正方向（裁掉正方向一侧），-1 = 沿轴负方向，默认 1 */
  flip?: boolean;
  /** 边框线颜色，默认深灰 0x444444 */
  borderColor?: number;
  /**
   * 世界坐标的上方向轴。
   * - 'Y_UP'：Y 轴向上（three.js 默认习惯），相机 up = (0,1,0)；
   * - 'Z_UP'：Z 轴向上（CAD 常用习惯），相机 up = (0,0,1)；
   * 默认 'Z_UP'。仅构造时生效，不支持运行时切换。
   *
   * axis 参数始终按世界坐标轴解释（剖切 Z = 世界 Z 面），不随 upAxis 换算。
   */
  upAxis?: UpAxis;
}

/**
 * ClippingPlane - 场景剖切面（渲染逻辑独立成类，由 Toolbar 调用）。
 *
 * - 剖切面大小与位置由场景包围盒（ViewerControls.sceneBBox）决定：
 *   面片尺寸取包围盒在垂直于剖切轴的两个方向上的尺寸，
 *   初始位置默认为包围盒沿剖切轴的中点；
 * - 同时持有可视化边框线（挂在本类持有的 Group 上，
 *   需由外部加入场景参与渲染）与对应的 THREE.Plane；
 * - getPlane() 返回的 Plane 可直接放入 renderer.clippingPlanes 或
 *   material.clippingPlanes 使用：法线指向的一侧（distanceToPoint < 0）被裁掉；
 * - 可视化面片沿法线方向做了微小偏移，避免被自己的剖切平面裁掉。
 */
export class ClippingPlane {
  /** 剖切面法线所沿的世界坐标轴（按世界坐标直接解释，不随 upAxis 换算） */
  public readonly axis: ClippingAxis;
  /** 世界坐标上方向轴（构造时确定，不可变更） */
  public readonly upAxis: UpAxis;
  /** 创建时依据的场景包围盒（内部复制保存） */
  public readonly sceneBBox: THREE.Box3;
  /** 可视化对象（含面片与边框），由外部加入场景渲染 */
  public readonly object3d: THREE.Group;

  private normalSign: 1 | -1;
  /** 剖切面沿（旋转后）法线相对包围盒中心的偏移量（世界单位），由 planePoint 派生 */
  private normalOffset: number;
  /**
   * 剖切面中心点（世界坐标）：面片 / 操作柄的中心，也是旋转的枢轴。
   * 持久保存、旋转时保持不动，不再由包围盒中心 + 法线偏移重建，
   * 否则法线旋转时中心点会被迫绕包围盒中心漂移。
   */
  private readonly planePoint = new THREE.Vector3();
  private plane: THREE.Plane;
  private edges: THREE.LineSegments;
  /** 操作柄（白色三维箭头），可视化构造与鼠标交互见 ClippingPlaneHandle */
  public readonly handle: ClippingPlaneHandle;
  /** 旋转手柄（两个圆环），可视化构造与鼠标交互见 ClippingPlaneRotationHandle */
  public readonly rotationHandle: ClippingPlaneRotationHandle;
  /** 面片沿法线方向的微小偏移量（避免被剖切平面裁掉） */
  private readonly epsilon: number;
  /** 用户对剖切面的旋转（四元数，初始为单位旋转） */
  private readonly rotationQuat = new THREE.Quaternion();

  constructor(sceneBBox: THREE.Box3, axis: ClippingAxis, options: ClippingPlaneOptions = {}) {
    this.sceneBBox = sceneBBox.clone();
    // axis 参数按世界坐标轴直接解释（剖切 Z = 世界 Z 面），不随 upAxis 换算
    this.upAxis = options.upAxis ?? 'Z_UP';
    this.axis = axis;
    this.normalSign = options.flip ? -1 : 1;
    // 初始位置：按旧的沿轴位置比例换算为沿（未旋转，即世界轴方向）法线的偏移量
    const t = THREE.MathUtils.clamp(options.positionT ?? 0.5, 0, 1);
    const axisSize = this.sceneBBox.max[this.axis] - this.sceneBBox.min[this.axis];
    this.normalOffset = (t - 0.5) * axisSize;

    const size = this.sceneBBox.getSize(new THREE.Vector3());
    // 面片尺寸：取垂直于剖切轴（世界轴）的两个方向上的包围盒尺寸。
    // 注意 X 轴时面片绕 Y 轴旋转 90°，几何本地 X 对应世界 Z、本地 Y 对应世界 Y，
    // 故宽取 size.z、高取 size.y；Y/Z 轴时本地 XY 恰好对应世界对应方向。
    const [w, h] =
      this.axis === 'x'
        ? [size.z, size.y]
        : this.axis === 'y'
          ? [size.x, size.z]
          : [size.x, size.y];
    this.epsilon = Math.max(size.x, size.y, size.z) * 1e-3;

    // 边框线（深灰色），面片几何基准为 XY 平面，再按剖切轴旋转到垂直于该轴
    const planeGeometry = new THREE.PlaneGeometry(w, h);
    this.edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(planeGeometry),
      new THREE.LineBasicMaterial({ color: options.borderColor ?? 0x444444 }),
    );
    planeGeometry.dispose();

    this.object3d = new THREE.Group();
    this.object3d.add(this.edges);

    // 操作柄：白色三维箭头（圆柱杆 + 圆锥头），朝向由 updateTransform 对齐法线
    this.handle = new ClippingPlaneHandle(Math.max(size.x, size.y, size.z));
    this.object3d.add(this.handle.object3d);

    // 旋转手柄：两个位于剖切面垂面内的圆环，拖拽可绕圆环法线旋转剖切面
    this.rotationHandle = new ClippingPlaneRotationHandle(Math.max(size.x, size.y, size.z));
    this.object3d.add(this.rotationHandle.object3d);

    // 剖切平面：法线沿世界剖切轴，含 flip 方向符号，过当前面片位置
    const normal = new THREE.Vector3();
    normal[this.axis] = 1;
    normal.multiplyScalar(this.normalSign);
    this.plane = new THREE.Plane(normal.clone(), 0);

    // 初始中心点：包围盒中心沿初始法线偏移 normalOffset
    this.planePoint
      .copy(this.sceneBBox.getCenter(new THREE.Vector3()))
      .addScaledVector(normal, this.normalOffset);

    this.updateTransform();
  }

  /** 剖切面沿（旋转后）法线相对包围盒中心的偏移量（世界单位） */
  public getOffsetAlongNormal(): number {
    return this.normalOffset;
  }

  /**
   * 设置剖切面沿（旋转后）法线相对包围盒中心的偏移量（世界单位），
   * 并夹取使剖切面仍与包围盒沿轴向相交。拖拽手柄时剖切面即沿此方向移动。
   */
  public setOffsetAlongNormal(offset: number): void {
    const clamped = this.clampNormalOffset(offset);
    // 沿当前法线平移中心点，使法向投影偏移量等于目标值（保留面内切向分量，不跳变）
    this.planePoint.addScaledVector(this.plane.normal, clamped - this.normalOffset);
    this.updateTransform();
  }

  /** 把法线方向偏移量夹取到剖切面仍穿过包围盒的范围内 */
  private clampNormalOffset(offset: number): number {
    const axisComponent = this.plane.normal[this.axis];
    // 法线在轴上分量过小（剖切面近平行于轴）时，用包围盒半径的一半兜底
    if (Math.abs(axisComponent) < 1e-6) {
      const halfDiagonal = this.sceneBBox.getSize(new THREE.Vector3()).length() / 2;
      return THREE.MathUtils.clamp(offset, -halfDiagonal, halfDiagonal);
    }
    const center = this.sceneBBox.getCenter(new THREE.Vector3())[this.axis];
    const dMin = (this.sceneBBox.min[this.axis] - center) / axisComponent;
    const dMax = (this.sceneBBox.max[this.axis] - center) / axisComponent;
    return THREE.MathUtils.clamp(offset, Math.min(dMin, dMax), Math.max(dMin, dMax));
  }

  /** 当前法线是否沿轴正方向 */
  public isFlipped(): boolean {
    return this.normalSign === -1;
  }

  /** 翻转剖切方向（法线取反，被裁掉的一侧随之翻转） */
  public flip(): void {
    this.normalSign = this.normalSign === 1 ? -1 : 1;
    this.updateTransform();
  }

  /**
   * 绕世界坐标轴 axis 旋转剖切面 angle 弧度（由旋转手柄拖拽调用）。
   * 旋转中心为剖切面自身的中心点 planePoint（旋转过程中保持不动），
   * 仅法线与面片朝向随之改变；同步更新剖切平面、可视化面片与两个操作柄。
   */
  public rotateAroundWorldAxis(axis: THREE.Vector3, angle: number): void {
    if (angle === 0) return;
    const q = new THREE.Quaternion().setFromAxisAngle(axis, angle);
    this.rotationQuat.premultiply(q);
    this.updateTransform();
  }

  /**
   * 每帧更新操作柄的屏幕显示尺寸（固定 100 像素长度），
   * 由渲染循环在渲染前调用。
   */
  public updateHandleScreenSize(camera: THREE.Camera, viewportHeightPx: number): void {
    this.handle.updateScreenSize(camera, viewportHeightPx);
  }

  /**
   * 返回剖切平面（内部实例，位置/方向更新时原地同步）。
   * 可直接放入 renderer.clippingPlanes / material.clippingPlanes 使用。
   */
  public getPlane(): THREE.Plane {
    return this.plane;
  }

  /** 释放可视化资源（geometry/material）。Plane 为纯数据对象无需释放 */
  public dispose(): void {
    this.edges.geometry.dispose();
    (this.edges.material as THREE.Material).dispose();
    this.handle.dispose();
    this.rotationHandle.dispose();
    this.object3d.removeFromParent();
  }

  /** 依据当前中心点与旋转同步可视化面片、剖切平面 constant 与操作柄 */
  private updateTransform(): void {
    // 剖切面法线：世界轴方向 × flip 符号，再应用用户旋转
    const axisNormal = new THREE.Vector3();
    axisNormal[this.axis] = 1;
    this.plane.normal
      .copy(axisNormal)
      .multiplyScalar(this.normalSign)
      .applyQuaternion(this.rotationQuat);

    // 法向偏移量为派生值：中心点相对包围盒中心在当前法线方向上的投影
    this.normalOffset = this.planePoint
      .clone()
      .sub(this.sceneBBox.getCenter(new THREE.Vector3()))
      .dot(this.plane.normal);

    // 边框与面片保持一致（仅边框线）
    const baseQuat = new THREE.Quaternion();
    if (this.axis === 'x') baseQuat.setFromAxisAngle(axisNormal.set(0, 1, 0), Math.PI / 2);
    else if (this.axis === 'y') baseQuat.setFromAxisAngle(axisNormal.set(1, 0, 0), -Math.PI / 2);
    this.edges.quaternion.copy(this.rotationQuat).multiply(baseQuat);

    // 可视化位置：中心点沿法线偏移 epsilon，保证不被自己裁掉
    this.object3d.position.copy(this.planePoint).addScaledVector(this.plane.normal, this.epsilon);

    this.plane.constant = -this.plane.normal.dot(this.planePoint);

    // 操作柄随法线一起更新（flip / 位置 / 旋转变化时）
    this.handle.setDirection(this.plane.normal);
    this.rotationHandle.setFromNormal(this.plane.normal);
  }
}
