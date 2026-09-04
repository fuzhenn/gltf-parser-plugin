export { GLTFParserPlugin } from "./GLTFParserPlugin";
export { GLTFParserPlugin as Plugin } from "./Plugin";
export * from "./PMI";
export type {
  GLTFParserPluginOptions,
  StructureNode,
  StructureData,
  ModelInfo,
} from "./plugin-types";
export {
  MeshCollector,
  MESH_CACHE_NAMESPACE_HIGHLIGHT,
  MESH_CACHE_NAMESPACE_STYLE,
  MeshSplitResolver,
  disposeTileMeshSplitGeometryCache,
  meshCollectorQueryCacheKey,
  normalizeMeshCollectorFeatureIds,
  resolveMeshCollectorQuery,
} from "./MeshCollector-deleted";
export type {
  MeshChangeEvent,
  MeshCollectorEventMap,
  MeshCollectorQuery,
  ResolvedMeshCollectorQuery,
} from "./MeshCollector-deleted";
export type { StyleConditionEvaluator } from "./appearance";
export type { FeatureInfo } from "./mesh-helper/intersection";
export {
  getPrecomputedEdges,
  registerPrecomputedEdges,
  type PrecomputedEdgeData,
} from "./mesh-helper/edge-geometry";
export {
  DEFAULT_FEATURE_EDGE_THRESHOLD_DEG,
  buildFeatureEdgePositions,
} from "./worker/edges";
export type { ColorInput } from "./utils/color-input";
export type {
  StyleAppearance,
  StyleCondition,
  StyleConditionDescriptor,
  StyleConditionInput,
  StyleConfig,
  StyleEulerInput,
  StyleMaterialMaps,
  StyleMaterialResolver,
  StyleMeshFactory,
  StyleShowInput,
  StyleVec3Input,
} from "./plugin/style-appearance-types";
export { extractStyleMaterialMaps } from "./plugin/style-appearance-shared";
export type {
  HighlightAppearance,
  HighlightByPidsOptions,
  HighlightCondition,
  HighlightMaterial,
  HighlightOptions,
  ResolvedHighlightOptions,
} from "./plugin/PartHighlightHelper";
export { PartVisibilityHelper } from "./plugin/part-visibility-helper";
export {
  decodeGzipBase64DataUriSync,
  getStructureDataUriFromTileset,
  parseEmbeddedStructureDataFromTilesSync,
} from "./utils/tileset-structure-uri";
export type { TilesetWithStructureUri } from "./utils/tileset-structure-uri";
