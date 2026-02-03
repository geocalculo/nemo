/************************************************************
 * GeoNEMO - index.js (WGS84 + Vinculación por GRUPO)
 *
 * - Master de grupos: capas/grupos.json
 * - BBOX resumen: tabla por grupo (# áreas + sup intersección)
 * - Click: 1 polígono ganador por grupo (inside o nearest perimeter)
 *
 * Requiere: Leaflet (L) + Turf.js (turf) global.
 ************************************************************/

const REGIONES_URL = "data/regiones.json";
const HOME_VIEW = { center: [-33.5, -71.0], zoom: 5 };

const OUT_STORAGE_KEY = "geonemo_out_v2";
const MAP_PREF_KEY = "geonemo_map_pref";
const GROUPS_URL = "capas/grupos.json";

let map;
let userMarker = null;
let clickMarker = null;

let topoBase = null;
let satOverlay = null;

// ✅ Debounce para invalidateSize() cuando cambian alturas (evita loops)
let _mapResizeRAF = false;
function scheduleMapInvalidateSize() {
  if (!map || _mapResizeRAF) return;
  _mapResizeRAF = true;
  requestAnimationFrame(() => {
    _mapResizeRAF = false;
    try { map.invalidateSize(false); } catch (_) {}
  });
}


// ✅ Cache de archivos: fileUrl -> { loaded:boolean, featuresIndex:[{feature,bbox,areaM2}] }
const fileState = new Map();

let GROUPS = [];

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
  return !(b2[0] > b1[2] || b2[2] < b1[0] || b2[1] > b1[3] || b2[3] < b1[1]);
}

function bboxContainsLonLat(bb, lon, lat) {
  return lon >= bb[0] && lon <= bb[2] && lat >= bb[1] && lat <= bb[3];
}

/* ===========================
   Turf check
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
    toast("⚠️ Falta Turf.js (no puedo calcular). Revisa index.html.", 3800);
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
   Preferencias mapa
=========================== */
function readMapPref(){
  try { return JSON.parse(localStorage.getItem(MAP_PREF_KEY) || "{}"); }
  catch { return {}; }
}

function writeMapPref(pref){
  try { localStorage.setItem(MAP_PREF_KEY, JSON.stringify(pref || {})); }
  catch {}
}

function syncMapPrefFromCurrentLayers(){
  if (!map || !satOverlay) return;
  const hasSat = map.hasLayer(satOverlay);
  writeMapPref({
    base: "OpenStreetMap",
    overlay: hasSat ? "Esri Satélite" : null,
    overlayOpacity: 0.25
  });
}

// ✅ Auto-sync altura real de .statsbar → CSS var --statsbar-h (sin franjas)
function initStatsbarAutoHeight() {
  const root = document.documentElement;
  const stats = document.querySelector(".statsbar");
  if (!stats) {
    console.warn("[statsbar] .statsbar no encontrado (auto-height no aplicado).");
    return;
  }

  let raf = 0;
  const apply = () => {
    // Evita mediciones redundantes en cascada
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      raf = 0;

      // Medir altura real del panel
      const h = Math.ceil(stats.getBoundingClientRect().height);

      // Evitar writes innecesarios
      const prev = parseInt(getComputedStyle(root).getPropertyValue("--statsbar-h")) || 0;
      if (Math.abs(h - prev) <= 1) return;

      root.style.setProperty("--statsbar-h", `${h}px`);

      // ✅ CORRECCIÓN CRÍTICA: Cuando cambia altura del panel, Leaflet debe redimensionarse
      scheduleMapInvalidateSize();

      // (Opcional) debug rápido
      // console.log("[statsbar] --statsbar-h =", h);
    });
  };

  // 1) Medición inicial
  apply();

  // 2) Observa cambios de tamaño del panel (contenido/tabla/estilos)
  if ("ResizeObserver" in window) {
    const ro = new ResizeObserver(() => apply());
    ro.observe(stats);

    // 3) Por seguridad, también al cambiar viewport
    window.addEventListener("resize", apply, { passive: true });

    // 4) Exponer hook por si quieres forzar manualmente en algún caso raro
    window.__syncStatsbarHeight = apply;

    console.log("[statsbar] Auto-height activo (ResizeObserver).");
  } else {
    // Fallback para navegadores muy viejos (no debería ser tu caso)
    console.warn("[statsbar] ResizeObserver no disponible, usando fallback por resize.");
    window.addEventListener("resize", apply, { passive: true });
    window.__syncStatsbarHeight = apply;
  }
}

