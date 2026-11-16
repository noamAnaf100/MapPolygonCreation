import { useEffect, useRef, useState } from "react";
import { Map as MapLibreMap, NavigationControl, type MapMouseEvent } from "maplibre-gl";
import type { FeatureCollection, Position } from "geojson";
import type { AppConfig, EditResult, Health, LayerId, MapContext, RoadCover, RoadSides, Strategy, WandFeature, WandResult, ZoneSettings } from "@map-wand/shared";
import { api } from "./api.ts";
import { containsPoint, edgeDistancePx, formatArea } from "./geo.ts";
import { ACTIVE_COLOR, ZONE_COLORS, addOverlay, baseStyle, setData, showLayer } from "./mapStyle.ts";

type Tool = "wand" | "lasso";

interface Selection {
  id: number;
  anchor: Position;
  alternatives: WandFeature[];
  selected: number;
  undo: WandFeature[];
  zone: ZoneSettings;
  cover: RoadCover;
  covered: Covered | null;
}

interface Covered {
  base: WandFeature;
  cover: RoadCover;
  feature: WandFeature | null;
  sideNames: [string, string];
}

const ALERT_RATES = [2, 3, 5, 10];
const DEFAULT_ZONE: ZoneSettings = { mode: "ignore", alert_rate: ALERT_RATES[0] };
const DEFAULT_COVER: RoadCover = { road: true, sides: "none", side_m: 10 };
const DEFAULT_SIDE_NAMES: [string, string] = ["Left", "Right"];

const HEALTH_POLL_MS = 2000;
const LASSO_MIN_STEP_PX = 4;
const MIN_LASSO_POINTS = 3;

const FINISH_FIRST = "Finish the current polygon first: Done (Enter) or Discard (Esc).";
const CUT_INSIDE = "Click inside the polygon to cut it, or press Done (Enter) to add it.";
const CUT_TOLERANCE_PX = 6;

const current = (s: Selection) => s.alternatives[s.selected];
const isRoad = (feature: WandFeature) => feature.properties.centerline !== undefined;
const zoneText = (zone: ZoneSettings) => (zone.mode === "ignore" ? "ignore" : `alert ×${zone.alert_rate}`);
const isCovered = (s: Selection) => !isRoad(current(s)) || (s.covered?.base === current(s) && s.covered.cover === s.cover);
const shown = (s: Selection) => (s.covered?.base === current(s) && s.covered.feature) || current(s);

function coverText(feature: WandFeature): string {
  const { covers, side_m } = feature.properties;
  if (!covers || side_m === undefined) return "";
  return `${covers.join(" + ")} ${side_m} m`;
}

function withZone(s: Selection): WandFeature {
  const feature = shown(s);
  const zone = s.zone.mode === "alert" ? { zone_mode: s.zone.mode, alert_rate: s.zone.alert_rate } : { zone_mode: s.zone.mode };
  return { ...feature, properties: { ...feature.properties, ...zone } };
}
const collection = (features: WandFeature[]): FeatureCollection => ({ type: "FeatureCollection", features });
let nextId = 1;

