let map;
let osmLayer;
let satLayer;
let currentBaseLayer;
let currentBasemap = "osm";
let nemoLabelsVisible = false;
let nemoPanelLayers = {};
const NEMO_OSM_COLOR = "#39ff14";
const NEMO_SAT_COLOR = "#fff200";
const NEMO_LAYER_STYLE_BASE = {
  weight: 3,
  opacity: 1,
  fillOpacity: 0.06
};
const SNASPE_RASTER_METADATA_URL = "./capas_panel/snaspe_raster/metadata.json";
const SNASPE_RASTER_FOLDER_URL = "./capas_panel/snaspe_raster/";
const SNASPE_RASTER_GEOTIFF_EXTENSIONS = new Set([".tif", ".tiff"]);
const SNASPE_RASTER_OPACITY = 1.0;
const NEMO_PANEL_LAYER_CONFIG = [
  {
    id: "snaspe",
    visibleName: "SNASPE",
    archivos: [
      "./capas_panel/nemo_snaspe_sub10k.geojson",
      "./capas_panel/snaspe_XL_from_raster_conti.geojson",
      "./capas_panel/snaspe_XL_from_raster_mar.geojson"
    ],
    labelFields: ["NOMBRE_TOT", "NOMBRE_UNI", "nombre", "Nombre", "NOMBRE"],
    labelGroupFields: ["ID_CATASTR", "NOMBRE_TOT"],
    style: { ...NEMO_LAYER_STYLE_BASE }
  },
  {
    id: "ramsar",
    visibleName: "Sitios Ramsar",
    archivo: "./capas_panel/nemo_ramsar_panel.geojson",
    labelFields: ["Nombre", "nombre", "NOMBRE"],
    labelGroupFields: ["Id", "Nombre"],
    style: { ...NEMO_LAYER_STYLE_BASE }
  }
];
let initialCrossAccessState = null;
let selectedPoint = null;
let selectedFeatureContext = null;
const SITE_ID = "geonemo";
const SITE_CONFIG = { initialRegion: "Región de Los Lagos" };
const CROSS_ACCESS_PARAM_NAME = "from";
const CROSS_ACCESS_PARAM_VALUE = "crossaccess";

let viewportRestoreApplied = false;
let initialViewportCompleted = false;
let geoQueryRestoreState = null;

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeBasemap(value) {
  return String(value || "").toLowerCase() === "sat" ? "sat" : "osm";
}

function validLat(value) { return Number.isFinite(value) && value >= -90 && value <= 90; }
function validLon(value) { return Number.isFinite(value) && value >= -180 && value <= 180; }
function validZoom(value) { return Number.isFinite(value) && value >= 0 && value <= 22; }

function getGeoQueryOriginStorageKey(site = SITE_ID) {
  return `geox:${site}:geoquery-origin`;
}

function normalizeGeoQueryOriginState(raw, site = SITE_ID) {
  if (!raw || raw.site !== site) return null;
  const centerLat = toFiniteNumber(raw.map?.centerLat);
  const centerLon = toFiniteNumber(raw.map?.centerLon);
  const zoom = toFiniteNumber(raw.map?.zoom);
  const queryLat = toFiniteNumber(raw.queryPoint?.lat);
  const queryLon = toFiniteNumber(raw.queryPoint?.lon);
  const west = toFiniteNumber(raw.map?.bounds?.west);
  const south = toFiniteNumber(raw.map?.bounds?.south);
  const east = toFiniteNumber(raw.map?.bounds?.east);
  const north = toFiniteNumber(raw.map?.bounds?.north);
  const savedAt = toFiniteNumber(raw.savedAt) || Date.now();
  const maxAgeMs = 12 * 60 * 60 * 1000;
  if (!validLat(centerLat) || !validLon(centerLon) || !validZoom(zoom)) return null;
  if (!validLat(queryLat) || !validLon(queryLon)) return null;
  if (!validLon(west) || !validLon(east) || !validLat(south) || !validLat(north) || !(west < east) || !(south < north)) return null;
  if (Date.now() - savedAt > maxAgeMs) return null;
  return {
    version: 1,
    site,
    source: "geoquery",
    savedAt,
    queryPoint: { lat: queryLat, lon: queryLon },
    map: { centerLat, centerLon, zoom, basemap: normalizeBasemap(raw.map?.basemap), bounds: { west, south, east, north } },
    navigation: { from: raw.navigation?.from || "index", crossAccess: raw.navigation?.crossAccess === true || raw.navigation?.from === "crossaccess" }
  };
}

function readOriginStateFromUrl(site = SITE_ID) {
  const params = new URLSearchParams(window.location.search);
  const finiteParam = (name) => toFiniteNumber(params.get(name));
  const centerLat = finiteParam("mapCenterLat") ?? finiteParam("viewLat");
  const centerLon = finiteParam("mapCenterLon") ?? finiteParam("viewLon");
  const zoom = finiteParam("mapZoom") ?? finiteParam("zoom");
  const queryLat = finiteParam("queryLat") ?? finiteParam("lat");
  const queryLon = finiteParam("queryLon") ?? finiteParam("lon");
  const west = finiteParam("viewWest");
  const south = finiteParam("viewSouth");
  const east = finiteParam("viewEast");
  const north = finiteParam("viewNorth");
  return normalizeGeoQueryOriginState({ version: 1, site, source: "geoquery", savedAt: Date.now(), queryPoint: { lat: queryLat, lon: queryLon }, map: { centerLat, centerLon, zoom, basemap: params.get("basemap"), bounds: { west, south, east, north } }, navigation: { from: params.get("from") || "index", crossAccess: params.get("from") === "crossaccess" || params.get("source") === "crossaccess" } }, site);
}

function readOriginStateFromHistory(site = SITE_ID) {
  return normalizeGeoQueryOriginState(history.state?.geoQueryOrigin, site);
}

function readOriginStateFromSessionStorage(site = SITE_ID) {
  try { return normalizeGeoQueryOriginState(JSON.parse(sessionStorage.getItem(getGeoQueryOriginStorageKey(site)) || "null"), site); }
  catch { return null; }
}

function resolveViewportRestoreState(site = SITE_ID) {
  return readOriginStateFromUrl(site) || readOriginStateFromHistory(site) || readOriginStateFromSessionStorage(site) || null;
}

function captureGeoQueryOriginState({ site = SITE_ID, map, queryLat, queryLon, basemap, from }) {
  const center = map.getCenter();
  const bounds = map.getBounds();
  return normalizeGeoQueryOriginState({ version: 1, site, source: "geoquery", savedAt: Date.now(), queryPoint: { lat: Number(queryLat), lon: Number(queryLon) }, map: { centerLat: center.lat, centerLon: center.lng, zoom: map.getZoom(), basemap, bounds: { west: bounds.getWest(), south: bounds.getSouth(), east: bounds.getEast(), north: bounds.getNorth() } }, navigation: { from: from || "index", crossAccess: from === "crossaccess" } }, site);
}

function persistOriginStateBeforeGeoQuery(originState) {
  if (!originState) return;
  try { sessionStorage.setItem(getGeoQueryOriginStorageKey(originState.site), JSON.stringify(originState)); } catch {}
  const currentUrl = new URL(window.location.href);
  const p = currentUrl.searchParams;
  p.set("mapCenterLat", originState.map.centerLat); p.set("mapCenterLon", originState.map.centerLon); p.set("mapZoom", originState.map.zoom);
  p.set("basemap", originState.map.basemap); p.set("queryLat", originState.queryPoint.lat); p.set("queryLon", originState.queryPoint.lon);
  p.set("viewWest", originState.map.bounds.west); p.set("viewSouth", originState.map.bounds.south); p.set("viewEast", originState.map.bounds.east); p.set("viewNorth", originState.map.bounds.north);
  p.set("restoreViewport", "1"); p.set("from", originState.navigation.crossAccess ? "crossaccess" : "geoquery");
  history.replaceState({ ...(history.state || {}), geoQueryOrigin: originState }, "", currentUrl);
}

function appendOriginStateToGeoQueryUrl(url, originState) {
  const target = new URL(url, window.location.href); const p = target.searchParams;
  p.set("viewLat", originState.map.centerLat); p.set("viewLon", originState.map.centerLon); p.set("mapCenterLat", originState.map.centerLat); p.set("mapCenterLon", originState.map.centerLon);
  p.set("zoom", originState.map.zoom); p.set("mapZoom", originState.map.zoom); p.set("basemap", originState.map.basemap); p.set("queryLat", originState.queryPoint.lat); p.set("queryLon", originState.queryPoint.lon);
  p.set("viewWest", originState.map.bounds.west); p.set("viewSouth", originState.map.bounds.south); p.set("viewEast", originState.map.bounds.east); p.set("viewNorth", originState.map.bounds.north);
  return target.pathname.split('/').pop() === 'geoquery.html' ? `./geoquery/geoquery.html?${p.toString()}` : target.toString();
}

function restoreMapViewport(mapInstance, restoreState) {
  const state = normalizeGeoQueryOriginState(restoreState, SITE_ID); if (!mapInstance || !state) return false;
  if (typeof switchBaseMap === "function") switchBaseMap(state.map.basemap);
  mapInstance.setView([state.map.centerLat, state.map.centerLon], state.map.zoom, { animate: false });
  if (typeof setSelectedPoint === "function") setSelectedPoint(state.queryPoint.lat, state.queryPoint.lon, "geoquery_restore");
  else { selectedPoint = { lat: state.queryPoint.lat, lon: state.queryPoint.lon, source: "geoquery_restore", site: SITE_ID, timestamp: new Date().toISOString() }; window.selectedPoint = selectedPoint; }
  viewportRestoreApplied = true; geoQueryRestoreState = state; return true;
}

