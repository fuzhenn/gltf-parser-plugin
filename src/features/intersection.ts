import {
  type BufferGeometry,
  Intersection,
  Mesh,
  Triangle,
  Vector3,
} from "three";
import { featureIdAttributeName } from "./channel";

/**
 * Hit object feature information interface
 */
export interface FeatureInfo {
  oid?: number;
  featureId?: number;
  features?: number[];
  propertyData?: object;
  isValid: boolean;
  error?: string;
}

interface FeatureIdEntry {
  attribute?: number;
  nullFeatureId?: number;
  propertyTable?: number;
}

/**
 * 直接读命中对象自身 geometry 的 feature id 顶点属性（faceIndex 域与当前 index
 * 一致，含高亮压缩 index 与 split 合并 index）。
 */
function readFeatureIds(
  geometry: BufferGeometry,
  faceIndex: number,
  barycoord: Vector3,
  featureIds: FeatureIdEntry[],
): (number | null)[] {
  const base = faceIndex * 3;
  const closestOffset =
    barycoord.x > barycoord.y && barycoord.x > barycoord.z
      ? 0
      : barycoord.y > barycoord.z
        ? 1
        : 2;
  const vertexIndex = geometry.index
    ? geometry.index.getX(base + closestOffset)
    : base + closestOffset;

  return featureIds.map((cfg) => {
    if (cfg.attribute === undefined) return null;
    const attr = geometry.getAttribute(featureIdAttributeName(cfg.attribute));
    if (!attr) return null;
    const value = attr.getX(vertexIndex);
    return value === cfg.nullFeatureId ? null : value;
  });
}

/**
 * General function for extracting OID and feature information from raycaster hit objects
 * @param hit - hit object returned by raycaster.intersectObject
 * @returns FeatureInfo object containing OID and other feature information
 */
export function queryFeatureFromIntersection(hit: Intersection): FeatureInfo {
  const result: FeatureInfo = {
    isValid: false,
  };

  try {
    if (!hit || !hit.object) {
      result.error = "Invalid hit object";
      return result;
    }

    const { object, face, point, faceIndex } = hit;
    const { meshFeatures, structuralMetadata } = object.userData;

    if (!(object instanceof Mesh)) {
      result.error = "Hit object is not a Mesh";
      return result;
    }

    if (!meshFeatures || !structuralMetadata) {
      result.error = "No mesh features or structural metadata found";
      return result;
    }

    const { featureIds } = meshFeatures;
    if (!featureIds || featureIds.length === 0) {
      result.error = "Feature IDs not available";
      return result;
    }

    const barycoord = new Vector3();
    if (face && point) {
      const triangle = new Triangle();
      triangle.setFromAttributeAndIndices(
        object.geometry.attributes.position,
        face.a,
        face.b,
        face.c
      );
      triangle.a.applyMatrix4(object.matrixWorld);
      triangle.b.applyMatrix4(object.matrixWorld);
      triangle.c.applyMatrix4(object.matrixWorld);
      triangle.getBarycoord(point, barycoord);
    } else {
      barycoord.set(0, 0, 0);
    }

    if (faceIndex == null) {
      result.error = "No face index at hit location";
      return result;
    }

    const features = readFeatureIds(
      object.geometry,
      faceIndex,
      barycoord,
      featureIds
    );
    if (features[0] === null) {
      result.error = "No features found at hit location";
      return result;
    }
    result.features = features as number[];

    const featureId = featureIds[0];
    const fid = features[0]!;
    result.featureId = fid;

    const propertyData = structuralMetadata.getPropertyTableData(
      featureId.propertyTable,
      fid
    );

    result.propertyData = propertyData;

    if (propertyData && propertyData._oid !== undefined) {
      result.oid = propertyData._oid;
      result.isValid = true;
    } else {
      result.error = "OID not found in property data";
    }

    return result;
  } catch (error) {
    result.error = `Error extracting OID: ${
      error instanceof Error ? error.message : String(error)
    }`;
    return result;
  }
}