export function App() {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [tool, setTool] = useState<Tool>("wand");
  const [strategy, setStrategy] = useState<Strategy>("auto");
  const [layer, setLayer] = useState<LayerId>("ortho");
  const [selections, setSelections] = useState<Selection[]>([]);
  const [draft, setDraft] = useState<Selection | null>(null);
  const [lastZone, setLastZone] = useState<ZoneSettings>(DEFAULT_ZONE);
  const [lastCover, setLastCover] = useState<RoadCover>(DEFAULT_COVER);
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<string[]>([]);

  useEffect(() => {
    api.config().then(setConfig).catch((ex) => setMessages([`Server unreachable: ${ex.message}`]));
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const poll = () =>
      api
        .health()
        .then((h) => {
          setHealth(h);
          if (!h.sam_ready && !h.sam_error) timer = setTimeout(poll, HEALTH_POLL_MS);
        })
        .catch(() => (timer = setTimeout(poll, HEALTH_POLL_MS)));
    poll();
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!config || !container.current) return;
    const map = new MapLibreMap({
      container: container.current,
      style: baseStyle(config),
      center: config.center,
      zoom: config.zoom,
      doubleClickZoom: false,
    });
    map.addControl(new NavigationControl(), "bottom-right");
    map.on("load", () => {
      addOverlay(map);
      setMapReady(true);
    });
    mapRef.current = map;
    return () => map.remove();
  }, [config]);

  useEffect(() => {
    if (mapReady && config) showLayer(mapRef.current!, config, layer);
  }, [mapReady, config, layer]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    setData(map, "selections", collection(selections.filter((s) => s.id !== draft?.id).map(withZone)));
    setData(map, "active", collection(draft ? [shown(draft)] : []));
    setData(map, "base", collection(draft && shown(draft) !== current(draft) ? [current(draft)] : []));
    setData(map, "anchor", {
      type: "FeatureCollection",
      features: draft ? [{ type: "Feature", geometry: { type: "Point", coordinates: draft.anchor }, properties: {} }] : [],
    });
  }, [mapReady, selections, draft]);

  const draftBase = draft ? current(draft) : null;
  const draftCover = draft?.cover;
  useEffect(() => {
    if (!draftBase || !draftCover || !isRoad(draftBase)) return;
    let stale = false;
    api
      .cover({ feature: draftBase, cover: draftCover })
      .then((result) => {
        if (stale) return;
        if (result.messages.length > 0) setMessages(result.messages);
        const covered = { base: draftBase, cover: draftCover, feature: result.feature, sideNames: result.side_names };
        updateDraft((s) => (current(s) === draftBase && s.cover === draftCover ? { ...s, covered } : s));
      })
      .catch((ex) => !stale && setMessages([(ex as Error).message]));
    return () => {
      stale = true;
    };
  }, [draftBase, draftCover]);

  function mapContext(): MapContext {
    const map = mapRef.current!;
    const b = map.getBounds();
    return { layer, strategy, zoom: map.getZoom(), view_bbox: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()] };
  }

  async function run<T>(task: () => Promise<T>): Promise<T | null> {
    setBusy(true);
    try {
      return await task();
    } catch (ex) {
      setMessages([(ex as Error).message]);
      return null;
    } finally {
      setBusy(false);
    }
  }

  function startDraft(result: WandResult | null) {
    if (!result) return;
    setMessages(result.messages);
    if (result.alternatives.length === 0 || !result.anchor) return;
    setDraft({ id: nextId++, anchor: result.anchor, alternatives: result.alternatives, selected: result.selected, undo: [], zone: lastZone, cover: lastCover, covered: null });
  }

  function updateDraft(change: (s: Selection) => Selection) {
    setDraft((prev) => prev && change(prev));
  }

  function setZone(zone: ZoneSettings) {
    updateDraft((s) => ({ ...s, zone }));
    setLastZone(zone);
  }

  function setCover(cover: RoadCover) {
    updateDraft((s) => ({ ...s, cover }));
    setLastCover(cover);
  }

  async function selectAt(point: Position) {
    startDraft(await run(() => api.select({ ...mapContext(), point })));
  }

  function isOnDraft(selection: Selection, point: Position): boolean {
    return [current(selection), shown(selection)].some((feature) => isOnFeature(feature, point));
  }

  function isOnFeature(feature: WandFeature, point: Position): boolean {
    const map = mapRef.current!;
    const toScreen = (p: Position) => {
      const { x, y } = map.project([p[0], p[1]]);
      return [x, y];
    };
    return containsPoint(feature, point) || edgeDistancePx(feature, point, toScreen) <= CUT_TOLERANCE_PX;
  }

  async function cutAt(selection: Selection, point: Position) {
    applyEdit(await run(() => api.cut({ feature: current(selection), anchor: selection.anchor, point })));
  }

  async function extendTo(selection: Selection, point: Position) {
    applyEdit(await run(() => api.extend({ feature: current(selection), point })));
  }

  function applyEdit(result: EditResult | null) {
    if (!result) return;
    setMessages(result.messages);
    const feature = result.feature;
    if (!feature) return;
    updateDraft((s) => ({
      ...s,
      alternatives: s.alternatives.map((f, i) => (i === s.selected ? feature : f)),
      undo: [...s.undo, current(s)],
    }));
  }

  function finishDraft() {
    if (!draft || !isCovered(draft)) return;
    const done = draft;
    setSelections((prev) => (prev.some((s) => s.id === done.id) ? prev.map((s) => (s.id === done.id ? done : s)) : [...prev, done]));
    setDraft(null);
    setMessages([]);
  }

  function discardDraft() {
    setDraft(null);
    setMessages([]);
  }

  function editSelection(selection: Selection) {
    if (draft) setMessages([FINISH_FIRST]);
    else setDraft(selection);
  }

  async function lassoAround(points: Position[]) {
    const ring = [...points, points[0]];
    startDraft(await run(() => api.lasso({ ...mapContext(), lasso: { type: "Polygon", coordinates: [ring] } })));
  }

  function cycle(step: number) {
    updateDraft((s) => ({ ...s, selected: (s.selected + step + s.alternatives.length) % s.alternatives.length, undo: [] }));
  }

  function undoCut() {
    if (!draft || draft.undo.length === 0) return;
    updateDraft((s) => ({
      ...s,
      alternatives: s.alternatives.map((f, i) => (i === s.selected ? s.undo[s.undo.length - 1] : f)),
      undo: s.undo.slice(0, -1),
    }));
  }

  function remove(id: number) {
    setSelections((prev) => prev.filter((s) => s.id !== id));
    if (id === draft?.id) setDraft(null);
  }

  function exportGeoJson() {
    const data = collection(selections.map(withZone));
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/geo+json" }));
    const link = Object.assign(document.createElement("a"), { href: url, download: "selections.geojson" });
    link.click();
    URL.revokeObjectURL(url);
  }

  const handlers = useRef({ onClick: (_: MapMouseEvent) => {}, onKey: (_: KeyboardEvent) => {}, onLasso: (_: Position[]) => {} });
  handlers.current = {
    onClick: (e) => {
      if (tool !== "wand" || busy) return;
      const point = [e.lngLat.lng, e.lngLat.lat];
      if (!draft) void selectAt(point);
      else if (isOnDraft(draft, point)) void cutAt(draft, point);
      else if (isRoad(current(draft))) void extendTo(draft, point);
      else setMessages([CUT_INSIDE]);
    },
    onLasso: (points) => {
      if (draft) setMessages([FINISH_FIRST]);
      else void lassoAround(points);
    },
    onKey: (e) => {
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea")) return;
      if (e.key === "Enter") {
        e.preventDefault();
        finishDraft();
      } else if (e.key === "Escape") discardDraft();
      else if (target.closest("select")) return;
      else if (e.key === "Tab") {
        e.preventDefault();
        cycle(e.shiftKey ? -1 : 1);
      } else if (e.key === "Delete" && draft) remove(draft.id);
      else if (e.key === "z" && (e.ctrlKey || e.metaKey)) undoCut();
      else if (e.key === "w") setTool("wand");
      else if (e.key === "l") setTool("lasso");
    },
  };

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    const onClick = (e: MapMouseEvent) => handlers.current.onClick(e);
    const onKey = (e: KeyboardEvent) => handlers.current.onKey(e);
    map.on("click", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      map.off("click", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map || tool !== "lasso") return;
    const canvas = map.getCanvasContainer();
    let points: Position[] | null = null;
    let lastPx: [number, number] = [0, 0];
    const draw = () =>
      setData(map, "lasso", {
        type: "FeatureCollection",
        features: points && points.length >= 2
          ? [{ type: "Feature", geometry: { type: "Polygon", coordinates: [[...points, points[0]]] }, properties: {} }]
          : [],
      });
    const down = (e: MapMouseEvent) => {
      if (e.originalEvent.button !== 0) return;
      e.preventDefault();
      points = [[e.lngLat.lng, e.lngLat.lat]];
      lastPx = [e.point.x, e.point.y];
    };
    const move = (e: MapMouseEvent) => {
      if (!points || Math.hypot(e.point.x - lastPx[0], e.point.y - lastPx[1]) < LASSO_MIN_STEP_PX) return;
      points.push([e.lngLat.lng, e.lngLat.lat]);
      lastPx = [e.point.x, e.point.y];
      draw();
    };
    const up = () => {
      if (!points) return;
      const done = points;
      points = null;
      draw();
      if (done.length >= MIN_LASSO_POINTS) handlers.current.onLasso(done);
    };
    map.dragPan.disable();
    canvas.style.cursor = "crosshair";
    map.on("mousedown", down);
    map.on("mousemove", move);
    map.on("mouseup", up);
    return () => {
      map.dragPan.enable();
      canvas.style.cursor = "";
      map.off("mousedown", down);
      map.off("mousemove", move);
      map.off("mouseup", up);
    };
  }, [mapReady, tool]);

  const samBadge = !health
    ? { text: "connecting…", tone: "wait" }
    : health.sam_ready
      ? { text: "SAM2 ready", tone: "ok" }
      : health.sam_error
        ? { text: "SAM2 off", tone: "error" }
        : { text: "SAM2 loading…", tone: "wait" };

  return (
    <div className={`app ${busy ? "busy" : ""}`}>
      <div ref={container} className="map" />
      <aside className="panel">
        <header>
          <h1>Map Polygon Creation</h1>
          <span className={`badge ${samBadge.tone}`} title={health?.sam_error ?? health?.model}>
            {samBadge.text}
          </span>
        </header>

        <div className="segmented" role="tablist" aria-label="Tool">
          <button className={tool === "wand" ? "on" : ""} onClick={() => setTool("wand")}>
            Wand <kbd>W</kbd>
          </button>
          <button className={tool === "lasso" ? "on" : ""} onClick={() => setTool("lasso")}>
            Lasso <kbd>L</kbd>
          </button>
        </div>

        <ol className="steps">
          {tool === "wand" ? (
            <>
              <li className={!draft ? "now" : "done"}>Click an object to start a new polygon.</li>
              <li className={draft ? "now" : ""}>
                Click inside it to cut it there; the side you first clicked is kept. On a road, click further along to
                make it longer.
              </li>
            </>
          ) : (
            <li className={!draft ? "now" : "done"}>Drag around an object. The one that best fits your outline is picked.</li>
          )}
          <li className={draft ? "now" : ""}>Press <strong>Done</strong> to add it to the list.</li>
        </ol>

        <div className="row">
          <label>
            Source
            <select value={strategy} onChange={(e) => setStrategy(e.target.value as Strategy)}>
              <option value="auto">Auto (map, then AI)</option>
              <option value="osm">Map data only</option>
              <option value="sam">AI on imagery only</option>
            </select>
          </label>
          <label>
            Base map
            <select value={layer} onChange={(e) => setLayer(e.target.value as LayerId)}>
              {config && Object.entries(config.layers).map(([id, l]) => <option key={id} value={id}>{l.name}</option>)}
            </select>
          </label>
        </div>

        {draft && (
          <DraftCard
            selection={draft}
            editing={selections.some((s) => s.id === draft.id)}
            onZone={setZone}
            onCover={setCover}
            onCycle={cycle}
            onUndo={undoCut}
            onDone={finishDraft}
            onDiscard={discardDraft}
          />
        )}

        {(busy || messages.length > 0) && (
          <p className="messages" aria-live="polite">{busy ? "Working…" : messages.join(" ")}</p>
        )}

        <section className="list">
          <div className="list-head">
            <h2>Selections ({selections.length})</h2>
            <button disabled={selections.length === 0} onClick={exportGeoJson}>
              Export GeoJSON
            </button>
          </div>
          <ul>
            {selections.map((s) => (
              <li key={s.id} className={s.id === draft?.id ? "active" : ""}>
                <button className="pick" title="Edit" onClick={() => editSelection(s)}>
                  <span className="chip" style={{ background: s.id === draft?.id ? ACTIVE_COLOR : ZONE_COLORS[s.zone.mode] }} />
                  <span className="name" title={coverText(shown(s))}>{shown(s).properties.label}</span>
                  <span className={`mode ${s.zone.mode}`}>{zoneText(s.zone)}</span>
                  <span className="area">{formatArea(shown(s).properties.area_m2)}</span>
                </button>
                <button className="icon" aria-label="Delete selection" onClick={() => remove(s.id)}>
                  ×
                </button>
              </li>
            ))}
          </ul>
        </section>

        <footer>
          <kbd>Tab</kbd> alternatives · <kbd>Ctrl Z</kbd> undo · <kbd>Enter</kbd> done · <kbd>Esc</kbd> discard · <kbd>Del</kbd> delete
        </footer>
      </aside>
    </div>
  );
}