// ✅ Ejecutar cuando el DOM esté listo
document.addEventListener("DOMContentLoaded", () => {
  initStatsbarAutoHeight();
  initTopbarAutoHeight();
});


function initTopbarAutoHeight() {
  const root = document.documentElement;
  const top = document.querySelector(".topbar");
  if (!top) return;

  let raf = 0;
  const apply = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      raf = 0;
      const h = Math.ceil(top.getBoundingClientRect().height);
      const prev = parseInt(getComputedStyle(root).getPropertyValue("--topbar-h")) || 0;
      if (Math.abs(h - prev) <= 1) return;
      root.style.setProperty("--topbar-h", `${h}px`);
      
      // ✅ CORRECCIÓN CRÍTICA: Cuando cambia altura del topbar, Leaflet debe redimensionarse
      scheduleMapInvalidateSize();
    });
  };

  apply();

  if ("ResizeObserver" in window) {
    const ro = new ResizeObserver(() => apply());
    ro.observe(top);
    window.addEventListener("resize", apply, { passive: true });
    window.__syncTopbarHeight = apply;
  } else {
    window.addEventListener("resize", apply, { passive: true });
    window.__syncTopbarHeight = apply;
  }
}


/* ===========================
   Map init
=========================== */
function crearMapa() {
  map = L.map("map", { zoomControl: true, preferCanvas: true })
    .setView(HOME_VIEW.center, HOME_VIEW.zoom);

  topoBase = L.tileLayer(
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    {
      name: "OpenStreetMap",
      maxZoom: 19,
      opacity: 1.0,
      attribution: "&copy; OpenStreetMap contributors",
      crossOrigin: true,
      updateWhenIdle: true
    }
  );

  satOverlay = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    {
      name: "Esri Satélite",
      maxZoom: 17,
      opacity: 0.25,
      attribution: "Tiles &copy; Esri",
      crossOrigin: true,
      updateWhenIdle: true
    }
  );

  const pref = readMapPref();

  topoBase.addTo(map);
  const wantSat = (pref.overlay === "Esri Satélite") || (pref.overlay == null);
  if (wantSat) satOverlay.addTo(map);

  map.on("layeradd", syncMapPrefFromCurrentLayers);
  map.on("layerremove", syncMapPrefFromCurrentLayers);
  syncMapPrefFromCurrentLayers();

  // ✅ Eventos que disparan actualización de estadísticas
  map.on("moveend", scheduleStatsUpdate);
  map.on("zoomend", scheduleStatsUpdate);
  map.on("click", onMapClick);

  // ✅ Trigger inicial cuando el mapa esté listo
  map.whenReady(() => {
    setTimeout(() => {
      map.invalidateSize(true);
      scheduleStatsUpdate();
    }, 250);
  });
}

