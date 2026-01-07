/************************************************************
 * GeoNEMO - index.js (WGS84 + Vinculación por GRUPO)
 *
 * - Carga grupos desde:
 *    /capas/grupo_snaspe.json
 * - Cada grupo tiene "files": lista de GeoJSON (subcapas).
 * - Click:
 *    Para cada GRUPO => 1 único polígono ganador:
 *      a) inside (punto dentro) => ganador inmediato
 *      b) si no => nearest_perimeter (más cercano al perímetro) => ganador
 * - Distancia al perímetro en METROS (distance_m)
 * - Guarda en localStorage (geonemo_out_v2) y abre mapaout.html SIEMPRE
 *
 * IMPORTANTE:
 * - Requiere Leaflet (L) y Turf.js global (turf).
 ************************************************************/

const REGIONES_URL = "data/regiones.json";
const HOME_VIEW = { center: [-33.5, -71.0], zoom: 5 };

const OUT_STORAGE_KEY = "geonemo_out_v2";

// ✅ Ruta pedida por ti:
const GROUP_DEFS = [
  { id: "snaspe", url: "capas/grupo_snaspe.json", enabled: true },
];

// ====== mapa global ======
let map;
let userMarker = null;
let clickMarker = null;

/**
 * Índice por archivo GeoJSON en memoria:
 * fileUrl -> { loaded:boolean, featuresIndex:[{feature,bbox,areaM2}] }
 */
const fileState = new Map();

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
   Path helpers (para grupos)
=========================== */
function dirname(path){
  const s = String(path || "");
  const i = s.lastIndexOf("/");
  if (i <= 0) return "";
  return s.slice(0, i + 1); // incluye "/"
}

function isAbsUrl(u){
  return /^https?:\/\//i.test(u) || u.startsWith("/");
}

function joinPath(baseDir, rel){
  if (!baseDir) return rel;
  if (baseDir.endsWith("/") && rel.startsWith("/")) return baseDir + rel.slice(1);
  if (!baseDir.endsWith("/") && !rel.startsWith("/")) return baseDir + "/" + rel;
  return baseDir + rel;
}

/**
 * Resuelve rutas de "files" respecto al folder del JSON de grupo.
 * Ej:
 *  groupUrl = "capas/grupo_snaspe.json" => baseDir "capas/"
 *  file "capas_snaspe/xxx.geojson" => "capas/capas_snaspe/xxx.geojson"
 *
 * Si el file ya viene con "/" al inicio o http(s), se usa tal cual.
 */
function resolveGroupFileUrl(groupUrl, filePath){
  const f = String(filePath || "");
  if (isAbsUrl(f)) return f;
  const baseDir = dirname(groupUrl);
  return joinPath(baseDir, f);
}

/* ===========================
   Carga grupo JSON
=========================== */
async function loadGroupDefinition(def){
  const res = await fetch(def.url, { cache: "no-store" });
  if (!res.ok) throw new Error(`No se pudo cargar ${def.url} (HTTP ${res.status})`);
  const gj = await res.json();

  const groupName = gj.group || def.id || "GRUPO";
  const filesRaw = Array.isArray(gj.files) ? gj.files : [];
  const files = filesRaw
    .map(f => resolveGroupFileUrl(def.url, f))
    // opcional: filtrar solo geojson
    .filter(u => /\.geojson$/i.test(u));

  return {
    group_id: def.id,
    group_name: groupName,
    enabled: def.enabled !== false,
    files
  };
}

/* ===========================
   Load GeoJSON por ARCHIVO + index bbox/area
=========================== */
async function ensureFileLoaded(fileUrl){
  const st = fileState.get(fileUrl) || { loaded:false, featuresIndex:[] };
  if (st.loaded) return st;

  if (!assertTurfReady()) return st;

  const res = await fetch(fileUrl, { cache:"no-store" });
  if (!res.ok) throw new Error(`No se pudo cargar ${fileUrl} (HTTP ${res.status})`);

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
  fileState.set(fileUrl, st);

  // Toast suave (sin ensuciar mucho)
  toast(`✅ Cargado: ${fileUrl.split("/").pop()} (${idx.length})`, 1200);
  return st;
}

