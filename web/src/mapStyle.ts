import type { GeoJSONSource, LayerSpecification, Map as MapLibreMap, StyleSpecification } from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import type { AppConfig, LayerId } from "@map-wand/shared";

export const ZONE_COLORS = { ignore: "#94a3b8", alert: "#ef4444" } as const;
export const ACTIVE_COLOR = "#facc15";

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

export function baseStyle(config: AppConfig): StyleSpecification {
  const sources: StyleSpecification["sources"] = {};
  const layers: LayerSpecification[] = [];
  for (const [id, layer] of Object.entries(config.layers)) {
    sources[id] = {
      type: "raster",
      tiles: [`${location.origin}${layer.tiles}`],
      tileSize: 256,
      maxzoom: layer.max_zoom,
      attribution: layer.attribution,
    };
    layers.push({ id, type: "raster", source: id, layout: { visibility: id === "ortho" ? "visible" : "none" } });
  }
  return { version: 8, sources, layers };
}

const zoneColor = ["match", ["get", "zone_mode"], "alert", ZONE_COLORS.alert, ZONE_COLORS.ignore] as unknown as string;
const zoneOpacity = ["match", ["get", "zone_mode"], "alert", 0.35, 0.2] as unknown as number;

export function addOverlay(map: MapLibreMap): void {
  for (const id of ["selections", "base", "active", "anchor", "lasso"]) map.addSource(id, { type: "geojson", data: EMPTY });
  map.addLayer({ id: "selections-fill", type: "fill", source: "selections", paint: { "fill-color": zoneColor, "fill-opacity": zoneOpacity } });
  map.addLayer({ id: "selections-line", type: "line", source: "selections", paint: { "line-color": zoneColor, "line-width": 2 } });
  map.addLayer({
    id: "base-line",
    type: "line",
    source: "base",
    paint: { "line-color": ACTIVE_COLOR, "line-width": 1.5, "line-dasharray": [2, 2] },
  });
  map.addLayer({ id: "active-fill", type: "fill", source: "active", paint: { "fill-color": ACTIVE_COLOR, "fill-opacity": 0.25 } });
  map.addLayer({ id: "active-line", type: "line", source: "active", paint: { "line-color": ACTIVE_COLOR, "line-width": 3 } });
  map.addLayer({
    id: "anchor",
    type: "circle",
    source: "anchor",
    paint: { "circle-radius": 5, "circle-color": ACTIVE_COLOR, "circle-stroke-color": "#111827", "circle-stroke-width": 2 },
  });
  map.addLayer({ id: "lasso-fill", type: "fill", source: "lasso", paint: { "fill-color": "#ffffff", "fill-opacity": 0.12 } });
  map.addLayer({
    id: "lasso-line",
    type: "line",
    source: "lasso",
    paint: { "line-color": "#ffffff", "line-width": 2, "line-dasharray": [2, 1.5] },
  });
}

export function setData(map: MapLibreMap, source: string, data: FeatureCollection): void {
  (map.getSource(source) as GeoJSONSource | undefined)?.setData(data);
}

export function showLayer(map: MapLibreMap, config: AppConfig, layer: LayerId): void {
  for (const id of Object.keys(config.layers)) map.setLayoutProperty(id, "visibility", id === layer ? "visible" : "none");
}