/* ===========================
   Regiones
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

    let c = null;
    try { c = JSON.parse(opt.dataset.center); } catch(_) {}

    let center = null;
    if (Array.isArray(c) && c.length >= 2) {
      center = [Number(c[0]), Number(c[1])];
    }
    if (!center && c && typeof c === "object") {
      const lat = (c.lat ?? c.latitude ?? c.y);
      const lng = (c.lng ?? c.lon ?? c.longitude ?? c.x);
      if (lat != null && lng != null) center = [Number(lat), Number(lng)];
    }

    const zoom = parseInt(opt.dataset.zoom || "7", 10);

    if (center && isFinite(center[0]) && isFinite(center[1])) {
      map.setView(center, zoom, { animate: true });
      setTimeout(() => map.invalidateSize(true), 150);
      // ✅ Trigger stats al cambiar región
      scheduleStatsUpdate();
    } else {
      console.warn("[GeoNEMO] Región sin centro válido:", opt.value, opt.dataset.center);
      toast("⚠️ Esta región no tiene centro (revisa data/regiones.json)", 2400);
    }
  });
}

/* ===========================
   Path helpers
=========================== */
function dirname(path){
  const s = String(path || "");
  const i = s.lastIndexOf("/");
  if (i <= 0) return "";
  return s.slice(0, i + 1);
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

function resolveGroupFileUrl(groupUrl, filePath){
  const f = String(filePath || "");
  if (isAbsUrl(f)) return f;
  const baseDir = dirname(groupUrl);
  return joinPath(baseDir, f);
}

/* ===========================
   Carga MASTER grupos.json
=========================== */
async function loadGroupsMaster(url){
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`No se pudo cargar ${url} (HTTP ${res.status})`);
  const data = await res.json();

  const groups = Array.isArray(data?.groups) ? data.groups : [];
  const out = [];

  for (const g of groups){
    const id = String(g.id || g.group_id || "").trim();
    if (!id) continue;

    const groupName = String(g.label || g.group || g.name || id).trim();

    const filesRaw = Array.isArray(g.files) ? g.files : [];
    const files = filesRaw
      .map(f => resolveGroupFileUrl(url, f))
      .filter(u => /\.geojson$/i.test(u));

    out.push({
      group_id: id,
      group_name: groupName,
      enabled: (g.enabled !== false),
      files
    });
  }

  return out;
}

/* ===========================
   Load GeoJSON por ARCHIVO + index bbox/area
=========================== */
async function ensureFileLoaded(fileUrl){
  // ✅ Cache: no recargamos si ya está en memoria
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

  return st;
}

/* ===========================
   Resumen por grupo (BBOX) -> Tabla
=========================== */
// ✅ Referencias a elementos del DOM
const elGroupBody = document.getElementById("groupSummaryBody");
const elGroupTotN = document.getElementById("groupSummaryTotalN");
const elGroupTotA = document.getElementById("groupSummaryTotalArea");

function renderGroupSummaryTable(rows){
  if (!elGroupBody) return;

  elGroupBody.innerHTML = "";

  // ✅ Si no hay resultados, mostrar 0 (no "—")
  if (!rows || !rows.length){
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 3;
    td.className = "muted";
    td.textContent = "0 grupos con áreas en el BBOX visible";
    tr.appendChild(td);
    elGroupBody.appendChild(tr);
    
    if (elGroupTotN) elGroupTotN.textContent = "0";
    if (elGroupTotA) elGroupTotA.textContent = "0 ha";
    return;
  }

  // Ordenar por #areas desc
  rows.sort((a,b) => (b.count - a.count) || (b.areaM2 - a.areaM2) || String(a.group).localeCompare(String(b.group)));

  let sumN = 0;
  let sumA = 0;

  for (const r of rows){
    sumN += r.count;
    sumA += r.areaM2;

    const tr = document.createElement("tr");

    const tdG = document.createElement("td");
    tdG.textContent = r.group;
    tr.appendChild(tdG);

    const tdN = document.createElement("td");
    tdN.textContent = fmtInt(r.count);
    tr.appendChild(tdN);

    const tdA = document.createElement("td");
    tdA.textContent = fmtArea(r.areaM2);
    tr.appendChild(tdA);

    elGroupBody.appendChild(tr);
  }

  // ✅ Totales siempre muestran números (no "—")
  if (elGroupTotN) elGroupTotN.textContent = fmtInt(sumN);
  if (elGroupTotA) elGroupTotA.textContent = fmtArea(sumA);
}