function installGeoQueryViewportRestoreHandlers() {
  window.addEventListener("pageshow", (event) => { if (!event.persisted) return; const state = resolveViewportRestoreState(SITE_ID); if (state && map) { restoreMapViewport(map, state); setTimeout(() => map.invalidateSize(false), 0); } });
  window.addEventListener("popstate", (event) => { const state = normalizeGeoQueryOriginState(event.state?.geoQueryOrigin, SITE_ID) || resolveViewportRestoreState(SITE_ID); if (state && map) restoreMapViewport(map, state); });
}

const REGIONES_PATH = "capas_selector/regiones.json";
const GEONEMO_SEARCH_PATH = "./capas_tosearch/geonemo_tosearch_areas.geojson";
const GEONEMO_SEARCH_MAX_RESULTS = 8;
let regionesSelector = [];
let geoNemoSearchIndex = [];
let geoNemoSearchResults = [];
let geoNemoSearchActiveIndex = -1;
let geoNemoSearchMarker = null;
let summaryConfig = null;
let summaryFeaturesByLayer = {};
const LABEL_CAPACITY_CONFIG_PATH = "./capas_panel/label_capacity_config.json";
const DEFAULT_LABEL_CAPACITY_CONFIG = { labels_per_cm2: 2, label_font_height_mm: 4 };
let labelCapacityConfig = { ...DEFAULT_LABEL_CAPACITY_CONFIG };

async function loadLabelDensityConfig() {
  labelCapacityConfig = { ...DEFAULT_LABEL_CAPACITY_CONFIG };

  try {
    const response = await fetch(LABEL_CAPACITY_CONFIG_PATH, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const config = await response.json();
    const labelsPerCm2 = Number(config?.labels_per_cm2);
    const labelFontHeightMm = Number(config?.label_font_height_mm);

    labelCapacityConfig = {
      labels_per_cm2: Number.isFinite(labelsPerCm2) && labelsPerCm2 > 0 ? labelsPerCm2 : DEFAULT_LABEL_CAPACITY_CONFIG.labels_per_cm2,
      label_font_height_mm: Number.isFinite(labelFontHeightMm) && labelFontHeightMm > 0 ? labelFontHeightMm : DEFAULT_LABEL_CAPACITY_CONFIG.label_font_height_mm
    };
  } catch (error) {
    console.warn("[GeoNEMO Labels] label_capacity_config.json no disponible o inválido; usando valores por defecto.", error);
  }

  applyGeoNemoLabelFontSize();
  console.log("[GeoNEMO Labels] labels_per_cm2:", labelCapacityConfig.labels_per_cm2);
  console.log("[GeoNEMO Labels] label_font_height_mm:", labelCapacityConfig.label_font_height_mm);
}

function applyGeoNemoLabelFontSize() {
  if (!document?.documentElement) return;
  document.documentElement.style.setProperty(
    "--geox-label-font-size",
    `${labelCapacityConfig.label_font_height_mm * 3.7795}px`
  );
}

function getLabelDensityMinZoom() {
  return 0;
}

function isCrossAccessNavigationFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return (
    params.get(CROSS_ACCESS_PARAM_NAME) === CROSS_ACCESS_PARAM_VALUE ||
    params.get("source") === CROSS_ACCESS_PARAM_VALUE ||
    params.get("crossAccess") === "1"
  );
}

function getInitialCrossAccessStateFromUrl() {
  if (initialCrossAccessState) return initialCrossAccessState;

  const params = new URLSearchParams(window.location.search);

  const from = params.get("from");
  const lat = parseFloat(params.get("lat"));
  const lon = parseFloat(params.get("lon"));
  const viewLat = parseFloat(params.get("viewLat"));
  const viewLon = parseFloat(params.get("viewLon"));
  const zoom = parseFloat(params.get("zoom"));
  const requestedBasemap = (params.get("basemap") || "osm").toLowerCase();
  const basemap = requestedBasemap === "sat" ? "sat" : "osm";
  const isGeoQueryReturn = from === "geoquery";
  const hasReturnViewport = Number.isFinite(viewLat) && Number.isFinite(viewLon) && Number.isFinite(zoom);
  const hasPointViewport = Number.isFinite(lat) && Number.isFinite(lon) && Number.isFinite(zoom);

  console.log("[GeoX navigation receive]", {
    from,
    lat,
    lon,
    viewLat,
    viewLon,
    zoom,
    basemap
  });

  initialCrossAccessState = {
    viewport: isGeoQueryReturn && hasReturnViewport
      ? { lat: viewLat, lon: viewLon, zoom }
      : hasPointViewport
        ? { lat, lon, zoom }
        : null,
    basemap
  };

  return initialCrossAccessState;
}

function getInitialViewportFromUrl() {
  return getInitialCrossAccessStateFromUrl().viewport;
}

function getInitialBasemapFromUrl() {
  return getInitialCrossAccessStateFromUrl().basemap;
}


let userLocationMarker = null;

function openGeoQueryFromLatLng(lat, lon) {
  if (!map || !Number.isFinite(lat) || !Number.isFinite(lon)) return;

  const center = map.getCenter();
  const bounds = map.getBounds();
  const zoom = map.getZoom();
  const basemap = currentBasemap || "osm";
  const url =
    `./geoquery/geoquery.html?site=${SITE_ID}` +
    `&lat=${encodeURIComponent(lat)}` +
    `&lon=${encodeURIComponent(lon)}` +
    `&viewLat=${encodeURIComponent(center.lat)}` +
    `&viewLon=${encodeURIComponent(center.lng)}` +
    `&viewWest=${encodeURIComponent(bounds.getWest())}` +
    `&viewSouth=${encodeURIComponent(bounds.getSouth())}` +
    `&viewEast=${encodeURIComponent(bounds.getEast())}` +
    `&viewNorth=${encodeURIComponent(bounds.getNorth())}` +
    `&zoom=${encodeURIComponent(zoom)}` +
    `&basemap=${encodeURIComponent(basemap)}` +
    `&from=index`;

  const originState = captureGeoQueryOriginState({ site: SITE_ID, map, queryLat: lat, queryLon: lon, basemap, from: isCrossAccessNavigationFromUrl() ? "crossaccess" : "index" });
  persistOriginStateBeforeGeoQuery(originState);
  window.location.href = appendOriginStateToGeoQueryUrl(url, originState);
}

function captureSelectedPoint(event, featureContext = null) {
  const latlng = event?.latlng || event;
  if (!latlng || !Number.isFinite(latlng.lat) || !Number.isFinite(latlng.lng)) return null;

  if (featureContext && window.L?.DomEvent && event?.originalEvent) {
    L.DomEvent.stopPropagation(event);
  }

  const originalEvent = event?.originalEvent;
  if (featureContext && originalEvent) originalEvent.__geoxFeatureContext = featureContext;

  selectedPoint = {
    lat: latlng.lat,
    lon: latlng.lng,
    source: featureContext ? "layer_click" : "map_click",
    site: SITE_ID,
    timestamp: new Date().toISOString()
  };
  selectedFeatureContext = featureContext || originalEvent?.__geoxFeatureContext || null;
  window.selectedPoint = selectedPoint;
  window.selectedFeatureContext = selectedFeatureContext;

  if (event?.latlng) {
    openGeoQueryFromLatLng(latlng.lat, latlng.lng);
  }

  return selectedPoint;
}

function initGeoQueryClickPropagationGuards() {
  if (!window.L?.DomEvent) return;

  [
    "#control-bar",
    "#territorial-panel",
    "#search-box-wrapper",
    "#mobile-map-controls",
    "#main-footer",
    ".leaflet-control"
  ].forEach((selector) => {
    document.querySelectorAll(selector).forEach((element) => {
      L.DomEvent.disableClickPropagation(element);
    });
  });
}

function getLocationByGps() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Geolocation no disponible"));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        resolve({
          lat: position.coords.latitude,
          lon: position.coords.longitude,
          accuracy: position.coords.accuracy
        });
      },
      (error) => {
        reject(error);
      },
      {
        enableHighAccuracy: true,
        timeout: 8000,
        maximumAge: 60000
      }
    );
  });
}

async function getLocationByIp() {
  try {
    const response = await fetch("https://ipapi.co/json/", {
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error("No se pudo obtener ubicación por IP");
    }

    const data = await response.json();

    const lat = parseFloat(data.latitude);
    const lon = parseFloat(data.longitude);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      throw new Error("IP sin coordenadas válidas");
    }

    return { lat, lon };
  } catch (error) {
    console.warn("GeoX: ubicación por IP no disponible", error);
    return null;
  }
}

function applyUserLocation(mapInstance, location, zoomLevel = 14) {
  if (!mapInstance || !location) return;

  const lat = parseFloat(location.lat);
  const lon = parseFloat(location.lon);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

  mapInstance.setView([lat, lon], zoomLevel);

  if (userLocationMarker) {
    userLocationMarker.setLatLng([lat, lon]);
  } else {
    userLocationMarker = L.marker([lat, lon]).addTo(mapInstance);
  }

  captureSelectedPoint({ lat, lng: lon });
}

