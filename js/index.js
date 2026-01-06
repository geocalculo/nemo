/************************************************************
 * GeoNEMO - index.js (WGS84 + Vinculación por capa)
 * - Basemap: OpenTopoMap 100% + Satélite (Esri) 25% encima
 * - Click: calcula 1 polígono ganador por capa:
 *    a) inside (punto dentro) => feature ganador
 *    b) si no => nearest_perimeter (más cercano al perímetro) => feature ganador
 * - Guarda en localStorage (geonemo_out_v2) y abre mapaout.html SIEMPRE
 *
 * IMPORTANTE:
 * - Requiere Turf.js disponible como "turf" (global).
 ************************************************************/

const REGIONES_URL = "data/regiones.json";
const HOME_VIEW = { center: [-33.5, -71.0], zoom: 5 };
const REGION_ZOOM_50K = 14;

const OUT_STORAGE_KEY = "geonemo_out_v2";

/**
 * Estructura de capas (segmentación por peso / bbox):
 * - SNASPE: Norte / Sur, Tipo 1 / Tipo 2
 * - RAMSAR: Norte, Tipo 1 / Tipo 2
 *
 * Ajusta urls a tu carpeta /capas/
 */
const LAYERS = [
  // ========= SNASPE =========
  { id: "snaspe_norte_t1", name: "SNASPE Norte · Tipo 1", url: "capas/SNASPE_Norte_Tipo1.geojson", enabled: false },
  { id: "snaspe_norte_t2", name: "SNASPE Norte · Tipo 2", url: "capas/SNASPE_Norte_Tipo2.geojson", enabled: false },
  { id: "snaspe_sur_t1",   name: "SNASPE Sur · Tipo 1",   url: "capas/SNASPE_Sur_Tipo1.geojson",   enabled: false },
  { id: "snaspe_sur_t2",   name: "SNASPE Sur · Tipo 2",   url: "capas/SNASPE_Sur_Tipo2.geojson",   enabled: false },

  // Ejemplo actual (tu archivo subido)
  { id: "snaspe_mn", name: "SNASPE · Monumento Natural", url: "capas/SNASPE_Monumento_Natural.geojson", enabled: true },

  // ========= RAMSAR =========
  { id: "ramsar_norte_t1", name: "RAMSAR Norte · Tipo 1", url: "capas/RAMSAR_Norte_Tipo1.geojson", enabled: false },
  { id: "ramsar_norte_t2", name: "RAMSAR Norte · Tipo 2", url: "capas/RAMSAR_Norte_Tipo2.geojson", enabled: false },
];

// ====== mapa global ======
let map;
let userMarker = null;
let clickMarker = null;

/**
 * Índice por capa en memoria:
 * layerId -> { loaded:boolean, featuresIndex:[{feature,bbox,areaM2}] }
 */
const layerState = new Map();

/* ===========================
   UI helpers
=========================== */
function toast(msg, ms = 2200) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), ms);
}

function fmtInt(n){ return (n ?? 0).toLocaleString("es-CL"); }

function fmtArea(m2){
  if (!isFinite(m2)) return "—";
  const ha = m2 / 10000;
  if (ha >= 1000){
    const km2 = m2 / 1e6;
    return `${km2.toLocaleString("es-CL", { maximumFractionDigits: 1 })} km²`;
  }
  return `${ha.toLocaleString("es-CL", { maximumFractionDigits: 1 })} ha`;
}

function nowIso(){ return new Date().toISOString(); }

function bboxIntersects(b1, b2){
  // [minLon,minLat,maxLon,maxLat]
  return !(b2[0] > b1[2] || b2[2] < b1[0] || b2[1] > b1[3] || b2[3] < b1[1]);
}

function bboxContainsLonLat(bb, lon, lat) {
  return lon >= bb[0] && lon <= bb[2] && lat >= bb[1] && lat <= bb[3];
}

/* ===========================
   Validación Turf (CRÍTICO)
=========================== */
function assertTurfReady() {
  const ok =
    typeof window.turf !== "undefined" &&
    turf &&
    typeof turf.bbox === "function" &&
    typeof turf.area === "function" &&
    typeof turf.booleanPointInPolygon === "function" &&
    typeof turf.polygonToLine === "function" &&
    typeof turf.pointToLineDistance === "function" &&
    typeof turf.bboxPolygon === "function" &&
    typeof turf.booleanIntersects === "function";

  if (!ok) {
    console.error("[GeoNEMO] Turf.js no está cargado o faltan funciones. Revisa index.html (script turf).");
    toast("⚠️ Falta Turf.js (no puedo calcular inside/nearest). Revisa index.html.", 3800);
  }
  return ok;
}

