import { Object3D } from "three";

const FEATURE_INDEX = 0;

/**
 * Build mapping relationship from OID to FeatureId
 * @param scene Scene object
 */
function buildOidToFeatureIdMap(scene: Object3D): void {
  scene.traverse((meshObject: Object3D) => {
    const { meshFeatures, structuralMetadata } = meshObject.userData;

    if (meshFeatures && structuralMetadata) {
      const { geometry, featureIds } = meshFeatures;
      const featureIdConfig = featureIds[FEATURE_INDEX];
      const featureAttribute = geometry.getAttribute(
        `_feature_id_${featureIdConfig.attribute}`
      );

      const processedFeatureIds = new Set<number>();
      const oidToFeatureIdMap: Record<number, number> = {};

      for (
        let vertexIndex = 0;
        vertexIndex < featureAttribute.count;
        vertexIndex++
      ) {
        const currentFeatureId = featureAttribute.getX(vertexIndex);

        if (processedFeatureIds.has(currentFeatureId)) {
          continue;
        }

        const featureData = structuralMetadata.getPropertyTableData(
          featureIdConfig.propertyTable,
          currentFeatureId
        );

        oidToFeatureIdMap[featureData._oid] = currentFeatureId;
        processedFeatureIds.add(currentFeatureId);
      }

      processedFeatureIds.clear();
      meshObject.userData.idMap = oidToFeatureIdMap;
    }
  });
}

export { buildOidToFeatureIdMap };