async function initGeoXInitialLocation(mapInstance) {
  const incomingViewport = getInitialViewportFromUrl();

  if (incomingViewport) {
    mapInstance.setView(
      [incomingViewport.lat, incomingViewport.lon],
      incomingViewport.zoom
    );
    return;
  }

  try {
    const gpsLocation = await getLocationByGps();

    if (gpsLocation) {
      applyUserLocation(mapInstance, gpsLocation, window.GeoXLocationZoom || 11);
      return;
    }
  } catch (error) {
    console.warn("GeoX: GPS no disponible o no autorizado", error);
  }

  const ipLocation = await getLocationByIp();

  if (ipLocation) {
    applyUserLocation(mapInstance, ipLocation, window.GeoXLocationZoom || 11);
    return;
  }

  console.warn("GeoX: se mantiene ubicación default del sitio");
}

function initGeoXMyLocationButton(mapInstance) {
  const button =
    document.getElementById("my-location-btn") ||
    document.getElementById("locate-btn") ||
    document.getElementById("btn-my-location") ||
    document.querySelector(".my-location-btn") ||
    document.querySelector(".locate-btn") ||
    document.querySelector("[data-action='my-location']");

  if (!button) {
    console.warn("GeoX: botón Mi ubicación no encontrado");
    return;
  }

  button.addEventListener("click", async () => {
    try {
      const gpsLocation = await getLocationByGps();

      if (gpsLocation) {
        applyUserLocation(mapInstance, gpsLocation, window.GeoXLocationZoom || 11);
        return;
      }
    } catch (error) {
      console.warn("GeoX: GPS no disponible desde botón", error);
    }

    const ipLocation = await getLocationByIp();

    if (ipLocation) {
      applyUserLocation(mapInstance, ipLocation, window.GeoXLocationZoom || 11);
      return;
    }

    console.warn("GeoX: no se pudo determinar ubicación");
  });
}

function getGeoXMapInstance() {
  if (window.geoxMap && typeof window.geoxMap.getCenter === "function") {
    return window.geoxMap;
  }

  if (window.map && typeof window.map.getCenter === "function") {
    return window.map;
  }

  return null;
}

function getCurrentMapState() {
  const mapInstance = getGeoXMapInstance();

  if (!mapInstance) {
    console.warn("GeoX: no se encontró instancia Leaflet para capturar estado del mapa.");
    return null;
  }

  const center = mapInstance.getCenter();

  return {
    lat: center.lat,
    lon: center.lng,
    zoom: mapInstance.getZoom(),
    basemap: currentBasemap || "osm"
  };
}

function buildCrossAccessUrl(sitePath) {
  const state = getCurrentMapState();
  const url = new URL(sitePath, window.location.href);
  url.searchParams.set(CROSS_ACCESS_PARAM_NAME, CROSS_ACCESS_PARAM_VALUE);

  if (!state) return url.toString();

  console.log("[GeoX cross_access send]", state);

  url.searchParams.set("lat", state.lat.toFixed(6));
  url.searchParams.set("lon", state.lon.toFixed(6));
  url.searchParams.set("zoom", String(state.zoom));
  url.searchParams.set("basemap", state.basemap);

  return url.toString();
}

function getCurrentViewportParams() {
  const state = getCurrentMapState();

  if (!state) return "";

  const params = new URLSearchParams();
  params.set("lat", state.lat.toFixed(6));
  params.set("lon", state.lon.toFixed(6));
  params.set("zoom", String(state.zoom));
  params.set("basemap", state.basemap);
  params.set(CROSS_ACCESS_PARAM_NAME, CROSS_ACCESS_PARAM_VALUE);

  return params.toString();
}

function isGeoXPortalLink(link) {
  if (!link) return false;

  const href = link.getAttribute("href") || "";
  const target = link.getAttribute("data-geox-target") || "";

  const value = `${href} ${target}`.toLowerCase();

  return (
    value.includes("geoipt") ||
    value.includes("geoeva") ||
    value.includes("geonemo") ||
    value.includes("geonoxa")
  );
}

function initGeoXCrossPortalNavigation() {
  document.addEventListener("click", function (event) {
    const link = event.target.closest("a");

    if (!isGeoXPortalLink(link)) return;

    const rawTarget =
      link.getAttribute("data-geox-target") ||
      link.getAttribute("href");

    if (!rawTarget) return;

    event.preventDefault();

    window.location.href = buildCrossAccessUrl(rawTarget);
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  await loadLabelDensityConfig();
  await iniciarMapa();
  initGeoQueryClickPropagationGuards();
  await cargarRegionesSelector();
  conectarRegionSelector();
  await GeoXViewport.initializeInitialViewport({ map, siteId: SITE_ID, siteConfig: window.geoxSiteConfig, regionSelector: document.getElementById("region-selector"), executeExistingRegionSearch: moverViewportPorRegion, applyBasemap: switchBaseMap });
  initialViewportCompleted = true;
  viewportRestoreApplied = GeoXViewport.readCrossAccessViewport(new URLSearchParams(window.location.search))?.isValid === true;
  conectarBaseMapToggle();
  initGeoNemoDesktopLabelControls();
  initGeoNemoMobileLabelToggle();
  initGeoXMyLocationButton(map);
  initGeoXCrossPortalNavigation();
  initGeoNemoSearch();
});


function normalizeGeoNemoSearchText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function getGeoNemoSearchLabel(props) {
  return [props.nombre_area, props.tipo_area, props.region]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" · ");
}

function getGeoNemoSearchPoint(feature) {
  const props = feature && feature.properties ? feature.properties : {};

  if (feature && feature.geometry && feature.geometry.type === "Point" && Array.isArray(feature.geometry.coordinates)) {
    const lon = Number(feature.geometry.coordinates[0]);
    const lat = Number(feature.geometry.coordinates[1]);
    if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
  }

  const lat = Number(props.lat);
  const lon = Number(props.lon);
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

function getGeoNemoSearchBBox(feature) {
  const props = feature && feature.properties ? feature.properties : {};
  const rawBbox = props.bbox || (feature && feature.bbox);
  let bbox = rawBbox;

  if (typeof rawBbox === "string") {
    try {
      bbox = JSON.parse(rawBbox);
    } catch (error) {
      bbox = rawBbox.split(",").map((value) => value.trim());
    }
  }

  if (!Array.isArray(bbox) || bbox.length !== 4) return null;

  const [minLon, minLat, maxLon, maxLat] = bbox.map(Number);
  if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) return null;
  if (minLon >= maxLon || minLat >= maxLat) return null;

  return { minLon, minLat, maxLon, maxLat };
}

function clearGeoNemoSearchResults() {
  geoNemoSearchResults = [];
  geoNemoSearchActiveIndex = -1;

  const container = document.getElementById("search-results");
  if (!container) return;

  container.innerHTML = "";
  container.hidden = true;
  container.classList.remove("is-open", "is-visible");
}

async function loadGeoNemoSearchIndex() {
  try {
    const response = await fetch(GEONEMO_SEARCH_PATH, { cache: "no-store" });
    if (!response.ok) throw new Error(`No se pudo cargar ${GEONEMO_SEARCH_PATH}`);

    const geojson = await response.json();
    geoNemoSearchIndex = (Array.isArray(geojson.features) ? geojson.features : [])
      .map((feature) => {
        const props = feature.properties || {};
        const label = getGeoNemoSearchLabel(props) || String(props.nombre_busq || props.nombre_area || "Área sin nombre");
        const searchText = normalizeGeoNemoSearchText([
          props.nombre_busq,
          props.nombre_area,
          props.tipo_area,
          props.region,
          props.comuna,
          props.provincia,
          props.territorio,
          props.nombre_unidad,
          props.familia
        ].filter(Boolean).join(" "));

        return { feature, props, label, searchText };
      })
      .filter((item) => item.searchText);

    console.log("[GeoNEMO Search] índice cargado", geoNemoSearchIndex.length);
  } catch (error) {
    geoNemoSearchIndex = [];
    console.warn("[GeoNEMO Search] no se pudo cargar el índice", error);
  }
}

function searchGeoNemoAreas(query) {
  const normalizedQuery = normalizeGeoNemoSearchText(query);
  if (normalizedQuery.length < 2) return [];

  return geoNemoSearchIndex
    .filter((item) => item.searchText.includes(normalizedQuery))
    .slice(0, GEONEMO_SEARCH_MAX_RESULTS);
}

function renderGeoNemoSearchResults(results) {
  const container = document.getElementById("search-results");
  if (!container) return;

  geoNemoSearchResults = results;
  geoNemoSearchActiveIndex = -1;
  container.innerHTML = "";

  if (!results.length) {
    clearGeoNemoSearchResults();
    return;
  }

  results.forEach((item, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "search-result-item";
    button.textContent = item.label;
    button.addEventListener("click", () => selectGeoNemoSearchResult(index));
    container.appendChild(button);
  });

  container.hidden = false;
  container.classList.add("is-open", "is-visible");
}

function selectGeoNemoSearchResult(index) {
  const item = geoNemoSearchResults[index];
  if (!item || !map) return;

  const selectedName = String(item.props.nombre_area || item.label || "").trim();
  console.log("[GeoNEMO Search] resultado seleccionado:", selectedName);

  const input = document.getElementById("search-box");
  if (input) input.value = item.label;
  clearGeoNemoSearchResults();

  const bbox = getGeoNemoSearchBBox(item.feature);
  if (bbox) {
    console.log("[GeoNEMO Search] bbox usado:", bbox.minLon, bbox.minLat, bbox.maxLon, bbox.maxLat);
    const bounds = L.latLngBounds(
      [bbox.minLat, bbox.minLon],
      [bbox.maxLat, bbox.maxLon]
    );

    map.fitBounds(bounds, {
      padding: [40, 40],
      maxZoom: 13
    });
    console.log("[GeoNEMO Search] fitBounds aplicado al área protegida");
  } else {
    const point = getGeoNemoSearchPoint(item.feature);
    console.warn("[GeoNEMO Search] bbox inválido, usando punto central", selectedName);
    if (point) map.setView([point.lat, point.lon], 12);
  }

  const point = getGeoNemoSearchPoint(item.feature);
  if (point) {
    if (geoNemoSearchMarker) {
      geoNemoSearchMarker.setLatLng([point.lat, point.lon]);
    } else {
      geoNemoSearchMarker = L.marker([point.lat, point.lon]).addTo(map);
    }
  }
}