/* ===========================
   Stats BBOX -> por grupo
=========================== */
// ✅ Debounce usando requestAnimationFrame
let _statsRAF = false;
function scheduleStatsUpdate(){
  if (_statsRAF) return;
  _statsRAF = true;
  requestAnimationFrame(() => {
    _statsRAF = false;
    updateBboxStatsByGroup().catch(err => {
      console.warn("[GeoNEMO] Error en updateBboxStatsByGroup:", err);
      // ✅ En caso de error, mostrar 0 (no dejar vacío)
      renderGroupSummaryTable([]);
    });
  });
}

async function updateBboxStatsByGroup() {
  if (!map) {
    renderGroupSummaryTable([]);
    return;
  }

  if (!assertTurfReady()) {
    renderGroupSummaryTable([]);
    return;
  }

  // ✅ Filtrar solo grupos activos (enabled !== false)
  const activeGroups = (GROUPS || []).filter((g) => g && g.enabled !== false);

  if (!activeGroups.length) {
    renderGroupSummaryTable([]);
    return;
  }

  const b = map.getBounds();
  const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  const bboxPoly = turf.bboxPolygon(bbox);

  const summaryRows = [];

  let grandCount = 0;
  let grandAreaM2 = 0;

  // ✅ Procesar cada grupo
  for (const g of activeGroups) {
    const files = Array.isArray(g.files) ? g.files : [];
    if (!files.length) continue;

    let groupCount = 0;
    let groupAreaM2 = 0;

    for (const fileUrl of files) {
      let st;
      try {
        st = await ensureFileLoaded(fileUrl);
      } catch (e) {
        // ✅ Si falla un archivo, continuar con el resto
        console.warn("[GeoNEMO] error loading:", fileUrl, e);
        continue;
      }

      const idx = st.featuresIndex || [];
      if (!idx.length) continue;

      for (const it of idx) {
        // ✅ Filtro rápido bbox-bbox primero
        if (!bboxIntersects(it.bbox, bbox)) continue;

        // Confirmación geométrica
        let touches = false;
        try {
          touches = turf.booleanIntersects(it.feature, bboxPoly);
        } catch (_) {}
        if (!touches) continue;

        groupCount += 1;

        // ✅ Área: intersección si se puede; fallback área del feature
        try {
          const inter = turf.intersect(it.feature, bboxPoly);
          if (inter) groupAreaM2 += turf.area(inter);
          else groupAreaM2 += Number.isFinite(it.areaM2) ? it.areaM2 : 0;
        } catch (_) {
          groupAreaM2 += Number.isFinite(it.areaM2) ? it.areaM2 : 0;
        }
      }
    }

    // ✅ Solo agregar grupos con resultados > 0
    if (groupCount > 0) {
      summaryRows.push({
        group: g.group_name || g.group_id,
        count: groupCount,
        areaM2: groupAreaM2
      });
      grandCount += groupCount;
      grandAreaM2 += groupAreaM2;
    }
  }

  // ✅ Renderizar tabla
  renderGroupSummaryTable(summaryRows);

  // ✅ Persistencia para mapaout (mantengo compat con tu estructura)
  const prev = loadOut() || {};
  saveOut({
    ...prev,
    updated_at: nowIso(),
    bbox: { west: bbox[0], south: bbox[1], east: bbox[2], north: bbox[3] },
    stats: {
      scope: "all_enabled_groups",
      by_group: summaryRows.map(r => ({
        group_name: r.group,
        areas_bbox: r.count,
        protected_area_m2: r.areaM2,
        protected_area_fmt: fmtArea(r.areaM2)
      })),
      areas_bbox: grandCount,
      protected_area_m2: grandAreaM2,
      protected_area_fmt: fmtArea(grandAreaM2),
    },
  });
}