/* ===========================
   Stats BBOX (usa primer grupo enabled)
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

let GROUPS = []; // grupos cargados en init

async function updateBboxStats(){
  if (!map) return;
  if (!assertTurfReady()) { setStatsUI("—","—","—"); return; }

  const g = GROUPS.find(x => x.enabled) || GROUPS[0];
  if (!g || !g.files?.length) { setStatsUI("—","—","—"); return; }

  // Tomamos TODOS los archivos del grupo para stats (más fiel a “grupo”)
  const b = map.getBounds();
  const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  const bboxPoly = turf.bboxPolygon(bbox);

  let total = 0;
  let protectedAreaM2 = 0;

  for (const fileUrl of g.files){
    let st;
    try{ st = await ensureFileLoaded(fileUrl); }
    catch(e){ continue; }

    for (const it of (st.featuresIndex || [])){
      if (!bboxIntersects(it.bbox, bbox)) continue;

      let touches = false;
      try { touches = turf.booleanIntersects(it.feature, bboxPoly); } catch(_) {}
      if (!touches) continue;

      total += 1;

      try {
        const inter = turf.intersect(it.feature, bboxPoly);
        if (inter) protectedAreaM2 += turf.area(inter);
        else protectedAreaM2 += (isFinite(it.areaM2) ? it.areaM2 : 0);
      } catch(_) {
        protectedAreaM2 += (isFinite(it.areaM2) ? it.areaM2 : 0);
      }
    }
  }

  setStatsUI(fmtInt(total), fmtInt(total), fmtArea(protectedAreaM2));

  const prev = loadOut() || {};
  saveOut({
    ...prev,
    updated_at: nowIso(),
    bbox: { west: bbox[0], south: bbox[1], east: bbox[2], north: bbox[3] },
    stats: {
      group_id: g.group_id,
      group_name: g.group_name,
      areas_bbox: total,
      total_bbox: total,
      protected_area_m2: protectedAreaM2,
      protected_area_fmt: fmtArea(protectedAreaM2)
    }
  });
}

/* ===========================
   Vinculación por GRUPO:
   - inside => ok (ganador inmediato)
   - else => nearest perimeter (mínimo en todo el grupo)
   Distancia al perímetro en METROS.
=========================== */
function distToPerimeterM(feature, pt){
  try{
    const line = turf.polygonToLine(feature);
    // ✅ en metros (si tu versión de turf no soporta "meters", usa "kilometers"*1000)
    let d = turf.pointToLineDistance(pt, line, { units:"meters" });
    if (!isFinite(d)) return Infinity;
    return d;
  } catch(e){
    // fallback por compatibilidad
    try{
      const line = turf.polygonToLine(feature);
      const km = turf.pointToLineDistance(pt, line, { units:"kilometers" });
      return isFinite(km) ? km * 1000 : Infinity;
    } catch(_){
      return Infinity;
    }
  }
}

/**
 * Devuelve 1 ganador por grupo:
 * - inside (si existe) o
 * - nearest_perimeter (mínimo global)
 */
async function linkOneGroupToPoint(group, pt, lon, lat){
  const files = group.files || [];
  if (!files.length) {
    return {
      group_id: group.group_id,
      group_name: group.group_name,
      link_type: "none",
      distance_m: null,
      source_file: null,
      feature: null
    };
  }

  // 1) inside: recorrer archivos + bbox prefilter
  for (const fileUrl of files){
    const st = await ensureFileLoaded(fileUrl);
    const idx = st.featuresIndex || [];
    if (!idx.length) continue;

    for (const it of idx){
      if (!bboxContainsLonLat(it.bbox, lon, lat)) continue;
      let inside = false;
      try{ inside = turf.booleanPointInPolygon(pt, it.feature); } catch(_) {}
      if (inside){
        const f = it.feature;
        return {
          group_id: group.group_id,
          group_name: group.group_name,
          link_type: "inside",
          distance_m: 0,
          source_file: fileUrl,
          feature: {
            type: "Feature",
            properties: f.properties || {},
            geometry: f.geometry
          }
        };
      }
    }
  }

  // 2) nearest perimeter: mínimo entre TODOS los polígonos de TODOS los archivos
  let bestD = Infinity;
  let bestFeat = null;
  let bestFile = null;

  for (const fileUrl of files){
    const st = await ensureFileLoaded(fileUrl);
    const idx = st.featuresIndex || [];
    if (!idx.length) continue;

    for (const it of idx){
      const d = distToPerimeterM(it.feature, pt);
      if (d < bestD){
        bestD = d;
        bestFeat = it.feature;
        bestFile = fileUrl;
      }
    }
  }

  if (!bestFeat){
    return {
      group_id: group.group_id,
      group_name: group.group_name,
      link_type: "none",
      distance_m: null,
      source_file: null,
      feature: null
    };
  }

  return {
    group_id: group.group_id,
    group_name: group.group_name,
    link_type: "nearest_perimeter",
    distance_m: isFinite(bestD) ? bestD : null,
    source_file: bestFile,
    feature: {
      type: "Feature",
      properties: bestFeat.properties || {},
      geometry: bestFeat.geometry
    }
  };
}