function DraftCard({ selection, editing, onZone, onCover, onCycle, onUndo, onDone, onDiscard }: {
  selection: Selection;
  editing: boolean;
  onZone: (zone: ZoneSettings) => void;
  onCover: (cover: RoadCover) => void;
  onCycle: (step: number) => void;
  onUndo: () => void;
  onDone: () => void;
  onDiscard: () => void;
}) {
  const { properties: p } = shown(selection);
  const zone = selection.zone;
  const sourceName = { osm: "map data", sam2: "AI (SAM2)", "osm-group": "map data, grouped" }[p.source];
  return (
    <section className="card">
      <div className="card-title">
        <strong>{p.label}</strong>
        <span>{formatArea(p.area_m2)}</span>
      </div>
      <div className="card-meta">
        from {sourceName}
        {p.fit !== undefined && ` · fit ${Math.round(p.fit * 100)}%`}
        {p.fit === undefined && p.score !== undefined && ` · confidence ${Math.round(p.score * 100)}%`}
        {p.cuts ? ` · ${p.cuts} cut${p.cuts > 1 ? "s" : ""}` : ""}
        {p.extensions ? ` · extended ${p.extensions}×` : ""}
      </div>
      {isRoad(current(selection)) && (
        <CoverPicker
          cover={selection.cover}
          sideNames={selection.covered?.sideNames ?? DEFAULT_SIDE_NAMES}
          onCover={onCover}
        />
      )}
      <div className="zone">
        <div className="segmented small" role="radiogroup" aria-label="Zone type">
          <button
            role="radio"
            aria-checked={zone.mode === "ignore"}
            className={zone.mode === "ignore" ? "on ignore" : ""}
            onClick={() => onZone({ ...zone, mode: "ignore" })}
          >
            Ignore motion
          </button>
          <button
            role="radio"
            aria-checked={zone.mode === "alert"}
            className={zone.mode === "alert" ? "on alert" : ""}
            onClick={() => onZone({ ...zone, mode: "alert" })}
          >
            Priority alerts
          </button>
        </div>
        {zone.mode === "alert" && (
          <label className="rate">
            Alert rate
            <select value={zone.alert_rate} onChange={(e) => onZone({ ...zone, alert_rate: Number(e.target.value) })}>
              {ALERT_RATES.map((r) => <option key={r} value={r}>{r}× normal</option>)}
            </select>
          </label>
        )}
        <p className="zone-hint">
          {zone.mode === "ignore"
            ? "Motion inside this area never raises an alert."
            : `Motion inside this area raises alerts ${zone.alert_rate}× as often as elsewhere.`}
        </p>
      </div>
      <div className="card-actions">
        {selection.alternatives.length > 1 && (
          <span className="alts">
            <button onClick={() => onCycle(-1)} aria-label="Previous alternative">‹</button>
            {selection.selected + 1}/{selection.alternatives.length}
            <button onClick={() => onCycle(1)} aria-label="Next alternative">›</button>
          </span>
        )}
        <button disabled={selection.undo.length === 0} onClick={onUndo}>Undo</button>
      </div>
      <div className="card-finish">
        <button className="danger" onClick={onDiscard}>{editing ? "Cancel" : "Discard"}</button>
        <button className="primary" disabled={!isCovered(selection)} onClick={onDone}>{editing ? "Save" : "Done"}</button>
      </div>
    </section>
  );
}

