import { TilesRenderer } from "3d-tiles-renderer";
import type { GLTFParserPluginOptions } from "./plugin-types";
import { defaultMaterialBuilder } from "./utils/build-materials";
import { GLTFWorkerLoader } from "./loader";
import { resolveFetchOptions } from "./utils/apply-fetch-options";
import { setMaxWorkers } from "./utils";
import { tileCache } from "./db";
import { Object3D } from "three";
import { StyleConfig } from "./plugin/style-appearance-types";
import { buildOidToFeatureIdMap } from "./mesh-helper";
import { StyleHelper } from "./style-helper";

const GLTF_REGEX = /\.(gltf|glb)$/g;

export class GLTFParserPlugin {
  name = "GLTFParserPlugin";

  private _options: GLTFParserPluginOptions;
  private _tiles: (TilesRenderer & Record<string, any>) | null = null;
  private _styleHelper: StyleHelper | null = null;

  /**
   * Create a GLTFParserPlugin instance
   * @param options configuration options
   */
  constructor(options: GLTFParserPluginOptions) {
    this._options = options;

    // --- Worker pool setup ---
    setMaxWorkers(this._options.maxWorkers);
  }

  /**
   * Plugin initialization, called by TilesRenderer
   */
  init(tiles: TilesRenderer) {
    this._tiles = tiles;

    // --- GLTF loader setup ---
    const tilesFetchOptions = tiles.fetchOptions;
    const fetchOptions = resolveFetchOptions(
      tilesFetchOptions,
      this._options.fetchOptions,
    );
    const materialBuilder =
      this._options.materialBuilder ?? defaultMaterialBuilder;
    const loader = new GLTFWorkerLoader(tiles.manager, {
      metadata: this._options.metadata,
      materialBuilder: materialBuilder,
      fetchOptions,
    });
    tiles.manager.addHandler(GLTF_REGEX, loader);

    tiles.addEventListener("load-model", this._onLoadModelCB);
    tiles.addEventListener("dispose-model", this._onDisposeModelCB);
    tiles.addEventListener("update-after", this._onUpdateAfterCB);
  }

  /**
   * Fetch tile data with IndexedDB caching support
   */
  async fetchData(
    url: string,
    options?: RequestInit,
  ): Promise<Response | ArrayBuffer | object> {
    const isJson = url.toLowerCase().endsWith(".json");
    if (!this._options.useIndexedDB || isJson) {
      return this._tiles!.fetchData(url, options);
    }

    try {
      const cachedData = await tileCache.get(url);

      if (cachedData) {
        return cachedData;
      }

      const response = await this._tiles!.fetchData(url, options);

      if (!response.ok) {
        return response;
      }

      const arrayBuffer = await response.arrayBuffer();

      tileCache.set(url, arrayBuffer).catch((err: unknown) => {
        console.warn("[GLTFParserPlugin] Failed to cache data:", err);
      });

      return arrayBuffer;
    } catch (error) {
      return this._tiles!.fetchData(url, options);
    }
  }

  /**
   * Clear all cached tile data from IndexedDB
   */
  async clearCache(): Promise<void> {
    await tileCache.clear();
    console.info("[GLTFParserPlugin] Cache cleared");
  }

  /**
   * Parse tile data
   */
  async parseTile(
    buffer: ArrayBuffer,
    tile: any,
    extension: any,
    uri: string,
    abortSignal: AbortSignal,
  ) {
    if (this._options.beforeParseTile) {
      buffer = await this._options.beforeParseTile(
        buffer,
        tile,
        extension,
        uri,
        abortSignal,
      );
    }
    return this._tiles!.parseTile(buffer, tile, extension, uri, abortSignal);
  }

  /**
   * Load model callback
   */
  private _onLoadModelCB = ({ scene }: { scene: Object3D }) => {
    buildOidToFeatureIdMap(scene);
    // 新瓦片首处理：幂等应用当前样式并盖章当前代数
    this._styleHelper?.applySceneIfStale(scene);
  };

  private _onDisposeModelCB = ({ scene }: { scene: Object3D }) => {
    this._styleHelper?.disposeTileScene(scene);
  };

  /**
   * 只补处理"可见且样式代数落后"的瓦片；
   * 不可见的过期瓦片留到变可见时再处理。
   */
  private _onUpdateAfterCB = () => {
    const styleHelper = this._styleHelper;
    const visibleTiles = this._tiles?.visibleTiles as
      | Set<{ cached?: { scene?: Object3D } }>
      | undefined;
    if (!styleHelper || !visibleTiles) return;

    for (const tile of visibleTiles) {
      const scene = tile?.cached?.scene;
      if (scene) styleHelper.applySceneIfStale(scene);
    }
  };

  /**
   * 设置构件样式
   * @param style 样式配置，传 null 清除样式
   */
  setStyle(style: StyleConfig | null): void {
    if (!this._tiles) return;
    if (!this._styleHelper) {
      if (!style) return;
      this._styleHelper = new StyleHelper(
        this._options.materialBuilder ?? defaultMaterialBuilder,
      );
    }

    const scenes: Object3D[] = [];
    this._tiles.forEachLoadedModel((scene: Object3D) => {
      scenes.push(scene);
    });

    // 被移除的条件必须立即从所有瓦片摘除（split 卸载），全量处理不能延后
    this._styleHelper.setStyle(style, scenes);

    // 新增/变更的样式只立即应用到当前可见瓦片；不可见瓦片由 update-after 按需补齐
    const visibleTiles = this._tiles.visibleTiles as
      | Set<{ cached?: { scene?: Object3D } }>
      | undefined;
    if (!visibleTiles) return;
    for (const tile of visibleTiles) {
      const scene = tile?.cached?.scene;
      if (scene) this._styleHelper.applySceneIfStale(scene);
    }
  }

  /**
   * 当前样式配置。赋值与 `setStyle(...)` 等价，例如 `plugin.style = { conditions }`。
   */
  get style(): StyleConfig | null {
    return this._styleHelper?.style ?? null;
  }

  set style(style: StyleConfig | null) {
    this.setStyle(style);
  }

  /**
   * 清除构件样式
   */
  clearStyle(): void {
    this.setStyle(null);
  }

  /**
   * Plugin disposal
   */
  dispose() {
    if (this._tiles) {
      this._tiles.manager.removeHandler(GLTF_REGEX);
      this._tiles.removeEventListener("load-model", this._onLoadModelCB);
      this._tiles.removeEventListener("dispose-model", this._onDisposeModelCB);
      this._tiles.removeEventListener("update-after", this._onUpdateAfterCB);
    }
  }
}
