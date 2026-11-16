import Fastify from "fastify";
import type { AppConfig, CoverRequest, CoverResult, CutRequest, EditResult, ExtendRequest, Health, LassoRequest, LayerId, SelectRequest } from "@map-wand/shared";
import { CONFIG } from "./config.ts";
import { coverRoad } from "./cover.ts";
import { cutAt } from "./cut.ts";
import { SAM } from "./sam.ts";
import { getTile } from "./tiles.ts";
import { extend, lasso, select } from "./wand.ts";

const PNG_SIGNATURE = 0x89504e47;
const TILE_CACHE_SECONDS = 86_400;
const DEFAULT_SIDE_NAMES: [string, string] = ["Left", "Right"];

const app = Fastify({ logger: { level: "warn" }, bodyLimit: 10 * 1024 * 1024 });

app.get("/api/config", async (): Promise<AppConfig> => ({
  center: CONFIG.map.center,
  zoom: CONFIG.map.zoom,
  layers: Object.fromEntries(
    Object.entries(CONFIG.layers).map(([id, layer]) => [
      id,
      { name: layer.name, max_zoom: layer.max_zoom, attribution: layer.attribution, tiles: `/api/tiles/${id}/{z}/{x}/{y}` },
    ]),
  ) as AppConfig["layers"],
}));

app.get("/api/health", async (): Promise<Health> => ({
  sam_ready: SAM.ready,
  sam_loading: SAM.loading,
  sam_error: SAM.error,
  model: CONFIG.sam.model,
}));

app.get<{ Params: { layer: string; z: string; x: string; y: string } }>("/api/tiles/:layer/:z/:x/:y", async (req, reply) => {
  const { layer, z, x, y } = req.params;
  if (!(layer in CONFIG.layers)) return reply.code(404).send({ error: "unknown layer" });
  try {
    const data = await getTile(layer as LayerId, Number(z), Number(x), Number(y));
    const type = data.readUInt32BE(0) === PNG_SIGNATURE ? "image/png" : "image/jpeg";
    return reply.type(type).header("Cache-Control", `public, max-age=${TILE_CACHE_SECONDS}`).send(data);
  } catch (ex) {
    return reply.code(502).send({ error: `tile fetch failed: ${(ex as Error).message}` });
  }
});

app.post<{ Body: SelectRequest }>("/api/select", (req) => select(req.body));

app.post<{ Body: LassoRequest }>("/api/lasso", (req) => lasso(req.body));

app.post<{ Body: ExtendRequest }>("/api/extend", (req) => extend(req.body));

app.post<{ Body: CoverRequest }>("/api/cover", async (req): Promise<CoverResult> => {
  const outcome = coverRoad(req.body.feature, req.body.cover);
  return "error" in outcome
    ? { feature: null, side_names: DEFAULT_SIDE_NAMES, messages: [outcome.error] }
    : { feature: outcome.feature, side_names: outcome.sideNames, messages: [] };
});

app.post<{ Body: CutRequest }>("/api/cut", async (req): Promise<EditResult> => {
  const { feature, anchor, point } = req.body;
  const cut = cutAt(feature, anchor, point);
  return { feature: cut, messages: cut ? [] : ["Could not cut here - click away from the first click."] };
});

void SAM.load();
await app.listen({ port: CONFIG.port, host: "127.0.0.1" });