const COVER_PARTS = [
  { label: "Road", road: true, withSides: false },
  { label: "Road + side", road: true, withSides: true },
  { label: "Side only", road: false, withSides: true },
];

function CoverPicker({ cover, sideNames, onCover }: {
  cover: RoadCover;
  sideNames: [string, string];
  onCover: (cover: RoadCover) => void;
}) {
  const withSides = cover.sides !== "none";
  const sides: { value: RoadSides; label: string }[] = [
    { value: "left", label: sideNames[0] },
    { value: "right", label: sideNames[1] },
    { value: "both", label: "Both" },
  ];
  return (
    <div className="zone">
      <div className="segmented small" role="radiogroup" aria-label="Cover">
        {COVER_PARTS.map((part) => {
          const on = part.road === cover.road && part.withSides === withSides;
          return (
            <button
              key={part.label}
              role="radio"
              aria-checked={on}
              className={on ? "on" : ""}
              onClick={() => onCover({ ...cover, road: part.road, sides: part.withSides ? (withSides ? cover.sides : "left") : "none" })}
            >
              {part.label}
            </button>
          );
        })}
      </div>
      {withSides && (
        <>
          <div className="segmented small" role="radiogroup" aria-label="Side">
            {sides.map((side) => (
              <button
                key={side.value}
                role="radio"
                aria-checked={cover.sides === side.value}
                className={cover.sides === side.value ? "on" : ""}
                onClick={() => onCover({ ...cover, sides: side.value })}
              >
                {side.label}
              </button>
            ))}
          </div>
          <SideWidth value={cover.side_m} onChange={(side_m) => onCover({ ...cover, side_m })} />
        </>
      )}
    </div>
  );
}

const MAX_SIDE_M = 200;

function SideWidth({ value, onChange }: { value: number; onChange: (meters: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <label className="rate">
      Width off the road
      <span>
        <input
          type="number"
          min={1}
          max={MAX_SIDE_M}
          step={1}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            const meters = Number(e.target.value);
            if (meters > 0 && meters <= MAX_SIDE_M) onChange(meters);
          }}
        />{" "}
        m
      </span>
    </label>
  );
}