/* ===========================
   localStorage out
=========================== */
function saveOut(payload){
  try{ localStorage.setItem(OUT_STORAGE_KEY, JSON.stringify(payload)); }
  catch(e){ console.warn("No pude guardar salida", e); }
}

function loadOut(){
  try{
    const raw = localStorage.getItem(OUT_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch(e){ return null; }
}

function openOut(){
  window.open("mapaout.html", "_blank", "noopener");
}

/* ===========================
   Map init
=========================== */
function crearMapa() {
  map = L.map("map", { zoomControl: true, preferCanvas: true })
    .setView(HOME_VIEW.center, HOME_VIEW.zoom);

  const topoBase = L.tileLayer(
    "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
    {
      maxZoom: 17,
      subdomains: "abc",
      opacity: 1.0,
      attribution: "Map data: &copy; OpenStreetMap contributors, SRTM | OpenTopoMap",
      crossOrigin: true,
      updateWhenIdle: true
    }
  );

  const satOverlay = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    {
      maxZoom: 19,
      opacity: 0.25,
      attribution: "Tiles &copy; Esri",
      crossOrigin: true,
      updateWhenIdle: true
    }
  );

  topoBase.addTo(map);
  satOverlay.addTo(map);

  map.on("moveend", scheduleStatsUpdate);
  map.on("zoomend", scheduleStatsUpdate);
  map.on("click", onMapClick);

  setTimeout(() => map.invalidateSize(true), 250);
}

/* ===========================
   Regiones (solo navegación)
=========================== */
async function cargarRegiones() {
  const sel = document.getElementById("selRegion");
  if (!sel) return;

  sel.innerHTML = `<option value="">Selecciona región…</option>`;

  let data;
  try {
    const res = await fetch(REGIONES_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (e) {
    console.error(e);
    toast("⚠️ No pude cargar data/regiones.json", 2500);
    return;
  }

  const regiones = Array.isArray(data) ? data : (data.regiones || []);
  for (const r of regiones) {
    const opt = document.createElement("option");
    opt.value = String(r.codigo_ine ?? r.id ?? r.nombre ?? "");
    opt.textContent = r.nombre ?? opt.value;
    opt.dataset.center = JSON.stringify(r.centro || r.center || null);
    opt.dataset.zoom = String(r.zoom ?? 7);
    sel.appendChild(opt);
  }

  sel.addEventListener("change", () => {
    const opt = sel.options[sel.selectedIndex];
    if (!opt || !opt.value) return;

    let center = null;
    try { center = JSON.parse(opt.dataset.center); } catch(_) {}
    const zoom = parseInt(opt.dataset.zoom || "7", 10);

    if (Array.isArray(center) && center.length === 2) {
      map.setView(center, zoom, { animate: true });
      setTimeout(() => map.invalidateSize(true), 150);
      scheduleStatsUpdate();
    }
  });
}

/* ===========================
   Load GeoJSON por capa + index bbox/area
=========================== */
async function ensureLayerLoaded(layer){
  const st = layerState.get(layer.id) || { loaded:false, featuresIndex:[] };
  if (st.loaded) return st;

  if (!assertTurfReady()) {
    // no cargamos capas si falta turf (porque bbox/area depende)
    return st;
  }

  const res = await fetch(layer.url, { cache:"no-store" });
  if (!res.ok) throw new Error(`No se pudo cargar ${layer.url} (HTTP ${res.status})`);

  const gj = await res.json();
  const feats = gj.features || [];

  const idx = [];
  for (const f of feats){
    const t = f?.geometry?.type;
    if (t === "Polygon" || t === "MultiPolygon"){
      try{
        const bb = turf.bbox(f);
        let areaM2 = NaN;
        try{ areaM2 = turf.area(f); } catch(_) {}
        idx.push({ feature:f, bbox:bb, areaM2 });
      } catch(_){}
    }
  }

  st.loaded = true;
  st.featuresIndex = idx;
  layerState.set(layer.id, st);

  toast(`✅ Cargada: ${layer.name} (${idx.length})`, 1600);
  return st;
}

/* ===========================
   Resumen BBOX (usa primera capa enabled como resumen)
=========================== */
const elStProtected = document.getElementById("stProtected");
const elStTotal     = document.getElementById("stTotal");
const elStArea      = document.getElementById("stArea");

function setStatsUI(a, b, c){
  if (elStProtected) elStProtected.textContent = a;
  if (elStTotal)     elStTotal.textContent     = b;
  if (elStArea)      elStArea.textContent      = c;
}

let _statsRAF = false;
function scheduleStatsUpdate(){
  if (_statsRAF) return;
  _statsRAF = true;
  requestAnimationFrame(() => {
    _statsRAF = false;
    updateBboxStats().catch(err => console.warn(err));
  });
}

async function updateBboxStats(){
  if (!map) return;
  if (!assertTurfReady()) {
    setStatsUI("—","—","—");
    return;
  }

  const layer = LAYERS.find(l => l.enabled) || LAYERS[0];
  if (!layer) return;

  let st;
  try{ st = await ensureLayerLoaded(layer); }
  catch(e){
    console.error(e);
    setStatsUI("—","—","—");
    return;
  }

  const b = map.getBounds();
  const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  const bboxPoly = turf.bboxPolygon(bbox);

  let totalAreas = 0;
  let protectedAreas = 0;
  let protectedAreaM2 = 0;

  for (const it of st.featuresIndex){
    if (!bboxIntersects(it.bbox, bbox)) continue;

    let touches = false;
    try { touches = turf.booleanIntersects(it.feature, bboxPoly); } catch(_) {}
    if (!touches) continue;

    totalAreas += 1;
    protectedAreas += 1;

    try {
      const inter = turf.intersect(it.feature, bboxPoly);
      if (inter) protectedAreaM2 += turf.area(inter);
      else protectedAreaM2 += (isFinite(it.areaM2) ? it.areaM2 : 0);
    } catch(_) {
      protectedAreaM2 += (isFinite(it.areaM2) ? it.areaM2 : 0);
    }
  }

  setStatsUI(fmtInt(protectedAreas), fmtInt(totalAreas), fmtArea(protectedAreaM2));

  const prev = loadOut() || {};
  saveOut({
    ...prev,
    updated_at: nowIso(),
    bbox: { west: bbox[0], south: bbox[1], east: bbox[2], north: bbox[3] },
    stats: {
      areas_bbox: protectedAreas,
      total_bbox: totalAreas,
      protected_area_m2: protectedAreaM2,
      protected_area_fmt: fmtArea(protectedAreaM2)
    }
  });
}

/* ===========================
   Vinculación por capa:
   - inside => ok
   - else => nearest perimeter
=========================== */
function distToPerimeterKm(feature, pt){
  try{
    const line = turf.polygonToLine(feature);
    const d = turf.pointToLineDistance(pt, line, { units:"kilometers" });
    return isFinite(d) ? d : Infinity;
  } catch(e){
    return Infinity;
  }
}

/**
 * Devuelve SIEMPRE 1 feature ganador si hay features en la capa
 * (inside si existe, si no nearest_perimeter).
 */
async function linkOneLayerToPoint(layer, pt, lon, lat){
  const st = await ensureLayerLoaded(layer);
  const idx = st.featuresIndex || [];

  // Si no hay features (o turf no cargó), retorna none
  if (!idx.length) {
    return {
      layer_id: layer.id,
      layer_name: layer.name,
      link_type: "none",
      distance_km: null,
      feature: null
    };
  }

  // 1) inside con prefiltrado bbox
  let insideFeat = null;
  for (const it of idx){
    if (!bboxContainsLonLat(it.bbox, lon, lat)) continue;
    let inside = false;
    try{ inside = turf.booleanPointInPolygon(pt, it.feature); } catch(_) {}
    if (inside){
      insideFeat = it.feature;
      break;
    }
  }

  if (insideFeat){
    return {
      layer_id: layer.id,
      layer_name: layer.name,
      link_type: "inside",
      distance_km: 0,
      feature: {
        type: "Feature",
        properties: insideFeat.properties || {},
        geometry: insideFeat.geometry
      }
    };
  }

  // 2) nearest perimeter (siempre debería elegir 1)
  let bestD = Infinity;
  let bestFeat = null;

  for (const it of idx){
    const d = distToPerimeterKm(it.feature, pt);
    if (d < bestD){
      bestD = d;
      bestFeat = it.feature;
    }
  }

  // Si por alguna razón todos dieron Infinity, igual elige el primero (fallback real)
  if (!bestFeat) bestFeat = idx[0].feature;

  const outD = isFinite(bestD) ? bestD : null;

  return {
    layer_id: layer.id,
    layer_name: layer.name,
    link_type: "nearest_perimeter",
    distance_km: outD,
    feature: bestFeat ? {
      type: "Feature",
      properties: bestFeat.properties || {},
      geometry: bestFeat.geometry
    } : null
  };
}

/* ===========================
   Click: siempre abre MapaOut.html
=========================== */
async function onMapClick(e){
  if (!assertTurfReady()) return;

  const lat = e.latlng.lat;
  const lng = e.latlng.lng; // 👈 normalizado a lng

  if (clickMarker) map.removeLayer(clickMarker);
  clickMarker = L.circleMarker([lat, lng], {
    radius: 7, weight: 2, opacity: 1, fillOpacity: 0.25
  }).addTo(map);

  const pt = turf.point([lng, lat]);

  const activeLayers = LAYERS.filter(l => l.enabled !== false);
  const links = [];

  for (const layer of activeLayers){
    try{
      const link = await linkOneLayerToPoint(layer, pt, lng, lat);
      links.push(link);
    } catch(e2){
      console.warn("Error vinculando capa", layer, e2);
      links.push({
        layer_id: layer.id,
        layer_name: layer.name,
        link_type: "error",
        distance_km: null,
        feature: null
      });
    }
  }

  const insideCount = links.filter(x => x.link_type === "inside").length;
  toast(insideCount ? `✅ Dentro en ${insideCount} capa(s)` : "📍 Vinculación por proximidad al perímetro", 1600);

  const prev = loadOut() || {};
  saveOut({
    ...prev,
    created_at: prev.created_at || nowIso(),
    updated_at: nowIso(),

    // 👇 click normalizado
    click: { lat, lng },

    // links por capa (cada uno con 1 feature ganador o null)
    links
  });

  openOut();
}

/* ===========================
   Botones
=========================== */
function clearPoint(){
  if (clickMarker) {
    map.removeLayer(clickMarker);
    clickMarker = null;
  }
  toast("🧹 Punto limpiado", 1200);
}

function bindUI() {
  const btnHome = document.getElementById("btnHome");
  const btnGPS = document.getElementById("btnGPS");
  const btnClear = document.getElementById("btnClear");
  const btnPreload = document.getElementById("btnPreload");
  const btnOut = document.getElementById("btnOut");

  if (btnHome) {
    btnHome.addEventListener("click", () => {
      map.setView(HOME_VIEW.center, HOME_VIEW.zoom, { animate: true });
      toast("🏠 Vista inicial", 1200);
      setTimeout(() => map.invalidateSize(true), 150);
      scheduleStatsUpdate();
    });
  }

  if (btnOut) {
    btnOut.addEventListener("click", () => openOut());
  }

  if (btnGPS) {
    btnGPS.addEventListener("click", () => {
      if (!navigator.geolocation) {
        toast("⚠️ Geolocalización no soportada", 2400);
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const lat = pos.coords.latitude;
          const lng = pos.coords.longitude;

          if (userMarker) map.removeLayer(userMarker);
          userMarker = L.circleMarker([lat, lng], {
            radius: 7, weight: 2, opacity: 1, fillOpacity: 0.35
          }).addTo(map);

          map.setView([lat, lng], Math.max(map.getZoom(), 14), { animate: true });
          toast("🎯 Ubicación detectada", 1400);
          setTimeout(() => map.invalidateSize(true), 150);
          scheduleStatsUpdate();
        },
        () => toast("⚠️ No pude obtener tu ubicación", 2600),
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
      );
    });
  }

  if (btnClear) btnClear.addEventListener("click", clearPoint);

  if (btnPreload) {
    btnPreload.addEventListener("click", async () => {
      try {
        const activeLayers = LAYERS.filter(l => l.enabled !== false);
        for (const layer of activeLayers) await ensureLayerLoaded(layer);
        toast("⬇️ Capas precargadas", 1400);
        scheduleStatsUpdate();
      } catch (err) {
        console.error(err);
        toast("⚠️ Error precargando (ver consola)", 2400);
      }
    });
  }
}

/* ===========================
   Init
=========================== */
(async function init() {
  crearMapa();
  bindUI();
  await cargarRegiones();

  // precarga “silenciosa” de la primera enabled
  const first = LAYERS.find(l => l.enabled) || LAYERS[0];
  if (first) ensureLayerLoaded(first).catch(() => {});

  toast("Listo ✅ Clic para vincular 1 polígono por capa y abrir MapaOut.", 2600);
})();
