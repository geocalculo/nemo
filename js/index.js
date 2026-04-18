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
const HOME_VIEW = { center: [-29.95, -71.25], zoom: 7 };
const VIEWPORT_STORAGE_KEY = "ms:lastViewport:geonemo";
const VIEWPORT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const ENTRY_ZOOM = 10;
const REGION_ZOOM = 10;

const OUT_STORAGE_KEY = "geonemo_out_v2";
const MAP_PREF_KEY = "geonemo_map_pref";
const GROUPS_URL = "capas/grupos.json";

// debug: si true, muestra en consola info detallada de cada paso (carga, stats, click, etc).
const DEBUG_STEP_MODE = false;

let _debugBootstrap = null;
let _debugStep = 0;
// debug: registra info detallada de cada paso, si DEBUG_STEP_MODE=true.

let map;
let userMarker = null;
let clickMarker = null;
let hasShownMapHintFade = false;
let mapHintFadeFallbackTimer = null;
let mapHintFadeAutoHideTimer = null;
let mapHintFadeInteractionBound = false;

let topoBase = null;
let satOverlay = null;
let initialViewport = null;

let incomingViewportApplied = false;
let userViewportInteractionArmed = false;

const USER_LOCATE_ZOOM = 13;

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseIncomingViewport() {
  const params = new URLSearchParams(window.location.search || "");

  const lat = toFiniteNumber(params.get("lat"));
  const lon = toFiniteNumber(params.get("lon") ?? params.get("lng"));
  const zoom = toFiniteNumber(params.get("zoom"));

  const hasValidCoords =
    lat != null && lon != null && zoom != null &&
    lat >= -90 && lat <= 90 &&
    lon >= -180 && lon <= 180 &&
    zoom > 0 && zoom <= 22;

  const bboxRaw = params.get("bbox");
  if (bboxRaw) {
    const parts = bboxRaw.split(",").map(toFiniteNumber);
    if (parts.length === 4 && parts.every((v) => v != null)) {
      // Contrato del ecosistema: north,east,south,west
      const [north, east, south, west] = parts;
      const validNesw =
        north <= 90 && north >= -90 &&
        south <= 90 && south >= -90 &&
        east <= 180 && east >= -180 &&
        west <= 180 && west >= -180 &&
        north > south &&
        east > west;

      if (validNesw) {
        return {
          hasIncomingViewport: true,
          type: "bbox",
          bounds: L.latLngBounds([south, west], [north, east])
        };
      }
    }
  }

  if (hasValidCoords) {
    return {
      hasIncomingViewport: true,
      type: "coords",
      lat,
      lon,
      zoom
    };
  }

  return { hasIncomingViewport: false, type: "default" };
}

function isValidLatLng(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= -90 && lat <= 90 &&
    lng >= -180 && lng <= 180;
}

function isValidStoredBBox(bbox) {
  if (!bbox || typeof bbox !== "object") return false;
  const north = toFiniteNumber(bbox.north);
  const east = toFiniteNumber(bbox.east);
  const south = toFiniteNumber(bbox.south);
  const west = toFiniteNumber(bbox.west);
  if (![north, east, south, west].every((v) => v != null)) return false;
  if (!isValidLatLng(north, east) || !isValidLatLng(south, west)) return false;
  return north > south && east > west;
}

function persistCurrentViewport(mapInstance) {
  if (!mapInstance) return;
  try {
    const bounds = mapInstance.getBounds();
    const payload = {
      bbox: {
        north: bounds.getNorth(),
        east: bounds.getEast(),
        south: bounds.getSouth(),
        west: bounds.getWest()
      },
      timestamp: Date.now()
    };
    localStorage.setItem(VIEWPORT_STORAGE_KEY, JSON.stringify(payload));
  } catch (_) {}
}

function readStoredViewport() {
  try {
    const raw = localStorage.getItem(VIEWPORT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const timestamp = toFiniteNumber(parsed?.timestamp);
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
      localStorage.removeItem(VIEWPORT_STORAGE_KEY);
      return null;
    }
    if ((Date.now() - timestamp) > VIEWPORT_TTL_MS) {
      localStorage.removeItem(VIEWPORT_STORAGE_KEY);
      return null;
    }
    if (!isValidStoredBBox(parsed?.bbox)) {
      localStorage.removeItem(VIEWPORT_STORAGE_KEY);
      return null;
    }
    const { north, east, south, west } = parsed.bbox;
    return {
      type: "bbox",
      bounds: L.latLngBounds([south, west], [north, east])
    };
  } catch (_) {
    try { localStorage.removeItem(VIEWPORT_STORAGE_KEY); } catch (__){}
    return null;
  }
}