/* ===========================
   Distancia al perímetro (m)
=========================== */
function distToPerimeterM(feature, pt){
  try{
    const line = turf.polygonToLine(feature);
    let d = turf.pointToLineDistance(pt, line, { units:"meters" });
    if (!isFinite(d)) return Infinity;
    return d;
  } catch(e){
    try{
      const line = turf.polygonToLine(feature);
      const km = turf.pointToLineDistance(pt, line, { units:"kilometers" });
      return isFinite(km) ? km * 1000 : Infinity;
    } catch(_){
      return Infinity;
    }
  }
}

/* ===========================
   Vinculación por GRUPO
=========================== */
async function linkOneGroupToPoint(group, pt, lon, lat){
  const files = group.files || [];
  if (!files.length) {
    return {
      group_id: group.group_id,
      group_name: group.group_name,
      link_type: "none",
      distance_m: null,
      distance_border_m: null,
      source_file: null,
      feature: null
    };
  }

  // 1) inside
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
        const dBorde = distToPerimeterM(f, pt);

        return {
          group_id: group.group_id,
          group_name: group.group_name,
          link_type: "inside",
          distance_m: 0,
          distance_border_m: isFinite(dBorde) ? dBorde : null,
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

  // 2) nearest perimeter
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
      distance_border_m: null,
      source_file: null,
      feature: null
    };
  }

  const dFinal = isFinite(bestD) ? bestD : null;

  return {
    group_id: group.group_id,
    group_name: group.group_name,
    link_type: "nearest_perimeter",
    distance_m: dFinal,
    distance_border_m: dFinal,
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

  const activeGroups = (GROUPS || []).filter(g => g.enabled !== false);
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
        distance_border_m: null,
        source_file: null,
        feature: null
      });
    }
  }

  const insideCount = results.filter(x => x.link_type === "inside").length;
  toast(insideCount ? `✅ Dentro en ${insideCount} grupo(s)` : "📍 Vinculación por proximidad al perímetro", 1600);

  const prev = loadOut() || {};

  // mapaout consume payload.links -> layers
  const legacyLinks = results.map(r => ({
    layer_id: r.group_id,
    layer_name: r.group_name,
    link_type: r.link_type,
    distance_km: isFinite(r.distance_m) ? (r.distance_m / 1000) : null,
    distance_m: r.distance_m ?? null,
    distance_border_m: r.distance_border_m ?? null,
    source_file: r.source_file ?? null,
    feature: r.feature
  }));

  saveOut({
    ...prev,
    created_at: prev.created_at || nowIso(),
    updated_at: nowIso(),
    click: { lat, lng },
    groups: results,
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
        const activeGroups = (GROUPS || []).filter(g => g.enabled !== false);
        for (const g of activeGroups){
          for (const fileUrl of (g.files || [])){
            await ensureFileLoaded(fileUrl);
          }
        }
        toast("⬇️ Archivos precargados", 1400);
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

  try {
    GROUPS = await loadGroupsMaster(GROUPS_URL);
    if (!GROUPS.length) toast("⚠️ No hay grupos cargados", 2600);
    else toast(`✅ Grupos: ${GROUPS.map(g => g.group_name).join(", ")}`, 1600);
  } catch (e) {
    console.error(e);
    toast("⚠️ No pude cargar grupos (ver consola)", 2800);
    GROUPS = [];
  }

  // ✅ Precarga liviana: primer archivo del primer grupo habilitado
  const firstGroup = GROUPS.find(g => g.enabled !== false) || GROUPS[0];
  const firstFile = firstGroup?.files?.[0];
  if (firstFile) ensureFileLoaded(firstFile).catch(() => {});

  // ✅ Trigger inicial de estadísticas
  scheduleStatsUpdate();
  toast("Listo ✅ Mueve/zoom para ver resumen por grupo. Click para abrir MapaOut.", 2200);
})();