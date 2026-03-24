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
  bboxArrayToBox3,
  pointInPolygon,
  segmentsIntersect,
  polygonIntersectsRect,
  selectByBoxFromOidMap,
  selectByPolygonFromOidMap,
} from "./spatial-query";
export { toColor, type ColorInput } from "./color-input";
export {
  decodeGzipBase64DataUriSync,
  getStructureDataUriFromTileset,
  parseEmbeddedStructureDataFromTilesSync,
  type TilesetWithStructureUri,
} from "./tileset-structure-uri";