async function initGeoNemoSearch() {
  const input = document.getElementById("search-box");
  const container = document.getElementById("search-results");
  if (!input || !container) return;

  container.hidden = true;
  await loadGeoNemoSearchIndex();

  input.addEventListener("input", () => renderGeoNemoSearchResults(searchGeoNemoAreas(input.value)));
  input.addEventListener("keydown", (event) => {
    if (!geoNemoSearchResults.length) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      geoNemoSearchActiveIndex = Math.min(geoNemoSearchActiveIndex + 1, geoNemoSearchResults.length - 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      geoNemoSearchActiveIndex = Math.max(geoNemoSearchActiveIndex - 1, 0);
    } else if (event.key === "Enter") {
      event.preventDefault();
      selectGeoNemoSearchResult(Math.max(geoNemoSearchActiveIndex, 0));
      return;
    } else if (event.key === "Escape") {
      clearGeoNemoSearchResults();
      return;
    } else {
      return;
    }

    container.querySelectorAll(".search-result-item").forEach((button, index) => {
      button.classList.toggle("is-active", index === geoNemoSearchActiveIndex);
    });
  });

  document.addEventListener("click", (event) => {
    if (!event.target.closest("#search-box-wrapper")) clearGeoNemoSearchResults();
  });
}

async function iniciarMapa() {
  const siteConfig = { ...(await GeoXViewport.loadSiteViewportConfig(SITE_ID)), ...SITE_CONFIG };
  window.GeoXLocationZoom = Number(siteConfig.locationViewport?.fallbackZoom ?? siteConfig.locationViewport?.zoom ?? siteConfig.defaultViewport?.fallbackZoom ?? siteConfig.defaultViewport?.zoom ?? 11);

  geoQueryRestoreState = null;
  map = L.map("map", {
    zoomSnap: siteConfig?.zoomLimits?.snap ?? 0.25,
    zoomDelta: siteConfig?.zoomLimits?.snap ?? 0.25
  });
  window.geoxMap = map;

  osmLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "© OpenStreetMap"
  });

  satLayer = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 19,
    attribution: "Tiles © Esri"
  });

  window.geoxSiteConfig = siteConfig;
  initGeoNEMOSummary(map);
  initGeoNemoPanelLayers(map);
  map.on("click", captureSelectedPoint);
  map.on("moveend zoomend resize", () => applyGeoNemoLabelVisibility());

  L.control.scale({
    imperial: false
  }).addTo(map);
  installGeoQueryViewportRestoreHandlers();
}

async function initGeoNEMOSummary(mapInstance) {
  summaryConfig = await loadSummaryConfig();

  if (!summaryConfig || summaryConfig.activo !== true) {
    console.warn("GeoNEMO summary no activo o no disponible");
    return;
  }

  await loadSummaryLayers(summaryConfig);

  updateGeoNEMOSummary(mapInstance);

  setTimeout(() => updateGeoNEMOSummary(mapInstance), 400);
  setTimeout(() => updateGeoNEMOSummary(mapInstance), 1000);

  mapInstance.on("moveend zoomend", () => {
    updateGeoNEMOSummary(mapInstance);
  });
}

async function loadSummaryConfig() {
  const configPaths = [
    "./parametros/summary_config.json",
    "./capas_summary/summary_config.json"
  ];

  for (const configPath of configPaths) {
    try {
      const configUrl = new URL(configPath, window.location.href).toString();
      const response = await fetch(configUrl, {
        cache: "no-store"
      });

      if (!response.ok) {
        throw new Error(`No se pudo cargar ${configPath}`);
      }

      const config = await response.json();
      console.log("GeoNEMO summary config loaded", configUrl);
      return config;
    } catch (error) {
      console.warn("GeoNEMO: error cargando summary_config.json", configPath, error);
    }
  }

  return null;
}

async function loadSummaryLayers(config) {
  summaryFeaturesByLayer = {};

  for (const capa of config.capas || []) {
    try {
      const layerUrl = new URL(capa.archivo, window.location.href).toString();

      const response = await fetch(layerUrl, {
        cache: "no-store"
      });

      if (!response.ok) {
        throw new Error(`No se pudo cargar ${capa.archivo}`);
      }

      const geojson = await response.json();
      const features = Array.isArray(geojson.features) ? geojson.features : [];

      summaryFeaturesByLayer[capa.id] = features;

      console.log(
        "GeoNEMO summary layer loaded:",
        capa.id,
        features.length,
        layerUrl
      );
    } catch (error) {
      console.warn("GeoNEMO summary layer error:", capa.id, error);
      summaryFeaturesByLayer[capa.id] = [];
    }
  }
}

function getFeatureLatLon(feature) {
  if (
    feature &&
    feature.geometry &&
    feature.geometry.type === "Point" &&
    Array.isArray(feature.geometry.coordinates)
  ) {
    const lon = Number(feature.geometry.coordinates[0]);
    const lat = Number(feature.geometry.coordinates[1]);

    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      return { lat, lon };
    }
  }

  const props = feature.properties || {};
  const lat = Number(props.lat);
  const lon = Number(props.lon);

  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    return { lat, lon };
  }

  const bounds = getFeatureCoordinateBounds(feature);
  if (bounds) {
    return {
      lat: (bounds.minLat + bounds.maxLat) / 2,
      lon: (bounds.minLon + bounds.maxLon) / 2
    };
  }

  return null;
}

function getFeatureCoordinateBounds(feature) {
  const coordinates = feature && feature.geometry && feature.geometry.coordinates;
  if (!Array.isArray(coordinates)) return null;

  const bounds = {
    minLat: Number.POSITIVE_INFINITY,
    maxLat: Number.NEGATIVE_INFINITY,
    minLon: Number.POSITIVE_INFINITY,
    maxLon: Number.NEGATIVE_INFINITY
  };

  const visit = (coords) => {
    if (!Array.isArray(coords)) return;
    if (coords.length >= 2 && typeof coords[0] === "number" && typeof coords[1] === "number") {
      const lon = Number(coords[0]);
      const lat = Number(coords[1]);
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        bounds.minLat = Math.min(bounds.minLat, lat);
        bounds.maxLat = Math.max(bounds.maxLat, lat);
        bounds.minLon = Math.min(bounds.minLon, lon);
        bounds.maxLon = Math.max(bounds.maxLon, lon);
      }
      return;
    }
    coords.forEach(visit);
  };

  visit(coordinates);

  return [bounds.minLat, bounds.maxLat, bounds.minLon, bounds.maxLon].every(Number.isFinite)
    ? bounds
    : null;
}

function getSummaryFeaturesInViewport(mapInstance, layerIds) {
  const bounds = mapInstance.getBounds();
  const result = [];

  (layerIds || []).forEach((layerId) => {
    const features = summaryFeaturesByLayer[layerId] || [];

    features.forEach((feature) => {
      const point = getFeatureLatLon(feature);
      if (!point) return;

      if (bounds.contains(L.latLng(point.lat, point.lon))) {
        result.push(feature);
      }
    });
  });

  return result;
}

const SUMMARY_SUM_FALLBACK_FIELDS = [
  "SUPERFICIE_HA",
  "superficie_ha",
  "AREA_HA",
  "area_ha",
  "SUPERFICIE",
  "superficie"
];

function parseSummaryNumber(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  if (value === null || value === undefined) return 0;

  const raw = String(value).trim();
  if (!raw) return 0;

  const normalized = raw
    .replace(/\s/g, "")
    .replace(/\./g, "")
    .replace(",", ".");

  const n = Number(normalized);
  return Number.isFinite(n) ? n : 0;
}

function formatSummaryNumber(value, indicador = {}) {
  const decimals = Number.isInteger(indicador.decimales)
    ? indicador.decimales
    : 0;

  const formatted = Number(value).toLocaleString("es-CL", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });

  const prefijo = indicador.prefijo ? `${indicador.prefijo} ` : "";
  const sufijo = indicador.sufijo ? ` ${indicador.sufijo}` : "";

  return `${prefijo}${formatted}${sufijo}`;
}

function getPropInsensitive(props, fieldName) {
  if (!props || !fieldName) return undefined;

  if (Object.prototype.hasOwnProperty.call(props, fieldName)) {
    return props[fieldName];
  }

  const target = String(fieldName).toLowerCase();
  const key = Object.keys(props).find(
    (propName) => String(propName).toLowerCase() === target
  );

  return key ? props[key] : undefined;
}

function getSummaryCountKey(feature, indicador = {}) {
  const props = feature && feature.properties ? feature.properties : {};
  const candidateFields = [
    indicador.campo,
    "ID_CATASTR",
    "NOMBRE_TOT",
    "NOMBRE_UNI",
    "SUMMARY_ID",
    "id_catastro",
    "nombre"
  ].filter(Boolean);

  for (const field of candidateFields) {
    const value = getPropInsensitive(props, field);
    if (value !== null && value !== undefined && String(value).trim() !== "") {
      return String(value).trim().toLowerCase();
    }
  }

  return null;
}