function armViewportPersistenceOnUserInteraction(mapInstance) {
  if (!mapInstance) return;
  const mapContainer = mapInstance.getContainer();
  if (!mapContainer) return;

  mapContainer.addEventListener("pointerdown", () => {
    userViewportInteractionArmed = true;
  }, { passive: true });

  mapContainer.addEventListener("wheel", () => {
    userViewportInteractionArmed = true;
  }, { passive: true });

  mapContainer.addEventListener("touchstart", () => {
    userViewportInteractionArmed = true;
  }, { passive: true });
}

async function getFrictionlessInitialCoords() {
  if (!navigator?.geolocation) return null;

  try {
    if (!navigator.permissions?.query) return null;
    const permissionState = await navigator.permissions.query({ name: "geolocation" });
    if (permissionState?.state !== "granted") return null;

    const pos = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 3000,
        maximumAge: 30000
      });
    });

    const lat = toFiniteNumber(pos?.coords?.latitude);
    const lon = toFiniteNumber(pos?.coords?.longitude);
    if (!isValidLatLng(lat, lon)) return null;
    return { type: "coords", lat, lon, zoom: ENTRY_ZOOM };
  } catch (_) {
    return null;
  }
}

async function getIpBasedInitialCoords() {
  let timeoutId = null;
  try {
    const controller = new AbortController();
    timeoutId = window.setTimeout(() => controller.abort(), 3000);
    const res = await fetch("https://ipapi.co/json/", {
      signal: controller.signal,
      cache: "no-store"
    });
    if (!res.ok) return null;
    const data = await res.json();
    const lat = toFiniteNumber(data?.latitude ?? data?.lat);
    const lon = toFiniteNumber(data?.longitude ?? data?.lon ?? data?.lng);
    if (!isValidLatLng(lat, lon)) return null;
    return { type: "coords", lat, lon, zoom: ENTRY_ZOOM };
  } catch (_) {
    return null;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function resolveInitialViewport() {
  const incoming = parseIncomingViewport();
  if (incoming?.hasIncomingViewport) return incoming;

  const stored = readStoredViewport();
  if (stored) return stored;

  const gpsGranted = await getFrictionlessInitialCoords();
  if (gpsGranted) return gpsGranted;

  const ipBased = await getIpBasedInitialCoords();
  if (ipBased) return ipBased;

  return { hasIncomingViewport: false, type: "default" };
}

let _mapResizeRAF = false;

function scheduleMapInvalidateSize() {
  if (!map || _mapResizeRAF) return;
  _mapResizeRAF = true;
  requestAnimationFrame(() => {
    _mapResizeRAF = false;
    try { map.invalidateSize(false); } catch (_) {}
  });
}

function debounce(callback, delayMs) {
  let timerId = null;
  return (...args) => {
    if (timerId) clearTimeout(timerId);
    timerId = window.setTimeout(() => {
      timerId = null;
      callback(...args);
    }, delayMs);
  };
}

function syncMapSize() {
  if (!map) return;
  requestAnimationFrame(() => {
    try { map.invalidateSize(false); } catch (_) {}
  });
}

function attachMapResizeSync() {
  const debouncedSync = debounce(syncMapSize, 120);
  window.addEventListener("load", debouncedSync, { passive: true });
  window.addEventListener("resize", debouncedSync, { passive: true });
  window.addEventListener("orientationchange", debouncedSync, { passive: true });

  const desktopLayoutMedia = window.matchMedia("(max-width: 1199px)");
  if (typeof desktopLayoutMedia.addEventListener === "function") {
    desktopLayoutMedia.addEventListener("change", debouncedSync);
  } else if (typeof desktopLayoutMedia.addListener === "function") {
    desktopLayoutMedia.addListener(debouncedSync);
  }
}

const fileState = new Map();
let GROUPS = [];
const SEARCH_MAX_RESULTS = 12;
const SEARCH_TEXT_KEYS = [
  "nombre", "name", "label", "sitio", "denominacion",
  "categoria", "tipo", "subtipo", "descripcion"
];

let searchState = {
  entries: [],
  dirty: true,
  highlightLayer: null
};

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

function buildCrossSiteUrl(baseUrl) {
  const url = new URL(baseUrl);
  if (!map) return url.toString();

  const center = map.getCenter();
  const zoom = map.getZoom();
  const bounds = map.getBounds();

  const bbox = [
    bounds.getNorth(),
    bounds.getEast(),
    bounds.getSouth(),
    bounds.getWest()
  ].join(",");

  url.searchParams.set("lat", String(center.lat));
  url.searchParams.set("lon", String(center.lng));
  url.searchParams.set("zoom", String(zoom));
  url.searchParams.set("bbox", bbox);
  return url.toString();
}

function goToGeoIPT(e){
  e.preventDefault();

  const base = "https://geoipt.cl/?utm_source=geonemo&utm_medium=card&utm_campaign=cruce_portales&utm_content=geoipt_lateral";
  const url = buildCrossSiteUrl(base);
  window.open(url, "_blank", "noopener");
  return false;
}

function goToGeoEVA(e){
  e.preventDefault();

  const base = "https://geoeva.cl/?utm_source=geonemo&utm_medium=card&utm_campaign=cruce_portales&utm_content=geoeva_lateral";
  const url = buildCrossSiteUrl(base);
  window.open(url, "_blank", "noopener");
  return false;
}

function goToGeoIPTMobile(e){
  e.preventDefault();

  const base = "https://geoipt.cl/?utm_source=geonemo&utm_medium=mobile_bar&utm_campaign=ecosistema";
  const url = buildCrossSiteUrl(base);
  window.open(url, "_blank", "noopener");
  return false;
}

function goToGeoEVAMobile(e){
  e.preventDefault();

  const base = "https://geoeva.cl/?utm_source=geonemo&utm_medium=mobile_bar&utm_campaign=ecosistema";
  const url = buildCrossSiteUrl(base);
  window.open(url, "_blank", "noopener");
  return false;
}

window.goToGeoIPT = goToGeoIPT;
window.goToGeoEVA = goToGeoEVA;
window.goToGeoIPTMobile = goToGeoIPTMobile;
window.goToGeoEVAMobile = goToGeoEVAMobile;

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

function initStatsbarAutoHeight() {
  const root = document.documentElement;
  const stats = document.querySelector(".statsbar");
  if (!stats) return;

  let raf = 0;
  const apply = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      raf = 0;

      const h = Math.ceil(stats.getBoundingClientRect().height);
      const prev = parseInt(getComputedStyle(root).getPropertyValue("--statsbar-h")) || 0;
      if (Math.abs(h - prev) <= 1) return;

      root.style.setProperty("--statsbar-h", `${h}px`);
      scheduleMapInvalidateSize();
    });
  };

  apply();

  if ("ResizeObserver" in window) {
    const ro = new ResizeObserver(() => apply());
    ro.observe(stats);
    window.addEventListener("resize", apply, { passive: true });
    window.__syncStatsbarHeight = apply;
  } else {
    window.addEventListener("resize", apply, { passive: true });
    window.__syncStatsbarHeight = apply;
  }
}

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

