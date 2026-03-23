export { buildTextures, type TextureBuildResult } from "./build-textures";
export { buildMaterials } from "./build-materials";
export {
  buildMeshPrimitives,
  type PrimitiveData,
} from "./build-mesh-primitives";
export {
  acquireWorker,
  setMaxWorkers,
  getWorkers,
  clearSchemaCache,
} from "./worker-pool";
export {
  pointInPolygon,
  segmentsIntersect,
  polygonIntersectsRect,
  selectByBoxFromOidMap,
  selectByPolygonFromOidMap,
} from "./spatial-query";
export { toColor, type ColorInput } from "./color-input";