function countSummaryFeatures(visibleFeatures, indicador) {
  if (!Array.isArray(visibleFeatures)) return 0;

  if (!indicador.distinct) {
    return visibleFeatures.length;
  }

  const values = new Set();
  let featuresWithoutKey = 0;

  visibleFeatures.forEach((feature) => {
    const key = getSummaryCountKey(feature, indicador);
    if (key) {
      values.add(key);
    } else {
      featuresWithoutKey += 1;
    }
  });

  return values.size + featuresWithoutKey;
}

function hasSummaryField(feature, fieldName) {
  if (!fieldName) return false;
  const props = feature && feature.properties ? feature.properties : {};
  return getPropInsensitive(props, fieldName) !== undefined;
}

function sumSummaryField(features, fieldName) {
  return features.reduce((acc, feature) => {
    const props = feature.properties || {};
    return acc + parseSummaryNumber(getPropInsensitive(props, fieldName));
  }, 0);
}

function getSummaryDistinctKey(feature, indicador = {}) {
  const props = feature && feature.properties ? feature.properties : {};
  const candidateFields = [
    indicador.campo_distinct,
    "ID_CATASTR",
    "NOMBRE_TOT",
    "SUMMARY_ID",
    "nombre"
  ].filter(Boolean);

  for (const field of candidateFields) {
    const value = getPropInsensitive(props, field);
    if (value !== null && value !== undefined && String(value).trim() !== "") {
      return String(value).trim().toLowerCase();
    }
  }

  return null;
}

function getDistinctSummaryFeatures(features, indicador = {}) {
  if (!indicador.distinct && !indicador.distinctSum) return features;

  const seen = new Set();
  const unique = [];

  features.forEach((feature) => {
    const key = getSummaryDistinctKey(feature, indicador);
    if (!key) {
      unique.push(feature);
      return;
    }
    if (seen.has(key)) return;
    seen.add(key);
    unique.push(feature);
  });

  return unique;
}

function getSummarySumFields(indicador) {
  const fields = [];

  if (indicador.campo) {
    fields.push(indicador.campo);
  }

  SUMMARY_SUM_FALLBACK_FIELDS.forEach((fieldName) => {
    if (!fields.includes(fieldName)) {
      fields.push(fieldName);
    }
  });

  return fields;
}

function calculateSummaryIndicator(indicador, features) {
  const operacion = indicador.operacion;

  if (operacion === "count") {
    const resultado = countSummaryFeatures(features, indicador);

    console.log("[GeoNEMO summary count]", indicador.id, {
      totalFeaturesVisibles: features.length,
      campo: indicador.campo,
      distinct: indicador.distinct,
      resultado
    });

    return {
      campo: indicador.campo,
      rawValue: resultado,
      value: formatSummaryNumber(resultado, indicador)
    };
  }

  if (operacion === "sum") {
    const sumFeatures = getDistinctSummaryFeatures(features, indicador);
    let selectedField = indicador.campo;
    let total = selectedField ? sumSummaryField(sumFeatures, selectedField) : 0;
    const configuredFieldExists = selectedField
      ? sumFeatures.some((feature) => hasSummaryField(feature, selectedField))
      : false;

    if (!configuredFieldExists || total === 0) {
      const fallbackField = getSummarySumFields(indicador).find((fieldName) => {
        if (fieldName === selectedField) return false;
        if (!sumFeatures.some((feature) => hasSummaryField(feature, fieldName))) return false;
        return sumSummaryField(sumFeatures, fieldName) !== 0;
      });

      if (fallbackField) {
        selectedField = fallbackField;
        total = sumSummaryField(sumFeatures, fallbackField);
      }
    }

    return {
      campo: selectedField,
      rawValue: total,
      value: formatSummaryNumber(total, indicador)
    };
  }

  return {
    campo: indicador.campo,
    rawValue: null,
    value: "—"
  };
}

function updateGeoNEMOSummary(mapInstance) {
  if (!summaryConfig || !Array.isArray(summaryConfig.indicadores)) return;

  summaryConfig.indicadores.forEach((indicador) => {
    const layerIds = indicador.capas || [];
    const featuresInViewport = getSummaryFeaturesInViewport(mapInstance, layerIds);
    const result = calculateSummaryIndicator(indicador, featuresInViewport);
    const value = result && typeof result === "object" && "value" in result
      ? result.value
      : result;
    const resultado = result && typeof result === "object" && "rawValue" in result
      ? result.rawValue
      : result;
    const campo = result && typeof result === "object" && "campo" in result
      ? result.campo
      : indicador.campo;

    console.log("[GeoNEMO summary]", indicador.id, {
      operacion: indicador.operacion,
      campo,
      totalFeaturesVisibles: featuresInViewport.length,
      resultado
    });

    updateSummaryKpiDom(indicador.id, value, indicador.label);
  });
}

function updateSummaryKpiDom(indicatorId, value, label) {
  const card = document.querySelector(`[data-summary-id="${indicatorId}"]`);

  if (!card) {
    console.warn("GeoNEMO KPI no encontrado:", indicatorId);
    return;
  }

  const valueEl =
    card.querySelector(".kpi-value") ||
    card.querySelector(".summary-value");

  const labelEl =
    card.querySelector(".kpi-label") ||
    card.querySelector(".summary-label");

  if (valueEl) valueEl.textContent = value;
  if (labelEl && label) labelEl.textContent = label;
}

function getGeoNemoBasemapColor() {
  return currentBasemap === "sat" ? NEMO_SAT_COLOR : NEMO_OSM_COLOR;
}

function getGeoNemoLayerStyle(config = {}) {
  const color = getGeoNemoBasemapColor();

  return {
    ...(config.style || {}),
    color,
    fillColor: color,
    weight: 3,
    opacity: 1,
    fillOpacity: 0.06
  };
}

function syncGeoNemoBasemapClass() {
  const target = document.getElementById("map-container") || document.body;
  if (!target) return;

  target.classList.toggle("geonemo-basemap-osm", currentBasemap !== "sat");
  target.classList.toggle("geonemo-basemap-sat", currentBasemap === "sat");
}

function updateGeoNemoPanelLayerStyles() {
  Object.values(nemoPanelLayers).forEach((entry) => {
    if (!entry || !entry.geometryGroup) return;
    entry.geometryGroup.eachLayer((layer) => {
      if (typeof layer.setStyle === "function") {
        layer.setStyle(getGeoNemoLayerStyle(entry.config));
      }
    });
  });
}

function createGeoNemoPanes(mapInstance) {
  if (!mapInstance.getPane("nemo-panel-geometries")) {
    mapInstance.createPane("nemo-panel-geometries");
    mapInstance.getPane("nemo-panel-geometries").style.zIndex = 430;
  }

  if (!mapInstance.getPane("nemo-panel-labels")) {
    mapInstance.createPane("nemo-panel-labels");
    mapInstance.getPane("nemo-panel-labels").style.zIndex = 650;
    mapInstance.getPane("nemo-panel-labels").style.pointerEvents = "none";
  }
}

function getGeoNemoLabelText(feature, fields) {
  const props = feature && feature.properties ? feature.properties : {};

  for (const field of fields || []) {
    const value = getPropInsensitive(props, field);
    if (value !== null && value !== undefined && String(value).trim() !== "") {
      return String(value).trim();
    }
  }

  return "";
}

function getGeoNemoFeatureLabelKey(feature, labelText, layerId) {
  const config = NEMO_PANEL_LAYER_CONFIG.find((layerConfig) => layerConfig.id === layerId) || {};
  const props = feature && feature.properties ? feature.properties : {};
  const candidateFields = [
    ...(config.labelGroupFields || []),
    "SUMMARY_ID",
    "Id",
    "ID"
  ];
  const id = candidateFields
    .map((field) => getPropInsensitive(props, field))
    .find((value) => value !== null && value !== undefined && String(value).trim() !== "") ||
    labelText;

  return `${layerId}:${String(id).trim().toLowerCase()}`;
}

function getGeoNemoLayerBounds(layer) {
  if (!layer || typeof layer.getBounds !== "function") return null;
  const bounds = layer.getBounds();
  return bounds && bounds.isValid() ? bounds : null;
}

function collectGeoNemoLabelRecord(recordsByKey, feature, layer, config) {
  const labelText = getGeoNemoLabelText(feature, config.labelFields);
  if (!labelText) return;

  const labelKey = getGeoNemoFeatureLabelKey(feature, labelText, config.id);
  if (!labelKey) return;

  const bounds = getGeoNemoLayerBounds(layer);
  if (!bounds) return;

  const current = recordsByKey.get(labelKey);
  if (current) {
    current.bounds.extend(bounds);
    current.fragmentCount += 1;
    return;
  }

  recordsByKey.set(labelKey, {
    key: labelKey,
    layerId: config.id,
    labelText,
    bounds: L.latLngBounds(bounds.getSouthWest(), bounds.getNorthEast()),
    fragmentCount: 1
  });
}

function getGeoNemoViewportAnchor(record, viewport) {
  const south = Math.max(record.bounds.getSouth(), viewport.getSouth());
  const north = Math.min(record.bounds.getNorth(), viewport.getNorth());
  const west = Math.max(record.bounds.getWest(), viewport.getWest());
  const east = Math.min(record.bounds.getEast(), viewport.getEast());

  if (south <= north && west <= east) {
    return L.latLngBounds([south, west], [north, east]).getCenter();
  }

  return record.bounds.getCenter();
}

