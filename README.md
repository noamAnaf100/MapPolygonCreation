# Map Polygon Creation

Create map polygons (zones) by clicking on real-world objects instead of drawing them point by point.

- **One click** selects a whole road, building, park or field from OpenStreetMap. Where the map has nothing,
  an AI model (SAM2) outlines what it sees in the aerial photo.
- **Further clicks** cut the polygon where it should end, or make a road longer along the road network.
- **Lasso** a rough outline and the best-matching object is picked.
- Each polygon becomes a **zone**: *ignore motion* or *priority alerts* (2-10× the normal alert rate).
  A road zone can cover the road, the ground beside it (one side or both, any width), or both.
- **Export GeoJSON** writes every zone with its settings, ready for another system to load.

It runs locally: a Node.js server (TypeScript, Fastify) and a browser UI (React, MapLibre GL).

Inspired by [map-magic-wand](https://github.com/oriuziel1/map-magic-wand) (Python + FastAPI); this is an
independent TypeScript implementation.

## Quick start

```bash
git clone https://github.com/noamAnaf100/MapPolygonCreation.git
cd MapPolygonCreation
npm install
npm run dev
```

Then open **http://localhost:5173**. Full details are in [Run locally](#run-locally).

## Interactions

You work on one polygon at a time. The first click (or a lasso) creates a draft polygon, every click after
that edits the draft, and **Done** (`Enter`) adds it to the list. Until then no new polygon can be started.

| Tool | Action | Result |
|---|---|---|
| **Wand** (`W`) | 1st click on an object | Starts a draft with **the whole object**: the OSM building footprint or land area, or the whole road followed through junctions within the view. A divided road (two one-way carriageways with a median) is selected as **one road, both directions**: both carriageways and the median between them. Where the map has nothing, SAM2 outlines what is in the imagery. |
| | Later clicks **inside** the draft | **Cut** it at that point, as many times as needed. Roads are cut straight across at the click (within a few pixels of the edge also counts); other shapes perpendicular to the line from the first click. The side of the first click is kept, so a cut on each side keeps the segment between. |
| | Click **outside** a road draft, on a road | **Extends** it: routes from the selected part to the click along the road network (preferring the same road class) and adds that stretch. Refused when the road does not connect or the route is a detour (over 2.5× the straight distance, or over 3 km). Zoom out to reach past the original view. |
| | Click **outside** any other draft | Ignored, with a hint to cut inside or press Done. |
| **Lasso** (`L`) | Drag around an object | Starts a draft with the best fit among every OSM object the lasso touches, the roads crossing it, the group of buildings inside it, and SAM2's masks for the lasso box (intersection over union with your outline). |
| Panel (roads) | **Road** / **Road + side** / **Side only** | What a road zone covers: the road itself, the road and the ground beside it, or only the ground beside it. Sides are named by compass (**North**/**South** for a road running east-west, **West**/**East** for one running north-south) or **Both**, with a **width off the road** in metres (1-200). The sides follow cuts and extensions; the road you are editing stays outlined dashed, and clicks on a side strip cut it too. New road polygons start with the last setting you picked. |
| | **Ignore motion** / **Priority alerts** | Sets what the zone is for. A priority zone also has an **alert rate** (2×, 3×, 5× or 10× the normal rate). New polygons start with the last setting you picked. |
| | **Done** / **Discard** | Adds the draft to the list, or drops it. |
| | Click a polygon in the list | Reopens it as a draft; **Save** keeps the edits, **Cancel** leaves it as it was. |

Keys: `Enter` done, `Esc` discard, `Tab` / `Shift+Tab` cycle alternatives (other SAM2 mask sizes or other
lasso candidates), `Ctrl+Z` undoes the last cut or extension, `Del` deletes the draft.

Saved zones are drawn grey (ignore) or red (priority alerts). **Export GeoJSON** downloads every polygon in
the list with `zone_mode` (`ignore` or `alert`), `alert_rate` (priority zones only), for roads `covers` (e.g.
`["road", "east"]`), `side_m` and `divided` (both directions), and its source, label,
area, OSM tags and score.

The source dropdown forces **map data only** (OSM) or **AI on imagery only** (SAM2). The base map switches
between the Esri orthophoto and the OSM street map. SAM2 runs on whichever is shown.

## Run locally

### Requirements

- **Node.js 22.15 or newer** (tested on 24), which includes npm. Check with `node --version`.
- **Git**, to clone the repository.
- **Internet access** on the first run, for map tiles and the one-time AI model download (~180 MB).
  Areas you have visited are cached and work offline afterwards.
- Windows, macOS or Linux. No GPU is needed.

### Steps

1. Clone the repository and go into it:

   ```bash
   git clone https://github.com/noamAnaf100/MapPolygonCreation.git
   cd MapPolygonCreation
   ```

2. Install the dependencies for all three packages (`server`, `web`, `shared`) in one go:

   ```bash
   npm install
   ```

3. Start the server and the UI together:

   ```bash
   npm run dev
   ```

   This runs two processes in one terminal, labelled `server` and `web`:

   | Process | Address | What it is |
   |---|---|---|
   | `server` | http://127.0.0.1:8787 | API: map data, AI segmentation, polygon geometry. Restarts when a server file changes. |
   | `web` | http://localhost:5173 | The UI (Vite dev server). It forwards `/api` requests to the server. |

4. Open **http://localhost:5173** in a browser.

5. Wait for the badge at the top of the panel. It shows **SAM2 loading…** while the AI model downloads
   into `server/cache/models` on the first run, then **SAM2 ready**. Clicking roads and buildings works
   straight away; only clicks on places with no map data need the model.

Press `Ctrl+C` in the terminal to stop both processes.

### Other commands

```bash
npm run dev:server   # only the API, on port 8787
npm run dev:web      # only the UI, on port 5173 (needs the API running)
npm test             # server unit tests (vitest)
npm run typecheck    # type-check server and web
```

### Troubleshooting

- **`Port 8787` or `5173` is already in use**: stop the other program, or change `port` in
  `server/config.json` together with the `proxy` target in `web/vite.config.ts`, or `server.port` there for the UI.
- **The badge says "SAM2 off"**: the model download failed (often a blocked network). Hover over the badge
  for the error. Map-data selection still works. To turn the AI off completely, set `"sam": { "enabled": false }`
  in `server/config.json`.
- **Behind a company proxy that inspects HTTPS**: the server starts Node with `--use-system-ca`, so
  certificates trusted by the operating system are accepted. That is why Node 22.15 or newer is needed.
- **`node: bad option: --use-system-ca`**: Node is too old; install a current LTS release.
- **Start fresh**: delete `server/cache/` to clear the cached tiles and model; they are downloaded again.

## How it works

```
click ─► OSM vector tiles (OpenFreeMap) under the click?
         ├─ building / small area ........ OSM footprint
         ├─ road .......................... follow the straightest same-class continuation through
         │                                  junctions, buffer by the road width, clip to the view
         │    one-way? opposite one-way of the same class 3-45 m away, alongside, no building
         │    between ─► divided road: centerline = midline, width = gap + carriageway width
         └─ nothing ─► SAM2 point prompt on the imagery ─► mask ─► polygon

2nd click inside ─► remove a half-disc on the far side of the cut line
                    (roads: perpendicular to the centerline, radius from the road width)
                    ─► keep the piece connected to the first click

click outside a road ─► road graph from OSM lines (shared vertices + T-junction snapping)
                    ─► shortest path from the selected centerline to the click
                    ─► buffer by the road width and merge into the selection
                    (divided roads: route turned into the midline between the carriageways)

road sides ─► centerline clipped to the selected road, pieces turned one way and joined end to end
           ─► buffer(width/2 + side) minus buffer(width/2), ends cut square, keep the chosen side(s)
           ─► merged with the road, or with the road removed for "side only"

lasso ─► candidates: OSM areas + crossing roads + building group + SAM2 (box + interior point)
         ─► keep those at least half inside the lasso ─► rank by IoU with the lasso
```

- SAM2 runs in Node via [transformers.js](https://huggingface.co/docs/transformers.js) and ONNX Runtime on the CPU.
  Image embeddings are cached per 1024 px window. The first click in an area takes about 3 s, later ones
  under 1 s.
- Map tiles, vector tiles and the model are cached on disk under `server/cache/`, so areas you have already
  visited work offline.

## Configuration

`server/config.json` (or set `MAP_WAND_CONFIG` to another file):

| Key | Meaning |
|---|---|
| `map.center`, `map.zoom` | Start view (Tel Aviv) |
| `layers.*.url` | Base map XYZ templates. Point at your own tiles for offline use. |
| `osm.vectorTilesUrl` | OpenMapTiles-schema TileJSON or `{z}/{x}/{y}.pbf` template (e.g. a local tileserver-gl) |
| `osm.buildingSearchM`, `osm.roadHitM`, `osm.smallAreaM2` | Hit-test tolerances; areas above `smallAreaM2` are only picked in *map data only* mode |
| `sam.model`, `sam.dtype` | Any SAM2 ONNX model on Hugging Face (e.g. `onnx-community/sam2.1-hiera-tiny-ONNX`, `-base-plus-ONNX`) and precision (`fp32`, `fp16`, `q8`, …) |
| `sam.enabled` | `false` runs map data only |
| `wand.mosaicPx`, `wand.simplifyPx` | Imagery window size fed to SAM2, polygon simplification |

## Layout

```
shared/types.ts       request/response types used by both sides
server/src/
  main.ts             Fastify: /api/config, /api/health, /api/tiles/:layer/:z/:x/:y, /api/select, /api/lasso, /api/cut, /api/extend, /api/cover
  wand.ts             click and lasso strategies, lasso ranking
  cut.ts              cut-at-point geometry
  extend.ts           extend a road along the road network to a click
  twin.ts             find the opposite carriageway of a divided road and the midline between them
  cover.ts            road and side strips for a road zone
  osm.ts              vector tile decoding, hit testing, road stroke following
  sam.ts              SAM2 engine with embedding cache
  mask.ts             mask → polygons (d3-contour)
  tiles.ts            tile proxy + disk cache, imagery mosaics (sharp)
  geo.ts              Web Mercator and local metric helpers
server/test/          vitest unit tests
web/src/App.tsx       map interactions and panel
web/src/mapStyle.ts   MapLibre style and overlay layers
```

## Known limitations

- Road selection is bounded by the current view; click further along the road to extend it.
- OpenFreeMap vector tiles have no road names, so a road is followed by direction and class, not by name.
  Divided roads are joined only where OSM maps both directions as one-way lines of the same class; where
  the median is wider than 45 m the two directions stay separate roads.
- The orthophoto and OSM can be misaligned by a few metres; SAM2 follows the pixels, OSM follows the map.
- SAM2 on CPU is the slow step; a GPU build of ONNX Runtime or the `tiny` model makes it faster.

## License

The code in this repository is released under the [MIT License](LICENSE).

The app downloads data and a model at run time that are **not** part of this repository and have their own terms:

| What | Source | Terms |
|---|---|---|
| Map data (roads, buildings, areas) | [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, via [OpenFreeMap](https://openfreemap.org/) vector tiles in the [OpenMapTiles](https://openmaptiles.org/) schema | ODbL 1.0. Polygons exported from OSM data are a derived database and keep that licence and the "© OpenStreetMap contributors" credit. |
| Street base map | [OpenStreetMap tile server](https://tile.openstreetmap.org/) | [Tile usage policy](https://operations.osmfoundation.org/policies/tiles/): light, interactive use only. |
| Aerial imagery | [Esri World Imagery](https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9) | Esri terms of use; the attribution shown on the map must stay visible. |
| AI segmentation model | [SAM 2.1](https://github.com/facebookresearch/sam2) by Meta, ONNX export by [onnx-community](https://huggingface.co/onnx-community/sam2.1-hiera-small-ONNX) | Apache 2.0 |

For heavier or offline use, point `layers.*.url` and `osm.vectorTilesUrl` in `server/config.json` at your own
tile servers.