document.addEventListener("DOMContentLoaded", () => {
  initStatsbarAutoHeight();
  initTopbarAutoHeight();
});




/* ===========================
   Map init
=========================== */

function applyInitialViewport() {
  if (!map) return false;

  if (applyIncomingViewport(map)) {
    return true;
  }

  if (initialViewport?.type === "bbox" && initialViewport?.bounds) {
    map.fitBounds(initialViewport.bounds, {
      animate: false,
      padding: [20, 20],
      maxZoom: 12
    });
    incomingViewportApplied = false;
    return true;
  }

  if (initialViewport?.type === "coords") {
    map.setView(
      [initialViewport.lat, initialViewport.lon],
      initialViewport.zoom,
      { animate: false }
    );
    incomingViewportApplied = false;
    return true;
  }

  map.setView(HOME_VIEW.center, HOME_VIEW.zoom, { animate: false });
  incomingViewportApplied = false;
  return false;
}

function applyIncomingViewport(mapInstance) {
  if (!mapInstance || !initialViewport?.hasIncomingViewport) return false;

  if (initialViewport?.type === "bbox" && initialViewport?.bounds) {
    mapInstance.fitBounds(initialViewport.bounds, {
      animate: false,
      padding: [20, 20],
      maxZoom: 12
    });
    incomingViewportApplied = true;
    persistCurrentViewport(mapInstance);
    return true;
  }

  if (initialViewport?.type === "coords") {
    mapInstance.setView(
      [initialViewport.lat, initialViewport.lon],
      initialViewport.zoom,
      { animate: false }
    );
    incomingViewportApplied = true;
    persistCurrentViewport(mapInstance);
    return true;
  }

  return false;
}