function getGeoNemoVisibleLabelCandidates(entry) {
  if (!map || !entry?.labelRecordsByKey) return [];
  const viewport = map.getBounds();
  const rawRecords = Array.from(entry.labelRecordsByKey.values());
  const visibleRecords = rawRecords.filter((record) => record?.bounds?.isValid?.() && viewport.intersects(record.bounds));

  const debugName = entry.config.id === "snaspe" ? "SNASPE" : entry.config.id === "ramsar" ? "Ramsar" : (entry.config.visibleName || entry.config.id);
  console.log(`[GeoNEMO Labels] ${debugName} candidatos visibles: ${visibleRecords.length}`);
  console.log(`[GeoNEMO Labels] ${debugName} únicos: ${visibleRecords.length}`);

  return visibleRecords.map((record) => ({
    ...record,
    latlng: getGeoNemoViewportAnchor(record, viewport),
    textKey: normalizeGeoNemoSearchText(record.labelText)
  }));
}

function getGeoNemoLabelRect(candidate) {
  const point = map.latLngToContainerPoint(candidate.latlng);
  const fontPx = labelCapacityConfig.label_font_height_mm * 3.7795;
  const width = Math.min(220, Math.max(48, candidate.labelText.length * fontPx * 0.62 + 18));
  const height = Math.max(22, fontPx * 1.15 + 8);
  return { left: point.x - width / 2, right: point.x + width / 2, top: point.y - height / 2, bottom: point.y + height / 2 };
}

function doGeoNemoLabelRectsCollide(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function rebuildGeoNemoControlledLabels() {
  if (!map) return;
  const entries = Object.values(nemoPanelLayers).filter((entry) => entry.labelsVisible);
  const size = map.getSize();
  const cm2PerCell = ((size.x / 96) * 2.54 / 3) * ((size.y / 96) * 2.54 / 3);
  const allSelected = [];

  entries.forEach((entry) => entry.labelGroup.clearLayers());

  const candidates = entries.flatMap(getGeoNemoVisibleLabelCandidates)
    .filter((candidate) => candidate.labelText && map.getBounds().contains(candidate.latlng));

  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      const cellIndex = row * 3 + col + 1;
      const minX = col * size.x / 3;
      const maxX = (col + 1) * size.x / 3;
      const minY = row * size.y / 3;
      const maxY = (row + 1) * size.y / 3;
      const center = L.point((minX + maxX) / 2, (minY + maxY) / 2);
      const cellCandidates = candidates.filter((candidate) => {
        const point = map.latLngToContainerPoint(candidate.latlng);
        return point.x >= minX && point.x < maxX && point.y >= minY && point.y < maxY;
      });
      const maxLabelsCell = cellCandidates.length ? Math.max(1, Math.floor(cm2PerCell * labelCapacityConfig.labels_per_cm2)) : 0;
      const seenText = new Set();
      const selected = cellCandidates
        .map((candidate) => ({
          ...candidate,
          distanceToCellCenter: map.latLngToContainerPoint(candidate.latlng).distanceTo(center)
        }))
        .sort((a, b) => a.distanceToCellCenter - b.distanceToCellCenter || a.key.localeCompare(b.key))
        .filter((candidate) => {
          if (seenText.has(candidate.textKey)) return false;
          seenText.add(candidate.textKey);
          return true;
        })
        .slice(0, maxLabelsCell);

      allSelected.push(...selected);
      console.log(`[GeoNEMO Labels] celda ${cellIndex} | candidatos: ${cellCandidates.length} | max: ${maxLabelsCell} | dibujadas: ${selected.length}`);
    }
  }

  const finalLabels = [];
  const finalTextKeys = new Set();
  allSelected.forEach((candidate) => {
    if (finalTextKeys.has(candidate.textKey)) return;
    const rect = getGeoNemoLabelRect(candidate);
    if (finalLabels.some((accepted) => doGeoNemoLabelRectsCollide(rect, accepted.rect))) return;
    finalTextKeys.add(candidate.textKey);
    finalLabels.push({ ...candidate, rect });
  });

  finalLabels.forEach((candidate) => {
    const entry = nemoPanelLayers[candidate.layerId];
    const marker = createGeoNemoLabelMarkerAtLatLng(candidate.latlng, candidate.labelText);
    if (entry && marker) entry.labelGroup.addLayer(marker);
  });
  console.log(`[GeoNEMO Labels] total etiquetas finales: ${finalLabels.length}`);
}

function captureGeoNemoFeatureContext(layer, feature, config) {
  if (!layer || typeof layer.on !== "function") return;
  const props = feature?.properties || {};
  layer.on("click", (event) => captureSelectedPoint(event, {
    site: SITE_ID,
    layer_id: config?.id || null,
    feature_id: props.id || props.fid || props._src_fid || feature?.id || null,
    feature_name: getGeoNemoLabelText(feature, config?.labelFields) || config?.visibleName || "",
    source_layer: config?.file || config?.id || null
  }));
}


function getSnaspeRasterAttributes(item) {
  return item && typeof item === "object" && item.atributos && typeof item.atributos === "object"
    ? item.atributos
    : {};
}

function getSnaspeRasterLabelText(attributes) {
  const label = getPropInsensitive(attributes, "NOMBRE_TOT") || getPropInsensitive(attributes, "NOMBRE_UNI") || getPropInsensitive(attributes, "nombre") || getPropInsensitive(attributes, "Nombre") || getPropInsensitive(attributes, "NOMBRE");
  return label === null || label === undefined ? "" : String(label).trim();
}

function getSnaspeRasterBounds(item) {
  const candidate = item && (item.bounds || item.bbox || item.extent || item.latLngBounds || item.latlngBounds);
  if (!Array.isArray(candidate)) return null;

  if (candidate.length === 2 && Array.isArray(candidate[0]) && Array.isArray(candidate[1])) {
    return candidate;
  }

  if (candidate.length === 4) {
    const [minX, minY, maxX, maxY] = candidate.map(Number);
    if ([minX, minY, maxX, maxY].every(Number.isFinite)) return [[minY, minX], [maxY, maxX]];
  }

  return null;
}

function getSnaspeRasterLabelLatLng(item) {
  const candidate = item && (item.label_latlng || item.labelLatLng || item.centroide || item.centroid || item.center);
  if (Array.isArray(candidate) && candidate.length >= 2) {
    const lat = Number(candidate[0]);
    const lng = Number(candidate[1]);
    if (Number.isFinite(lat) && Number.isFinite(lng)) return [lat, lng];
  }

  const bounds = getSnaspeRasterBounds(item);
  if (bounds) return L.latLngBounds(bounds).getCenter();
  return null;
}

function createGeoNemoLabelMarkerAtLatLng(latlng, labelText) {
  if (!latlng || !labelText) return null;

  return L.marker(latlng, {
    interactive: false,
    pane: "nemo-panel-labels",
    icon: L.divIcon({
      className: "geonemo-panel-label",
      html: `<span>${escapeHtml(labelText)}</span>`,
      iconSize: null
    })
  });
}