/* ===========================
   Click: siempre abre mapaout.html
=========================== */
async function onMapClick(e){
  if (!assertTurfReady()) return;

  const lat = e.latlng.lat;
  const lng = e.latlng.lng;

  if (clickMarker) map.removeLayer(clickMarker);
  clickMarker = L.circleMarker([lat, lng], {
    radius: 7, weight: 2, opacity: 1, fillOpacity: 0.25
  }).addTo(map);

  const pt = turf.point([lng, lat]);

  const activeGroups = (GROUPS || []).filter(g => g.enabled);
  const results = [];

  for (const g of activeGroups){
    try{
      const r = await linkOneGroupToPoint(g, pt, lng, lat);
      results.push(r);
    } catch(err){
      console.warn("Error vinculando grupo", g, err);
      results.push({
        group_id: g.group_id,
        group_name: g.group_name,
        link_type: "error",
        distance_m: null,
        source_file: null,
        feature: null
      });
    }
  }

  const insideCount = results.filter(x => x.link_type === "inside").length;
  toast(insideCount ? `✅ Dentro en ${insideCount} grupo(s)` : "📍 Vinculación por proximidad al perímetro", 1600);

  const prev = loadOut() || {};

  // ✅ Compatibilidad: además de "groups", dejamos "links" estilo antiguo
  const legacyLinks = results.map(r => ({
    layer_id: r.group_id,
    layer_name: r.group_name,
    link_type: r.link_type,
    // antes era km; ahora guardamos metros y dejamos km calculado si lo necesitas
    distance_km: isFinite(r.distance_m) ? (r.distance_m / 1000) : null,
    distance_m: r.distance_m ?? null,
    source_file: r.source_file ?? null,
    feature: r.feature
  }));

  saveOut({
    ...prev,
    created_at: prev.created_at || nowIso(),
    updated_at: nowIso(),
    click: { lat, lng },

    // ✅ nuevo formato por grupo
    groups: results,

    // ✅ legacy para que mapaout viejo no se rompa
    links: legacyLinks
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

  if (btnOut) btnOut.addEventListener("click", () => openOut());

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
        const activeGroups = (GROUPS || []).filter(g => g.enabled);
        for (const g of activeGroups){
          for (const fileUrl of (g.files || [])){
            await ensureFileLoaded(fileUrl);
          }
        }
        toast("⬇️ Archivos del grupo precargados", 1400);
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

  // Cargar definiciones de grupos
  try{
    const defs = GROUP_DEFS.filter(d => d.enabled !== false);
    const loaded = [];
    for (const d of defs){
      const g = await loadGroupDefinition(d);
      loaded.push(g);
    }
    GROUPS = loaded;

    if (!GROUPS.length){
      toast("⚠️ No hay grupos cargados", 2600);
    } else {
      toast(`✅ Grupos cargados: ${GROUPS.map(g => g.group_name).join(", ")}`, 2200);
    }
  } catch(e){
    console.error(e);
    toast("⚠️ No pude cargar grupos (ver consola)", 2800);
    GROUPS = [];
  }

  // precarga silenciosa del primer archivo del primer grupo
  const firstGroup = GROUPS.find(g => g.enabled) || GROUPS[0];
  const firstFile = firstGroup?.files?.[0];
  if (firstFile) ensureFileLoaded(firstFile).catch(() => {});

  scheduleStatsUpdate();
  toast("Listo ✅ Clic para vincular 1 polígono ganador por GRUPO y abrir MapaOut.", 2600);
})();
