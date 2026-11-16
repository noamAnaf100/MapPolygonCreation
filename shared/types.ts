import type { Feature, LineString, MultiLineString, MultiPolygon, Polygon, Position } from "geojson";

export type LayerId = "ortho" | "street";
export type Strategy = "auto" | "osm" | "sam";
export type Source = "osm" | "sam2" | "osm-group";
export type ObjectKind = "building" | "road" | "area" | "object";
export type ZoneMode = "ignore" | "alert";

export interface ZoneSettings {
  mode: ZoneMode;
  alert_rate: number;
}

export type RoadSides = "none" | "left" | "right" | "both";

export interface RoadCover {
  road: boolean;
  sides: RoadSides;
  side_m: number;
}

export interface WandProps {
  source: Source;
  kind: ObjectKind;
  label: string;
  area_m2: number;
  score?: number;
  fit?: number;
  osm_tags?: Record<string, string | number | boolean>;
  centerline?: LineString | MultiLineString;
  width_m?: number;
  cuts?: number;
  extensions?: number;
  zone_mode?: ZoneMode;
  alert_rate?: number;
  covers?: string[];
  side_m?: number;
}

export type WandFeature = Feature<Polygon | MultiPolygon, WandProps>;

export type BBox = [west: number, south: number, east: number, north: number];

export interface MapContext {
  layer: LayerId;
  zoom: number;
  view_bbox: BBox;
  strategy: Strategy;
}

export interface SelectRequest extends MapContext {
  point: Position;
}

export interface LassoRequest extends MapContext {
  lasso: Polygon;
}

export interface CutRequest {
  feature: WandFeature;
  anchor: Position;
  point: Position;
}

export interface WandResult {
  anchor: Position | null;
  alternatives: WandFeature[];
  selected: number;
  messages: string[];
  ms: number;
}

export interface ExtendRequest {
  feature: WandFeature;
  point: Position;
}

export interface EditResult {
  feature: WandFeature | null;
  messages: string[];
}

export interface CoverRequest {
  feature: WandFeature;
  cover: RoadCover;
}

export interface CoverResult {
  feature: WandFeature | null;
  side_names: [string, string];
  messages: string[];
}

export interface LayerInfo {
  name: string;
  max_zoom: number;
  attribution: string;
  tiles: string;
}

export interface AppConfig {
  center: [number, number];
  zoom: number;
  layers: Record<LayerId, LayerInfo>;
}

export interface Health {
  sam_ready: boolean;
  sam_loading: boolean;
  sam_error: string | null;
  model: string;
}