function resolveBootstrapView(viewport) {
  if (
    viewport?.type === "coords" &&
    isFinite(viewport.lat) &&
    isFinite(viewport.lon) &&
    isFinite(viewport.zoom) &&
    viewport.zoom > 0
  ) {
    return {
      center: [viewport.lat, viewport.lon],
      zoom: viewport.zoom
    };
  }

  if (viewport?.type === "bbox" && viewport?.bounds) {
    const c = viewport.bounds.getCenter();
    return {
      center: [c.lat, c.lng],
      zoom: 7
    };
  }

  return {
    center: HOME_VIEW.center,
    zoom: HOME_VIEW.zoom
  };
}

function showMapHintFade() {
  if (hasShownMapHintFade) return;

  const hint = document.getElementById("map-hint-fade");
  if (!hint) return;

  hasShownMapHintFade = true;
  if (mapHintFadeFallbackTimer) {
    clearTimeout(mapHintFadeFallbackTimer);
    mapHintFadeFallbackTimer = null;
  }

  hint.classList.add("is-visible");

  mapHintFadeAutoHideTimer = setTimeout(() => {
    hideMapHintFade();
  }, 2600);
}

function hideMapHintFade() {
  const hint = document.getElementById("map-hint-fade");
  if (!hint) return;
  hint.classList.remove("is-visible");

  if (mapHintFadeAutoHideTimer) {
    clearTimeout(mapHintFadeAutoHideTimer);
    mapHintFadeAutoHideTimer = null;
  }
}

function bindMapHintDismissOnInteraction(mapInstance) {
  if (!mapInstance || mapHintFadeInteractionBound) return;
  mapHintFadeInteractionBound = true;

  const dismissHint = () => {
    if (!hasShownMapHintFade) return;
    hideMapHintFade();
  };

  mapInstance.on("click", dismissHint);
  mapInstance.on("movestart", dismissHint);
  mapInstance.on("zoomstart", dismissHint);
  mapInstance.on("dragstart", dismissHint);

  const mapContainer = mapInstance.getContainer();
  if (!mapContainer) return;

  mapContainer.addEventListener("wheel", dismissHint, { passive: true });
  mapContainer.addEventListener("touchstart", dismissHint, { passive: true });
  mapContainer.addEventListener("pointerdown", dismissHint, { passive: true });
}

function initMapHintFade(mapInstance, baseLayer) {
  if (!mapInstance) return;

  bindMapHintDismissOnInteraction(mapInstance);

  const showWhenReady = () => {
    if (hasShownMapHintFade) return;

    // Espera al siguiente frame para asegurar que el mapa ya está visible.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        showMapHintFade();
      });
    });
  };

  if (baseLayer?.once) {
    baseLayer.once("load", showWhenReady);
  }

  mapHintFadeFallbackTimer = setTimeout(() => {
    showWhenReady();
  }, 4200);
}


function crearMapa(initialViewport) {
  const bootstrap = resolveBootstrapView(initialViewport);

  map = L.map("map", {
    zoomControl: true,
    preferCanvas: true,
    minZoom: 4,
    maxZoom: 19,
    center: bootstrap.center,
    zoom: bootstrap.zoom
  });
  applyInitialViewport();

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

  topoBase.addTo(map);
  initMapHintFade(map, topoBase);
  addMyLocationControl();

  writeMapPref({
    base: "OpenStreetMap",
    overlay: null,
    overlayOpacity: 0
  });

  map.on("moveend", scheduleStatsUpdate);
  map.on("zoomend", scheduleStatsUpdate);
  map.on("click", onMapClick);

  armViewportPersistenceOnUserInteraction(map);
  const debouncedPersistViewport = debounce(() => {
    if (!userViewportInteractionArmed) return;
    persistCurrentViewport(map);
  }, 500);
  map.on("moveend", debouncedPersistViewport);
}

function centerMapOnUserPosition() {
  if (!navigator.geolocation || !map) {
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

      map.setView([lat, lng], USER_LOCATE_ZOOM, { animate: true });
      persistCurrentViewport(map);

      toast("🎯 Ubicación detectada", 1400);
      setTimeout(() => syncMapSize(), 150);
      scheduleStatsUpdate();
    },
    (err) => {
      console.warn("[GeoNEMO] No pude obtener ubicación:", err);
      toast("⚠️ No pude obtener tu ubicación", 2600);
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  );
}