function getFileExtension(filename) {
  const match = String(filename || "").toLowerCase().match(/\.[^.?#/]+(?=$|[?#])/);
  return match ? match[0] : "";
}

function getSnaspeRasterColor() {
  return currentBasemap === "sat" ? "rgba(255, 255, 0, 1)" : "rgba(0, 255, 0, 1)";
}

function getSnaspeRasterNoDataValues(record) {
  if (!record || !record.georaster) return [];

  const candidates = [
    record.georaster.noDataValue,
    record.georaster.nodata,
    record.georaster.noDataValues
  ];

  return candidates
    .flatMap((candidate) => (Array.isArray(candidate) ? candidate : [candidate]))
    .map((candidate) => Number(candidate))
    .filter(Number.isFinite);
}

function getSnaspeRasterPixelColor(values, record) {
  const pixelValues = Array.isArray(values) ? values : [values];
  const noDataValues = getSnaspeRasterNoDataValues(record);

  const hasVisiblePerimeterPixel = pixelValues.some((pixelValue) => {
    if (pixelValue === null || pixelValue === undefined) return false;

    const numericValue = Number(pixelValue);
    if (!Number.isFinite(numericValue)) return false;
    if (numericValue === 0) return false;
    if (noDataValues.includes(numericValue)) return false;

    return true;
  });

  return hasVisiblePerimeterPixel ? getSnaspeRasterColor() : null;
}

function getSnaspeGeoRasterLayerOptions(record) {
  return {
    georaster: record.georaster,
    pane: "nemo-panel-geometries",
    opacity: SNASPE_RASTER_OPACITY,
    resolution: 256,
    pixelValuesToColorFn: (values) => getSnaspeRasterPixelColor(values, record)
  };
}

function encodeSnaspeRasterPath(archivo) {
  return String(archivo || "")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function getSnaspeRasterUrl(archivo) {
  return new URL(`${SNASPE_RASTER_FOLDER_URL}${encodeSnaspeRasterPath(archivo)}`, window.location.href).toString();
}

function getSnaspeRasterLabelLatLngFromGeoraster(georaster) {
  if (!georaster || !window.L) return null;

  const xmin = Number(georaster.xmin);
  const xmax = Number(georaster.xmax);
  const ymin = Number(georaster.ymin);
  const ymax = Number(georaster.ymax);
  if (![xmin, xmax, ymin, ymax].every(Number.isFinite)) return null;

  return L.latLngBounds([[ymin, xmin], [ymax, xmax]]).getCenter();
}

function addSnaspeGeoRasterLayer(record, snaspeEntry) {
  if (!record || !record.georaster || !snaspeEntry || !window.GeoRasterLayer) return null;

  const rasterLayer = new GeoRasterLayer(getSnaspeGeoRasterLayerOptions(record));
  if (typeof rasterLayer.on === "function") {
    rasterLayer.on("click", (event) => captureSelectedPoint(event, {
      site: SITE_ID,
      layer_id: "snaspe",
      feature_id: record.archivo || null,
      feature_name: getSnaspeRasterLabelText(record.attributes) || "",
      source_layer: record.archivo || "snaspe_raster"
    }));
  }

  record.layer = rasterLayer;
  snaspeEntry.geometryGroup.addLayer(rasterLayer);
  console.log("[GeoNEMO Raster] perímetro agregado al mapa", record.archivo);
  return rasterLayer;
}

function rebuildSnaspeRasterLayers() {
  const snaspeEntry = nemoPanelLayers.snaspe;
  if (!snaspeEntry || !Array.isArray(snaspeEntry.rasterRecords)) return;

  snaspeEntry.rasterRecords.forEach((record) => {
    if (!record || !record.georaster) return;
    if (record.layer && snaspeEntry.geometryGroup.hasLayer(record.layer)) {
      snaspeEntry.geometryGroup.removeLayer(record.layer);
    }
    addSnaspeGeoRasterLayer(record, snaspeEntry);
  });
}

async function loadSnaspeGeoTiffRaster(record, snaspeEntry) {
  console.log(`[GeoNEMO Raster] cargando perímetro raster: ${record.archivo}`);

  try {
    const response = await fetch(record.rasterUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const arrayBuffer = await response.arrayBuffer();
    record.georaster = await parseGeoraster(arrayBuffer);
    console.log("[GeoNEMO Raster] parse OK", record.archivo);

    addSnaspeGeoRasterLayer(record, snaspeEntry);

    const labelLatLng = getSnaspeRasterLabelLatLng(record.metadata) || getSnaspeRasterLabelLatLngFromGeoraster(record.georaster);
    if (labelLatLng && record.labelText) {
      const labelKey = getGeoNemoFeatureLabelKey({ properties: record.attributes }, record.labelText, "snaspe");
      const bounds = L.latLngBounds(labelLatLng, labelLatLng);
      const current = snaspeEntry.labelRecordsByKey.get(labelKey);
      if (current) {
        current.bounds.extend(bounds);
        current.fragmentCount += 1;
      } else {
        snaspeEntry.labelRecordsByKey.set(labelKey, {
          key: labelKey,
          layerId: "snaspe",
          labelText: record.labelText,
          bounds,
          fragmentCount: 1
        });
      }
      rebuildGeoNemoControlledLabels();
    }

    return true;
  } catch (error) {
    console.warn(`[GeoNEMO Raster] error cargando archivo ${record.archivo}`, error);
    return false;
  }
}

async function loadSnaspeRasterFolder(mapInstance) {
  const snaspeEntry = nemoPanelLayers.snaspe;
  if (!mapInstance || !snaspeEntry) return;

  if (typeof parseGeoraster !== "function" || !window.GeoRasterLayer) {
    console.warn("[GeoNEMO Raster] error cargando archivo: dependencias georaster/georaster-layer-for-leaflet no disponibles.");
    return;
  }

  let metadata;
  try {
    const metadataUrl = new URL(SNASPE_RASTER_METADATA_URL, window.location.href).toString();
    const response = await fetch(metadataUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    metadata = await response.json();
    console.log("[GeoNEMO Raster] metadata cargado");
  } catch (error) {
    console.warn("[GeoNEMO Raster] metadata.json no disponible; continúa SNASPE vectorial y Ramsar.", error);
    return;
  }

  const entries = metadata && typeof metadata === "object" ? Object.entries(metadata) : [];
  console.log(`[GeoNEMO Raster] total rasters declarados: ${entries.length}`);

  const loadPromises = entries.map(([key, item]) => {
    const archivo = String((item && item.archivo) || key || "").trim();
    if (!archivo) return Promise.resolve(false);

    const extension = getFileExtension(archivo);
    if (!SNASPE_RASTER_GEOTIFF_EXTENSIONS.has(extension)) {
      console.warn(`[GeoNEMO Raster] error cargando archivo ${archivo}: formato no GeoTIFF declarado en metadata.`);
      return Promise.resolve(false);
    }

    const attributes = getSnaspeRasterAttributes(item);
    const record = {
      archivo,
      rasterUrl: getSnaspeRasterUrl(archivo),
      attributes,
      labelText: getSnaspeRasterLabelText(attributes),
      metadata: item,
      georaster: null,
      layer: null,
      labelMarker: null
    };
    snaspeEntry.rasterRecords.push(record);
    return loadSnaspeGeoTiffRaster(record, snaspeEntry);
  });

  const results = await Promise.all(loadPromises);
  const visibleCount = results.filter(Boolean).length;
  console.log(`[GeoNEMO Raster] total visibles: ${visibleCount}`);
}
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function initGeoNemoPanelLayers(mapInstance) {
  if (!mapInstance || !window.L) return;

  createGeoNemoPanes(mapInstance);
  nemoPanelLayers = {};

  await Promise.all(NEMO_PANEL_LAYER_CONFIG.map((config) => loadGeoNemoPanelLayer(mapInstance, config)));
  applyGeoNemoLabelVisibility();
}

async function loadGeoNemoPanelLayer(mapInstance, config) {
  const geometryGroup = L.layerGroup([], { pane: "nemo-panel-geometries" }).addTo(mapInstance);
  const labelGroup = L.layerGroup([], { pane: "nemo-panel-labels" });
  const labelRecordsByKey = new Map();
  nemoPanelLayers[config.id] = { config, geometryGroup, labelGroup, labelRecordsByKey, labelsVisible: false, rasterRecords: [] };

  const archivos = Array.isArray(config.archivos) ? config.archivos : [config.archivo].filter(Boolean);

  await Promise.all(archivos.map(async (archivo) => {
    try {
      const layerUrl = new URL(archivo, window.location.href).toString();
      const response = await fetch(layerUrl, { cache: "no-store" });
      if (!response.ok) throw new Error(`No se pudo cargar ${archivo}`);

      const geojson = await response.json();
      L.geoJSON(geojson, {
        pane: "nemo-panel-geometries",
        style: () => getGeoNemoLayerStyle(config),
        pointToLayer: (feature, latlng) => L.circleMarker(latlng, getGeoNemoLayerStyle(config)),
        onEachFeature: (feature, layer) => {
          geometryGroup.addLayer(layer);
          captureGeoNemoFeatureContext(layer, feature, config);
          collectGeoNemoLabelRecord(labelRecordsByKey, feature, layer, config);
        }
      });

      console.log("GeoNEMO panel layer loaded:", config.id, layerUrl);
    } catch (error) {
      console.warn("GeoNEMO panel layer error:", config.id, archivo, error);
    }
  }));

  rebuildGeoNemoControlledLabels();
}

function applyGeoNemoLabelVisibility(layerId = null, visible = null) {
  Object.values(nemoPanelLayers).forEach((entry) => {
    if (layerId && entry.config.id !== layerId) return;

    const desiredVisibility = visible === null ? entry.labelsVisible : visible;
    const shouldShow = desiredVisibility && map.getZoom() >= getLabelDensityMinZoom(entry.config.id);
    entry.labelsVisible = desiredVisibility;

    if (shouldShow && !map.hasLayer(entry.labelGroup)) {
      rebuildGeoNemoControlledLabels();
      entry.labelGroup.addTo(map);
    }

    if (!shouldShow && map.hasLayer(entry.labelGroup)) {
      map.removeLayer(entry.labelGroup);
    }
  });

  rebuildGeoNemoControlledLabels();

  const entries = Object.values(nemoPanelLayers);
  nemoLabelsVisible = entries.length > 0 && entries.every((entry) => entry.labelsVisible);
  syncGeoNemoLabelControls();
}

function syncGeoNemoLabelControls() {
  NEMO_PANEL_LAYER_CONFIG.forEach((config) => {
    const checkbox = document.querySelector(`[data-nemo-label-toggle="${config.id}"]`);
    if (!checkbox) return;
    checkbox.checked = Boolean(nemoPanelLayers[config.id] && nemoPanelLayers[config.id].labelsVisible);
  });

  syncGeoNemoMobileLabelToggle();
}

function initGeoNemoDesktopLabelControls() {
  document.querySelectorAll("[data-nemo-label-toggle]").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      applyGeoNemoLabelVisibility(checkbox.dataset.nemoLabelToggle, checkbox.checked);
    });
  });
}

// GEOFACTORY SELECTOR REGIÓN
// CARGA regiones.json
async function cargarRegionesSelector() {
  const selector = document.getElementById("region-selector");
  if (!selector) return;

  try {
    const response = await fetch(REGIONES_PATH);
    if (!response.ok) throw new Error(`No se pudo cargar ${REGIONES_PATH}`);

    const data = await response.json();
    regionesSelector = Array.isArray(data)
      ? data.filter((region) => region && region.activo === true)
      : [];

    if (!regionesSelector.length) {
      throw new Error(`${REGIONES_PATH} no contiene regiones activas`);
    }

    selector.innerHTML = "";
    regionesSelector.forEach((region) => {
      const option = document.createElement("option");
      option.value = String(region.codigo_ine || "");
      option.textContent = region.nombre || "Región sin nombre";
      selector.appendChild(option);
    });
  } catch (error) {
    regionesSelector = [];
    console.warn("GEOFACTORY SELECTOR REGIÓN: regiones.json no disponible. Se mantiene el selector actual como respaldo.", error);
  }
}

function conectarRegionSelector() {
  const regionSelector = document.getElementById("region-selector");
  if (!regionSelector) return;

  regionSelector.addEventListener("change", () => moverViewportPorRegion(regionSelector.value));
}

// MOVER VIEWPORT POR REGIÓN
function moverViewportPorRegion(codigoIne) {
  if (!map || !codigoIne || !regionesSelector.length) return;

  const region = regionesSelector.find((item) => String(item.codigo_ine) === String(codigoIne));
  if (!region) return;

  if (Array.isArray(region.bbox) && region.bbox.length === 2) {
    map.fitBounds(region.bbox);
    return;
  }

  if (Array.isArray(region.centro) && region.centro.length === 2) {
    const zoom = Number.isFinite(Number(region.zoom)) ? Number(region.zoom) : map.getZoom();
    map.setView(region.centro, zoom);
  }
}

function conectarBaseMapToggle() {
  const btnOsm = getBaseMapButton("osm");
  const btnSat = getBaseMapButton("sat");

  if (btnOsm) {
    btnOsm.addEventListener("click", () => switchBaseMap("osm"));
  }

  if (btnSat) {
    btnSat.addEventListener("click", () => switchBaseMap("sat"));
  }
}

function getBaseMapButton(type) {
  const explicitSelectors = type === "osm"
    ? ["#btn-osm", "#osmBtn", ".btn-osm", '[data-map="osm"]']
    : ["#btn-sat", "#satBtn", ".btn-sat", '[data-map="sat"]'];

  for (const selector of explicitSelectors) {
    const button = document.querySelector(selector);
    if (button) return button;
  }

  return Array.from(document.querySelectorAll("button")).find(
    (button) => button.textContent.trim().toLowerCase() === type
  );
}

function switchBaseMap(type) {
  if (!map || !osmLayer || !satLayer) return;

  const nextLayer = type === "sat" ? satLayer : osmLayer;
  const previousLayer = type === "sat" ? osmLayer : satLayer;

  if (map.hasLayer(previousLayer)) {
    map.removeLayer(previousLayer);
  }

  if (!map.hasLayer(nextLayer)) {
    nextLayer.addTo(map);
  }

  currentBaseLayer = nextLayer;
  currentBasemap = type === "sat" ? "sat" : "osm";
  setBaseMapToggleActive(currentBasemap);
  syncGeoNemoBasemapClass();
  updateGeoNemoPanelLayerStyles();
  rebuildSnaspeRasterLayers();
  applyGeoNemoLabelVisibility();
}

function setBaseMapToggleActive(type) {
  const btnOsm = getBaseMapButton("osm");
  const btnSat = getBaseMapButton("sat");

  if (btnOsm) {
    btnOsm.classList.toggle("active", type === "osm");
    btnOsm.setAttribute("aria-pressed", String(type === "osm"));
  }

  if (btnSat) {
    btnSat.classList.toggle("active", type === "sat");
    btnSat.setAttribute("aria-pressed", String(type === "sat"));
  }
}


function getMobileLabelEyeIcon(isVisible) {
  if (isVisible) {
    return `<svg class="mobile-layer-toggle-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.9"/></svg>`;
  }
  return `<svg class="mobile-layer-toggle-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 3l18 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M2.5 12s3.5-6 9.5-6c2.1 0 3.9.72 5.36 1.7M21.5 12s-3.5 6-9.5 6c-2.1 0-3.9-.72-5.36-1.7" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><path d="M9.8 9.8A3 3 0 0 1 14.2 14.2" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>`;
}

function syncGeoNemoMobileLabelToggle() {
  const mobileToggle = document.getElementById("mobile-layer-toggle");
  if (!mobileToggle) return;

  mobileToggle.classList.toggle("is-active", nemoLabelsVisible);
  mobileToggle.classList.toggle("is-inactive", !nemoLabelsVisible);
  mobileToggle.setAttribute("aria-pressed", String(nemoLabelsVisible));

  const action = nemoLabelsVisible ? "Ocultar" : "Mostrar";
  const label = `${action} etiquetas GeoNEMO`;
  mobileToggle.setAttribute("aria-label", label);
  mobileToggle.setAttribute("title", label);

  const icon = mobileToggle.querySelector(".mobile-layer-toggle-icon");
  if (icon) icon.innerHTML = getMobileLabelEyeIcon(nemoLabelsVisible);
}

function initGeoNemoMobileLabelToggle() {
  const mobileToggle = document.getElementById("mobile-layer-toggle");
  if (!mobileToggle) return;

  mobileToggle.addEventListener("click", () => {
    const nextVisible = !nemoLabelsVisible;
    NEMO_PANEL_LAYER_CONFIG.forEach((config) => {
      if (nemoPanelLayers[config.id]) nemoPanelLayers[config.id].labelsVisible = nextVisible;
    });
    applyGeoNemoLabelVisibility(null, nextVisible);
  });
  syncGeoNemoMobileLabelToggle();
}

(function initGeoFactoryIntroModal() {
  const MODAL_CONFIG_PATH = "./parametros/log-modal.json";
  const MODAL_CONFIG_FALLBACK_PATH = "./assets/log-modal.json";

  async function loadModalConfig() {
    const response = await fetch(MODAL_CONFIG_PATH);
    if (response.ok) return response.json();

    const fallbackResponse = await fetch(MODAL_CONFIG_FALLBACK_PATH);
    if (!fallbackResponse.ok) throw new Error(`No se pudo cargar ${MODAL_CONFIG_PATH}`);
    return fallbackResponse.json();
  }

  function ensureModalStyles() {
    if (document.getElementById("geofactory-intro-modal-styles")) return;

    const style = document.createElement("style");
    style.id = "geofactory-intro-modal-styles";
    style.textContent = `
      .geofactory-intro-overlay{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;padding:18px;background:rgba(3,7,18,.68)}
      .geofactory-intro-modal{width:min(92vw,560px);max-height:90vh;overflow-y:auto;border-radius:18px;background:#fff;color:#071225;padding:24px;box-shadow:0 28px 80px rgba(0,0,0,.38);text-align:center;font-family:inherit}
      .geofactory-intro-image{display:block;width:100%;max-width:480px;height:auto;margin:0 auto 20px;border-radius:12px}
      .geofactory-intro-actions{display:flex;align-items:center;justify-content:center;gap:18px;flex-wrap:wrap}
      .geofactory-intro-button{border:0;border-radius:12px;padding:14px 26px;background:#071225;color:#fff;font-weight:800;font-size:.95rem;cursor:pointer;box-shadow:0 12px 28px rgba(7,18,37,.22)}
      .geofactory-intro-button:hover{transform:translateY(-1px)}
      .geofactory-intro-button:focus-visible,.geofactory-intro-check input:focus-visible{outline:3px solid rgba(37,99,235,.35);outline-offset:3px}
      .geofactory-intro-check{display:inline-flex;align-items:center;gap:8px;color:#4b5563;font-size:.95rem;cursor:pointer}
      .geofactory-intro-check input{width:16px;height:16px}
      @media(max-width:640px){.geofactory-intro-overlay{padding:12px}.geofactory-intro-modal{width:min(94vw,420px);padding:20px;border-radius:16px}.geofactory-intro-actions{flex-direction:column;gap:12px}.geofactory-intro-button{width:100%}.geofactory-intro-image{max-width:100%;margin-bottom:18px}}
    `;
    document.head.appendChild(style);
  }

  function localStorageHas(storageKey) {
    return Boolean(storageKey && window.localStorage.getItem(storageKey));
  }

  function buildModal(modalIntro) {
    const imageConfig = modalIntro.imagen || {};
    const imageSrc = `${imageConfig.ruta || ""}${imageConfig.archivo || ""}`;
    if (!imageSrc) return null;

    const existingHardcodedOverlay = document.getElementById("geoipt-intro-overlay");
    if (existingHardcodedOverlay) existingHardcodedOverlay.remove();

    const overlay = document.createElement("div");
    overlay.className = "geofactory-intro-overlay";

    const modal = document.createElement("div");
    modal.className = "geofactory-intro-modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-label", "Modal introductorio");

    const image = document.createElement("img");
    image.className = "geofactory-intro-image";
    image.src = imageSrc;
    image.alt = imageConfig.alt || "Instrucciones de uso";

    const actions = document.createElement("div");
    actions.className = "geofactory-intro-actions";

    const button = document.createElement("button");
    button.className = "geofactory-intro-button";
    button.type = "button";
    button.textContent = modalIntro.botonTexto || "Comenzar";

    const label = document.createElement("label");
    label.className = "geofactory-intro-check";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";

    label.append(checkbox, document.createTextNode("No volver a mostrar"));
    actions.append(button, label);
    modal.append(image, actions);
    overlay.appendChild(modal);

    button.addEventListener("click", () => {
      if (checkbox.checked && modalIntro.storageKey) {
        window.localStorage.setItem(modalIntro.storageKey, "true");
      }
      overlay.remove();
    });

    return overlay;
  }

  document.addEventListener("DOMContentLoaded", async () => {
    try {
      if (getInitialViewportFromUrl()) return;
      if (isCrossAccessNavigationFromUrl()) {
        const existingHardcodedOverlay = document.getElementById("geoipt-intro-overlay");
        if (existingHardcodedOverlay) existingHardcodedOverlay.remove();
        return;
      }

      const config = await loadModalConfig();
      const modalIntro = config && config.modalIntro;
      if (!modalIntro || modalIntro.activo !== true || localStorageHas(modalIntro.storageKey)) return;

      ensureModalStyles();
      const modal = buildModal(modalIntro);
      if (modal) document.body.appendChild(modal);
    } catch (error) {
      console.warn("GeoFactory modal inicial no disponible.", error);
    }
  });
})();
