// export { GLTFParserPlugin } from "./GLTFParserPlugin";
export { GLTFParserPlugin } from "./Plugin";
export * from "./pmi";
export type {
  GLTFParserPluginOptions,
  StructureNode,
  StructureData,
  ModelInfo,
} from "./types";
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
export type { PrecomputedEdgeData } from "./types";
export {
  DEFAULT_FEATURE_EDGE_THRESHOLD_DEG,
  buildFeatureEdgePositions,
} from "./worker/edges";
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
export type { TilesetWithStructureUri } from "./utils/tileset-structure";