function addMyLocationControl() {
  if (!map || !L?.Control) return;

  const MyLocationControl = L.Control.extend({
    options: { position: "topleft" },
    onAdd() {
      const container = L.DomUtil.create("div", "leaflet-bar geonemo-locate-control");
      const button = L.DomUtil.create("button", "geonemo-locate-btn", container);
      button.type = "button";
      button.title = "Mi ubicación";
      button.setAttribute("aria-label", "Mi ubicación");
      button.textContent = "📍";

      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.on(button, "click", (ev) => {
        L.DomEvent.preventDefault(ev);
        centerMapOnUserPosition();
      });

      return container;
    }
  });

  map.addControl(new MyLocationControl());
}

/* ===========================
   Auto-center GPS al cargar
=========================== */
function tryAutoCenterOnUser() {
  if (!navigator.geolocation || !map) return;

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;

      if (userMarker) map.removeLayer(userMarker);
      userMarker = L.circleMarker([lat, lng], {
        radius: 7, weight: 2, opacity: 1, fillOpacity: 0.35
      }).addTo(map);

      // Solo centrar automáticamente si NO viene viewport externo.

      if (!incomingViewportApplied) {
        map.setView([lat, lng], ENTRY_ZOOM, { animate: true });
      }

      toast("🎯 Centrado en tu ubicación", 1400);
      setTimeout(() => syncMapSize(), 150);
      scheduleStatsUpdate();
    },
    () => {},
    { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
  );
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

    if (center && isFinite(center[0]) && isFinite(center[1])) {
      // El usuario eligió una región → siempre navegar, sin importar
      // si hay viewport externo.
      map.setView(center, REGION_ZOOM, { animate: true });
      setTimeout(() => syncMapSize(), 150);
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

function normalizeSearchText(value){
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function firstNonEmpty(props, keys){
  if (!props || typeof props !== "object") return "";
  for (const key of keys){
    const val = props[key];
    if (val == null) continue;
    const txt = String(val).trim();
    if (txt) return txt;
  }
  return "";
}

function buildSearchEntry({ group, fileUrl, feature, bbox }) {
  const props = feature?.properties || {};
  const geom = feature?.geometry || {};
  if (!geom?.type) return null;

  const GROUP_DISPLAY_FIELD = {
    SNASPE: "NOMBRE_TOT"
  };

  const preferredNameKeys = [
    "nombre",
    "name",
    "label",
    "sitio",
    "denominacion",
    "nombre_oficial",
    "nom_oficial",
    "nom_sitio",
    "designacion",
    "designación",
    "area_name",
    "nombre_area",
    "NOMBRE",
    "NAME",
    "LABEL",
    "SITIO",
    "DENOMINACION",
    "NOMBRE_OFICIAL",
    "NOM_OFICIAL",
    "NOM_SITIO",
    "DESIGNACION",
    "AREA_NAME",
    "NOMBRE_AREA"
  ];

  const preferredCategoryKeys = [
    "categoria",
    "tipo",
    "subtipo",
    "figura",
    "clase",
    "CATEGORIA",
    "TIPO",
    "SUBTIPO",
    "FIGURA",
    "CLASE",
    "Categoria",
    "Tipo",
    "Subtipo",
    "Figura",
    "Clase"
  ];

  const preferredDescriptionKeys = [
    "descripcion",
    "detalle",
    "observacion",
    "comentario",
    "DESCRIPCION",
    "DETALLE",
    "OBSERVACION",
    "COMENTARIO",
    "Descripcion",
    "Detalle",
    "Observacion",
    "Comentario"
  ];

  // -----------------------------
  // displayName: regla por grupo + heurística
  // -----------------------------
  let displayName = "";

  const preferredField = GROUP_DISPLAY_FIELD[group?.group_id];
  if (preferredField && props?.[preferredField] != null) {
    displayName = String(props[preferredField]).trim();
  }

  if (!displayName) {
    displayName = firstNonEmpty(props, preferredNameKeys);
  }

  if (!displayName) {
    for (const [key, value] of Object.entries(props)) {
      if (value == null) continue;
      const v = String(value).trim();
      if (!v) continue;

      const k = normalizeSearchText(key);
      if (
        k.includes("nombre") ||
        k.includes("name") ||
        k.includes("sitio") ||
        k.includes("denomin") ||
        k.includes("design") ||
        k.includes("area")
      ) {
        displayName = v;
        break;
      }
    }
  }

  if (!displayName) {
    displayName = group?.group_name || group?.group_id || "Sin nombre";
  }

  // -----------------------------
  // category
  // -----------------------------
  let category = firstNonEmpty(props, preferredCategoryKeys);

  if (!category) {
    if (group?.group_id === "SNASPE") category = "SNASPE";
    else category = group?.group_name || group?.group_id || "Sin categoría";
  }

  // -----------------------------
  // description
  // -----------------------------
  const description = firstNonEmpty(props, preferredDescriptionKeys);

  // -----------------------------
  // searchText: TODOS los campos útiles
  // -----------------------------
  const allTexts = [];

  for (const [key, value] of Object.entries(props)) {
    if (value == null) continue;

    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      const t = String(value).trim();
      if (t) allTexts.push(t);
    }
  }

  allTexts.push(
    displayName,
    category,
    description || "",
    group?.group_name || "",
    group?.group_id || ""
  );

  return {
    displayName,
    category,
    description,
    groupName: group?.group_name || group?.group_id || "",
    groupId: group?.group_id || "",
    fileUrl,
    geometryType: geom.type,
    bbox: Array.isArray(bbox) ? bbox : null,
    feature,
    searchText: normalizeSearchText(allTexts.join(" · "))
  };
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
  const st = fileState.get(fileUrl) || { loaded:false, featuresIndex:[], rawFeatures:[] };
  if (st.loaded) return st;

  if (!assertTurfReady()) return st;

  const res = await fetch(fileUrl, { cache:"no-store" });
  if (!res.ok) throw new Error(`No se pudo cargar ${fileUrl} (HTTP ${res.status})`);

  const gj = await res.json();
  const feats = gj.features || [];

  const idx = [];
  const rawFeatures = [];
  for (const f of feats){
    if (!f?.geometry?.type) continue;
    try{
      const bb = turf.bbox(f);
      rawFeatures.push({ feature:f, bbox:bb });

      const t = f.geometry.type;
      if (t === "Polygon" || t === "MultiPolygon"){
        let areaM2 = NaN;
        try{ areaM2 = turf.area(f); } catch(_) {}
        idx.push({ feature:f, bbox:bb, areaM2 });
      }
    } catch(_){}
  }

  st.loaded = true;
  st.featuresIndex = idx;
  st.rawFeatures = rawFeatures;
  fileState.set(fileUrl, st);
  searchState.dirty = true;

  return st;
}

/* ===========================
   Resumen por grupo (BBOX) -> Tabla
=========================== */
const elGroupBody = document.getElementById("groupSummaryBody");
const elGroupTotN = document.getElementById("groupSummaryTotalN");
const elGroupTotA = document.getElementById("groupSummaryTotalArea");

function renderGroupSummaryTable(rows){
  if (!elGroupBody) return;

  elGroupBody.innerHTML = "";

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

  if (elGroupTotN) elGroupTotN.textContent = fmtInt(sumN);
  if (elGroupTotA) elGroupTotA.textContent = fmtArea(sumA);
}

/* ===========================
   Stats BBOX -> por grupo
=========================== */
let _statsRAF = false;
function scheduleStatsUpdate(){
  if (_statsRAF) return;
  _statsRAF = true;
  requestAnimationFrame(() => {
    _statsRAF = false;
    updateBboxStatsByGroup().catch(err => {
      console.warn("[GeoNEMO] Error en updateBboxStatsByGroup:", err);
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
        console.warn("[GeoNEMO] error loading:", fileUrl, e);
        continue;
      }

      const idx = st.featuresIndex || [];
      if (!idx.length) continue;

      for (const it of idx) {
        if (!bboxIntersects(it.bbox, bbox)) continue;

        let touches = false;
        try {
          touches = turf.booleanIntersects(it.feature, bboxPoly);
        } catch (_) {}
        if (!touches) continue;

        groupCount += 1;

        try {
          const inter = turf.intersect(it.feature, bboxPoly);
          if (inter) groupAreaM2 += turf.area(inter);
          else groupAreaM2 += Number.isFinite(it.areaM2) ? it.areaM2 : 0;
        } catch (_) {
          groupAreaM2 += Number.isFinite(it.areaM2) ? it.areaM2 : 0;
        }
      }
    }

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

  renderGroupSummaryTable(summaryRows);

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

function rebuildSearchIndexFromMemory(){
  const activeGroups = (GROUPS || []).filter((g) => g && g.enabled !== false);
  if (!activeGroups.length) {
    searchState.entries = [];
    searchState.dirty = false;
    return;
  }

  const groupByFile = new Map();
  for (const g of activeGroups){
    for (const fileUrl of (g.files || [])){
      if (!groupByFile.has(fileUrl)) groupByFile.set(fileUrl, g);
    }
  }

  const entries = [];
  for (const [fileUrl, group] of groupByFile){
    const st = fileState.get(fileUrl);
    if (!st?.loaded) continue;
    for (const it of (st.rawFeatures || [])){
      const entry = buildSearchEntry({
        group,
        fileUrl,
        feature: it.feature,
        bbox: it.bbox
      });
      if (entry) entries.push(entry);
    }
  }

  searchState.entries = entries;
  searchState.dirty = false;
}

function clearSearchHighlight(){
  if (searchState.highlightLayer && map) {
    map.removeLayer(searchState.highlightLayer);
  }
  searchState.highlightLayer = null;
}

function highlightSearchFeature(feature){
  if (!map || !feature) return;
  clearSearchHighlight();

  const layer = L.geoJSON(feature, {
    style: {
      color: "#16a34a",
      weight: 4,
      opacity: 0.95,
      fillColor: "#bef264",
      fillOpacity: 0.25
    },
    pointToLayer: (_, latlng) => L.circleMarker(latlng, {
      radius: 9,
      color: "#16a34a",
      weight: 3,
      fillColor: "#bef264",
      fillOpacity: 0.45
    })
  }).addTo(map);

  searchState.highlightLayer = layer;
  setTimeout(() => {
    if (searchState.highlightLayer === layer) {
      clearSearchHighlight();
    }
  }, 2200);
}

function focusSearchResult(entry){
  if (!map || !entry?.feature?.geometry?.type) return;

  let bb = entry.bbox;
  try {
    if (!bb) bb = turf.bbox(entry.feature);
  } catch (_) {
    bb = null;
  }
  if (!bb) return;

  const t = entry.feature.geometry.type;
  if (t === "Point" || t === "MultiPoint"){
    const lat = (bb[1] + bb[3]) / 2;
    const lng = (bb[0] + bb[2]) / 2;
    map.setView([lat, lng], Math.max(map.getZoom(), 12), { animate: true });
  } else {
    map.fitBounds([[bb[1], bb[0]], [bb[3], bb[2]]], {
      padding: [30, 30],
      maxZoom: 13,
      animate: true
    });
  }

  highlightSearchFeature(entry.feature);
}

function runInMemorySearch(rawQuery) {
  const q = normalizeSearchText(rawQuery);
  if (!q) return [];

  if (searchState.dirty) rebuildSearchIndexFromMemory();
  if (!searchState.entries.length) return [];

  const queryVariants = new Set([q]);

  // Variantes simples singular/plural
  if (q.length > 3) {
    if (q.endsWith("es")) queryVariants.add(q.slice(0, -2));
    if (q.endsWith("s")) queryVariants.add(q.slice(0, -1));
  }

  const starts = [];
  const wordMatches = [];
  const contains = [];

  for (const entry of searchState.entries) {
    const txt = normalizeSearchText(entry.searchText || "");
    if (!txt) continue;

    const words = txt.split(/\s+/).filter(Boolean);

    let matched = false;
    let matchedAsStart = false;
    let matchedAsWord = false;

    for (const variant of queryVariants) {
      if (!variant) continue;

      if (txt.startsWith(variant)) {
        matched = true;
        matchedAsStart = true;
        break;
      }

      if (words.some((w) => w.startsWith(variant) || w.includes(variant))) {
        matched = true;
        matchedAsWord = true;
        continue;
      }

      if (txt.includes(variant)) {
        matched = true;
      }
    }

    if (!matched) continue;

    if (matchedAsStart) starts.push(entry);
    else if (matchedAsWord) wordMatches.push(entry);
    else contains.push(entry);
  }

  const results = starts.concat(wordMatches, contains);

// Deduplicación
const seen = new Set();
const unique = [];

for (const r of results) {
  const key = `${r.groupId}::${normalizeSearchText(r.displayName)}`;
  if (seen.has(key)) continue;
  seen.add(key);
  unique.push(r);
}

return unique.slice(0, SEARCH_MAX_RESULTS);
}

function bindSearchUI(){
  const input = document.getElementById("mapSearchInput");
  const list = document.getElementById("mapSearchResults");
  if (!input || !list) return;

  const hideResults = () => {
    list.classList.remove("show");
    list.innerHTML = "";
  };

  const renderResults = (results) => {
    list.innerHTML = "";
    if (!results.length) {
      const li = document.createElement("li");
      li.innerHTML = `<button type="button" class="map-search-result-btn" disabled>
        <span class="map-search-result-title">Sin coincidencias</span>
        <span class="map-search-result-meta">Prueba con otro término</span>
      </button>`;
      list.appendChild(li);
      list.classList.add("show");
      return;
    }

    for (const r of results){
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "map-search-result-btn";
      const title = document.createElement("span");
      title.className = "map-search-result-title";
      title.textContent = r.displayName;
      const meta = document.createElement("span");
      meta.className = "map-search-result-meta";
      meta.textContent = `${r.category} · ${r.groupName}`;
      button.appendChild(title);
      button.appendChild(meta);
      button.addEventListener("click", () => {
        focusSearchResult(r);
        hideResults();
        input.value = r.displayName;
      });
      li.appendChild(button);
      list.appendChild(li);
    }
    list.classList.add("show");
  };

  input.addEventListener("input", () => {
    const q = input.value || "";
    if (!q.trim()) {
      hideResults();
      return;
    }
    renderResults(runInMemorySearch(q));
  });

  input.addEventListener("focus", () => {
    if (input.value.trim()) renderResults(runInMemorySearch(input.value));
  });

  document.addEventListener("click", (ev) => {
    const target = ev.target;
    if (!target || (target !== input && !list.contains(target))) {
      hideResults();
    }
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
      // Siempre volver a HOME_VIEW al pulsar Home, sin importar
      // si hay viewport externo.
      map.setView(HOME_VIEW.center, HOME_VIEW.zoom, { animate: true });
      toast("🏠 Vista inicial", 1200);
      setTimeout(() => syncMapSize(), 150);
      scheduleStatsUpdate();
    });
  }

  if (btnOut) btnOut.addEventListener("click", () => openOut());

  if (btnGPS) {
    btnGPS.addEventListener("click", centerMapOnUserPosition);
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

function initMapCursorHint(mapInstance) {
  const hint = document.getElementById("map-hint-cursor");
  if (!hint || !mapInstance) return;

  const isTouch = window.matchMedia("(pointer: coarse)").matches;
  if (isTouch) return;

  const OFFSET_X = 18;
  const OFFSET_Y = -14;

  function moveHint(x, y) {
    hint.style.left = `${x + OFFSET_X}px`;
    hint.style.top = `${y + OFFSET_Y}px`;
  }

  function showHint() {
    hint.style.opacity = "1";
  }

  function hideHint() {
    hint.style.opacity = "0";
  }

  const mapEl = mapInstance.getContainer();
  if (!mapEl) return;

  mapEl.addEventListener("mouseenter", (e) => {
    moveHint(e.clientX, e.clientY);
    showHint();
  });

  mapEl.addEventListener("mousemove", (e) => {
    moveHint(e.clientX, e.clientY);
    showHint();
  });

  mapEl.addEventListener("mouseleave", hideHint);
  mapEl.addEventListener("mousedown", hideHint);
}



/* ===========================
   Init
=========================== */
(async function init() {
  initialViewport = await resolveInitialViewport();

  if (document.readyState === "loading") {
    await new Promise((resolve) =>
      document.addEventListener("DOMContentLoaded", resolve, { once: true })
    );
  }

  bindUI();
  bindSearchUI();

  if (DEBUG_STEP_MODE) {
    debugLog("Debug listo. Pulsa Siguiente.");
    return;
  }

  crearMapa(initialViewport);
  await cargarRegiones();

  try {
    GROUPS = await loadGroupsMaster(GROUPS_URL);
    searchState.dirty = true;
    if (!GROUPS.length) toast("⚠️ No hay grupos cargados", 2600);
    else toast(`✅ Grupos: ${GROUPS.map(g => g.group_name).join(", ")}`, 1600);
  } catch (e) {
    console.error(e);
    toast("⚠️ No pude cargar grupos (ver consola)", 2800);
    GROUPS = [];
  }

  const firstGroup = GROUPS.find(g => g.enabled !== false) || GROUPS[0];
  const firstFile = firstGroup?.files?.[0];
  if (firstFile) ensureFileLoaded(firstFile).catch(() => {});

  scheduleStatsUpdate();
  toast("Listo ✅ Mueve/zoom para ver resumen por grupo. Click para abrir MapaOut.", 2200);
})();
