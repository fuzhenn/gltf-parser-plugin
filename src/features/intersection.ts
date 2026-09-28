import { Intersection, Mesh, Triangle, Vector3 } from "three";

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

    const features = meshFeatures.getFeatures(faceIndex, barycoord);
    if (!features || features.length === 0) {
      result.error = "No features found at hit location";
      return result;
    }

    result.features = features;

    const { featureIds } = meshFeatures;
    if (!featureIds || featureIds.length === 0) {
      result.error = "Feature IDs not available";
      return result;
    }

    const featureId = featureIds[0];
    const fid = features[0];
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
