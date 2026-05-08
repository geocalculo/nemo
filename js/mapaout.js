/************************************************************
 * GeoNEMO - mapaout.js
 * Lee localStorage["geonemo_out_v2"], renderiza resultados por grupo
 * con mapas individuales, lazy-draw de geometrías, y formateo inteligente.
 *
 * ✅ Ajustes integrados (Feb-2026):
 * - Resumen humano (versión B) + menciona >300 km
 * - Foco visual en mapas de detalle (pulso + flecha cerca del área)
 * - Para >300 km: NO mapa vacío, solo card con info relevante
 *
 * ✅ Fix Feb-2026 (Superficie universal):
 * - Superficie se calcula de forma robusta para CUALQUIER grupo:
 *   1) Busca campos de superficie/área en properties (cualquier nombre típico)
 *   2) Parsea unidades (km² / km2 / ha / m² / m2 / número sin unidad)
 *   3) Si no hay valor confiable, usa turf.area(feature)
 *
 * ✅ Fix Feb-2026 (Mapa principal monocromático):
 * - Mapa resumen superior: satelital Esri con filtro B/N SOLO en la capa base
 ************************************************************/

const STORAGE_KEY = "geonemo_out_v2";
const MAX_DISTANCE_FOR_DRAW = 300000; // 300 km - más allá no dibujamos geometría
const currentBufferKm = (() => {
  const params = new URLSearchParams(window.location.search);
  const raw = Number(params.get("buffer_km"));
  return Number.isFinite(raw) && raw > 0 ? raw : 5;
})();
const TRACK_DEDUPE_WINDOW_MS = 1200;
const TRACK_SITE = "geonemo";
const _trackEventCache = new Map();
let resultEventSent = false;
const TRACK_DEBUG = new URLSearchParams(window.location.search).has("gtm_debug");

if (TRACK_DEBUG) {
  console.log("[GeoNEMO GTM] mapaout.js cargado con tracking");
}



const HAS_TURF = typeof turf !== "undefined";

function pruneTrackEventCache(nowTs = Date.now()) {
  for (const [key, ts] of _trackEventCache.entries()) {
    if ((nowTs - ts) > TRACK_DEDUPE_WINDOW_MS) {
      _trackEventCache.delete(key);
    }
  }
}

function trackEvent(payload, options = {}) {
  try {
    if (!payload || typeof payload !== "object") return false;
    const eventName = String(payload.event || "").trim();
    if (!eventName) return false;

    const nowTs = Date.now();
    pruneTrackEventCache(nowTs);

    const dedupeKey = options.dedupeKey || `${eventName}:${JSON.stringify(payload)}`;
    if (options.dedupe !== false) {
      const lastTs = _trackEventCache.get(dedupeKey);
      if (lastTs && (nowTs - lastTs) <= TRACK_DEDUPE_WINDOW_MS) {
        return false;
      }
      _trackEventCache.set(dedupeKey, nowTs);
    }

    if (!Array.isArray(window.dataLayer)) {
      window.dataLayer = [];
    }

    if (TRACK_DEBUG) {
      console.log("[GeoNEMO GTM] evento enviado", payload);
    }

    window.dataLayer.push(payload);
    return true;
  } catch (err) {
    console.warn("[GeoNEMO] No se pudo enviar evento GTM:", err);
    return false;
  }
}

window.trackEvent = trackEvent;

function emitResultOpenEventOnce(links = []) {
  if (resultEventSent) return;
  if (!Array.isArray(links) || !links.length) return;

  const validLinks = links.filter((link) => link && typeof link === "object" && link.link_type !== "error");
  if (!validLinks.length) return;

  const groupsInside = validLinks.filter((link) => link.link_type === "inside").length;
  const groupsWithGeometry = validLinks.filter((link) => !!link.feature?.geometry).length;

  let resultType = "none";
  if (groupsInside > 0) resultType = "inside_match";
  else if (groupsWithGeometry > 0) resultType = "nearest_only";

  trackEvent({
    event: "geo_result_open",
    site: TRACK_SITE,
    result_type: resultType,
    groups_total: validLinks.length,
    groups_inside: groupsInside
  }, { dedupeKey: "geo_result_open:initial" });

  resultEventSent = true;
}

function addBasemapSatelliteWithLabels(map, { grayscale = false } = {}) {
  // panes (aisla filtro BN solo al satélite)
  if (!map.getPane("paneSat")) {
    map.createPane("paneSat");
    map.getPane("paneSat").style.zIndex = 200;
  }
  if (!map.getPane("paneLabels")) {
    map.createPane("paneLabels");
    map.getPane("paneLabels").style.zIndex = 350;
    map.getPane("paneLabels").style.pointerEvents = "none";
  }

  // satélite
  L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    {
      pane: "paneSat",
      maxZoom: 19,
      attribution: "Tiles &copy; Esri",
      crossOrigin: true
    }
  ).addTo(map);

  // filtro solo si se pide (mainMap)
  if (grayscale) {
    map.getPane("paneSat").style.filter =
      "grayscale(100%) brightness(1.05) contrast(1.1)";
  } else {
    map.getPane("paneSat").style.filter = "";
  }

  // labels
  L.tileLayer(
    "https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png",
    {
      pane: "paneLabels",
      subdomains: "abcd",
      maxZoom: 20,
      attribution: "© OpenStreetMap © CARTO",
      crossOrigin: true
    }
  ).addTo(map);
}





let mainMap = null;
let pointMarker = null;
let groupMaps = {}; // { groupId: leaflet map instance }
let groupLayers = {}; // { groupId: leaflet layer }
let mainMapBounds = null; // Guardar bounds originales para recentrar

let mainLabelLayers = [];
let mainPulseLayers = [];
let labelsVisible = true;


/* ===========================
   CSS runtime (pulso + flecha)
=========================== */
(function injectFocusCSS() {
  const id = "geonemo-focus-css";
  if (document.getElementById(id)) return;

  const style = document.createElement("style");
  style.id = id;
  style.textContent = `
    /* Marker pulso */
    .geonemo-pulse {
      width: 14px;
      height: 14px;
      border-radius: 999px;
      background: rgba(34,197,94,0.35);
      box-shadow: 0 0 0 0 rgba(34,197,94,0.45);
      animation: geonemoPulse 1.8s infinite;
      border: 2px solid rgba(34,197,94,0.9);
    }
    @keyframes geonemoPulse {
      0%   { transform: scale(0.85); box-shadow: 0 0 0 0 rgba(34,197,94,0.45); opacity: 1; }
      70%  { transform: scale(1.45); box-shadow: 0 0 0 16px rgba(34,197,94,0.0); opacity: 0.2; }
      100% { transform: scale(0.85); box-shadow: 0 0 0 0 rgba(34,197,94,0.0); opacity: 0.0; }
    }
    /* Flecha */
    .geonemo-arrow {
      font-size: 18px;
      line-height: 18px;
      color: rgba(34,197,94,0.95);
      text-shadow: 0 1px 8px rgba(0,0,0,0.25);
      transform: translate(-2px, -18px) rotate(10deg);
      user-select: none;
      pointer-events: none;
    }
  `;
  document.head.appendChild(style);
})();

/* ===========================
   Scroll helpers
=========================== */
window.scrollToGroup = function (index) {
  const card = document.querySelector(`[data-index="${index}"]`);
  if (card) {
    card.scrollIntoView({ behavior: "smooth", block: "start" });
    const bodyId = card.querySelector(".groupHead")?.dataset?.target;
    if (bodyId) {
      const body = document.getElementById(bodyId);
      if (body?.classList.contains("isHidden")) {
        body.classList.remove("isHidden");
        const chevron = card.querySelector(".groupChevron");
        if (chevron) chevron.textContent = "▼";
      }
    }
  }
};

window.scrollToTop = function () {
  window.scrollTo({ top: 0, behavior: "smooth" });
};

window.recenterMainMap = function () {
  if (mainMap && mainMapBounds) {
    mainMap.fitBounds(mainMapBounds, { padding: [40, 40], animate: true });
    toast("🎯 Mapa recentrado", 1200);
  }
};

/* ===========================
   Helpers
=========================== */
function toast(msg, ms = 2500) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), ms);
}

function fmtKm(m) {
  if (!isFinite(m) || m == null) return "—";
  const km = m / 1000;
  return `${km.toFixed(2)} km`;
}

function fmtArea(m2) {
  if (!isFinite(m2) || m2 == null) return "—";
  const ha = m2 / 10000;
  if (ha >= 1000) {
    const km2 = m2 / 1e6;
    return `${km2.toLocaleString("es-CL", { maximumFractionDigits: 1 })} km²`;
  }
  return `${ha.toLocaleString("es-CL", { maximumFractionDigits: 1 })} ha`;
}

function formatKm(value) {
  if (!isFinite(value) || value == null) return "—";
  return `${Number(value).toLocaleString("es-CL", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} km`;
}

function calcDiametroEquivalenteKm(areaKm2) {
  if (!isFinite(areaKm2) || areaKm2 <= 0) return null;
  return 2 * Math.sqrt(areaKm2 / Math.PI);
}

function calcRelacionDistanciaTamano(distanciaKm, diametroKm) {
  if (!isFinite(distanciaKm) || !isFinite(diametroKm) || diametroKm <= 0) return null;
  return distanciaKm / diametroKm;
}

function getInterpretacionEspacial(distanciaKm, isInside) {
  if (isInside || (isFinite(distanciaKm) && distanciaKm === 0)) {
    return "Afectación espacial directa: el punto consultado intersecta el polígono.";
  }
  if (!isFinite(distanciaKm)) return "Interpretación no disponible por falta de distancia.";
  if (distanciaKm <= 1) return "Influencia inmediata: el punto se encuentra a menos de 1 km del área protegida.";
  if (distanciaKm <= 2) return "Influencia cercana: el punto se encuentra dentro del entorno de 2 km.";
  if (distanciaKm <= 5) return "Influencia territorial relevante: el punto se encuentra dentro del entorno de 5 km.";
  if (distanciaKm <= 10) return "Influencia territorial moderada: el punto se encuentra dentro del entorno de 10 km.";
  return "Referencia ambiental lejana: fuera del rango de influencia directa recomendado.";
}

function normalizarRegiones(regionStr) {
  if (!regionStr) return [];
  const separators = /[;,\/]|\s+y\s+/gi;
  const partes = regionStr.split(separators).map((r) => r.trim()).filter(Boolean);
  return partes.map((r) => r.replace(/^Región\s+(de\s+)?/i, "").trim());
}

function getDictamen(linkType, distanceBorderKm) {
  if (linkType === "inside") return { text: "CRÍTICO", class: "critical" };
  if (!isFinite(distanceBorderKm)) return { text: "SIN DATOS", class: "neutral" };
  if (distanceBorderKm <= 1) return { text: "CERCANO", class: "near" };
  if (distanceBorderKm <= 5) return { text: "PROXIMIDAD", class: "prox" };
  return { text: "LEJANO", class: "far" };
}

// Calcular orientación cardinal desde punto a centroide de geometría
function calcularOrientacion(lat1, lng1, lat2, lng2) {
  const dLng = lng2 - lng1;
  const dLat = lat2 - lat1;

  let angulo = (Math.atan2(dLng, dLat) * 180) / Math.PI;
  if (angulo < 0) angulo += 360;

  const direcciones = [
    "N", "NNE", "NE", "ENE",
    "E", "ESE", "SE", "SSE",
    "S", "SSO", "SO", "OSO",
    "O", "ONO", "NO", "NNO",
  ];

  const idx = Math.round(angulo / 22.5) % 16;
  return direcciones[idx];
}

function isVisualizable(link) {
  const d = link?.distance_m;
  return link?.feature && d != null && isFinite(d) && d <= MAX_DISTANCE_FOR_DRAW;
}

function isFar(link) {
  const d = link?.distance_m;
  return link?.feature && d != null && isFinite(d) && d > MAX_DISTANCE_FOR_DRAW;
}

/* ===========================
   SUPERFICIE (UNIVERSAL)
=========================== */

// Normaliza keys para comparar sin tildes/espacios
function normKey(k) {
  return String(k || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

// Parsea un valor (string/number) a m² usando unidades explícitas,
// o heurística si viene sin unidad.
function parseSurfaceToM2(raw) {
  if (raw == null) return null;

  const isNum = typeof raw === "number" && isFinite(raw);
  const s = String(raw).trim();
  if (!s) return null;

  const num = isNum
    ? raw
    : parseFloat(
        s
          .toLowerCase()
          .replace(/\s/g, "")
          .replace(/[^\d.,-]/g, "")
          .replace(",", ".")
      );

  if (!isFinite(num)) return null;

  const sl = s.toLowerCase();

  // Unidades explícitas
  if (sl.includes("km²") || sl.includes("km2") || sl.includes("km^2") || sl.includes("km")) return num * 1e6;
  if (sl.includes("ha") || sl.includes("hect")) return num * 10000;
  if (sl.includes("m²") || sl.includes("m2")) return num;

  // Sin unidades: heurística conservadora
  // - Muchos catastro/ambiental vienen en ha (valores “medianos”).
  // - Si es gigantesco, probablemente ya es m².
  if (num < 5_000_000) return num * 10000; // asume ha
  return num; // asume m²
}

// Elige "mejor" campo de superficie desde properties
function pickSurfaceProp(props) {
  if (!props || typeof props !== "object") return null;

  const entries = Object.entries(props);

  // score por nombre de campo (más alto = más probable)
  const scoreKey = (kNorm) => {
    let s = 0;
    if (kNorm.includes("superficie")) s += 100;
    if (kNorm.includes("area")) s += 60;
    if (kNorm.includes("sup")) s += 40;

    if (kNorm.includes("ha")) s += 25;
    if (kNorm.includes("hect")) s += 25;
    if (kNorm.includes("km2") || kNorm.includes("km")) s += 20;
    if (kNorm.includes("m2")) s += 10;

    // penaliza cosas típicas que NO son superficie
    if (kNorm.includes("areaprotegida") === false && kNorm.includes("areanombre")) s -= 40;
    if (kNorm.includes("length") || kNorm.includes("perim") || kNorm.includes("perimeter")) s -= 40;

    return s;
  };

  let best = null;

  for (const [k, v] of entries) {
    const kn = normKey(k);
    const sc = scoreKey(kn);

    if (sc <= 0) continue;

    // Debe parecer parseable (no texto largo sin números)
    const vStr = String(v ?? "").trim();
    if (!vStr) continue;
    const hasDigit = /[\d]/.test(vStr);
    if (!hasDigit) continue;

    if (!best || sc > best.score) {
      best = { key: k, value: v, score: sc };
    }
  }

  return best; // {key, value, score} | null
}

function computeSurfaceM2(feature) {
  if (!feature) return null;

  const props = feature?.properties || {};
  const picked = pickSurfaceProp(props);

  // 1) usar propiedad si existe y se puede parsear
  if (picked) {
    const m2 = parseSurfaceToM2(picked.value);
    if (m2 != null && isFinite(m2) && m2 > 0) return m2;
  }

  // 2) fallback a área geométrica
  if (HAS_TURF && feature?.geometry) {
    try {
      const m2 = turf.area(feature);
      if (m2 != null && isFinite(m2) && m2 > 0) return m2;
    } catch (e) {}
  }

  return null;
}

function parseLengthToKm(raw) {
  if (raw == null) return null;
  const isNum = typeof raw === "number" && isFinite(raw);
  const s = String(raw).trim();
  if (!s) return null;

  const num = isNum
    ? raw
    : parseFloat(
      s
        .toLowerCase()
        .replace(/\s/g, "")
        .replace(/[^\d.,-]/g, "")
        .replace(",", ".")
    );

  if (!isFinite(num)) return null;
  const sl = s.toLowerCase();
  if (sl.includes("km")) return num;
  if (sl.includes("m")) return num / 1000;

  // Heurística: valores muy grandes suelen venir en metros
  if (num > 2000) return num / 1000;
  return num;
}

function pickPerimeterProp(props) {
  if (!props || typeof props !== "object") return null;
  const entries = Object.entries(props);
  const scoreKey = (kNorm) => {
    let s = 0;
    if (kNorm.includes("perimet")) s += 100;
    if (kNorm.includes("perim")) s += 85;
    if (kNorm.includes("length")) s += 55;
    if (kNorm.includes("longitud")) s += 45;
    if (kNorm.includes("linea")) s += 20;
    return s;
  };
  let best = null;
  for (const [k, v] of entries) {
    const kn = normKey(k);
    const score = scoreKey(kn);
    if (score <= 0) continue;
    if (!/[\d]/.test(String(v ?? ""))) continue;
    if (!best || score > best.score) best = { key: k, value: v, score };
  }
  return best;
}

function computePerimeterKm(feature) {
  if (!feature) return null;
  const props = feature?.properties || {};
  const picked = pickPerimeterProp(props);
  if (picked) {
    const km = parseLengthToKm(picked.value);
    if (isFinite(km) && km > 0) return km;
  }
  if (HAS_TURF && feature?.geometry) {
    try {
      if (typeof turf.polygonToLine === "function" && typeof turf.length === "function") {
        const line = turf.polygonToLine(feature);
        const km = turf.length(line, { units: "kilometers" });
        if (isFinite(km) && km > 0) return km;
      }
    } catch (_) {}
  }
  return null;
}

function getCentroideInfo(feature) {
  if (!feature) return null;
  const props = feature?.properties || {};
  const latProp = props.CENTROIDE_LAT ?? props.centroide_lat ?? props.lat_centroid ?? props.centroid_lat;
  const lngProp = props.CENTROIDE_LON ?? props.CENTROIDE_LNG ?? props.centroide_lon ?? props.centroide_lng ?? props.lng_centroid ?? props.centroid_lng;
  const latN = latProp != null ? Number(latProp) : NaN;
  const lngN = lngProp != null ? Number(lngProp) : NaN;

  if (isFinite(latN) && isFinite(lngN)) return { lat: latN, lng: lngN };
  if (HAS_TURF && feature?.geometry) {
    try {
      const c = turf.centroid(feature);
      const [lng, lat] = c.geometry.coordinates;
      if (isFinite(lat) && isFinite(lng)) return { lat, lng };
    } catch (_) {}
  }
  return null;
}

function getCentroidDistanceKm(feature, clickLat, clickLng) {
  if (!HAS_TURF || !feature?.geometry || !isFinite(clickLat) || !isFinite(clickLng)) return null;
  try {
    const centroid = turf.centroid(feature);
    const poi = turf.point([clickLng, clickLat]);
    const km = turf.distance(poi, centroid, { units: "kilometers" });
    return isFinite(km) ? km : null;
  } catch (_) {
    return null;
  }
}

/* ===========================
   Focus marker (pulso + flecha) en mapas de detalle
=========================== */
function addFocusMarker(map, featureOrLayer) {
  if (!map) return;

  let latlng = null;

  // Preferimos Turf centroid si existe
  if (HAS_TURF && featureOrLayer && featureOrLayer.type) {
    try {
      const c = turf.centroid(featureOrLayer);
      const [lng, lat] = c.geometry.coordinates;
      latlng = L.latLng(lat, lng);
    } catch (e) {}
  }

  // Fallback: bounds center del layer Leaflet
  if (!latlng && featureOrLayer && typeof featureOrLayer.getBounds === "function") {
    try {
      latlng = featureOrLayer.getBounds().getCenter();
    } catch (e) {}
  }

  if (!latlng) return;

  // Pulso (divIcon)
  const pulseIcon = L.divIcon({
    className: "",
    html: `<div class="geonemo-pulse"></div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });

  L.marker(latlng, { icon: pulseIcon, interactive: false }).addTo(map);

  // Flecha (divIcon)
  const arrowIcon = L.divIcon({
    className: "",
    html: `<div class="geonemo-arrow">➤</div>`,
    iconSize: [18, 18],
    iconAnchor: [6, 10],
  });

  L.marker(latlng, { icon: arrowIcon, interactive: false }).addTo(map);
}

/* ===========================
   Mapa principal (punto + geometrías resumen)
   ✅ Satelital Esri en Blanco y Negro (solo base tiles)
=========================== */
function applyMainMapMonochrome(mainMapInstance) {
  try {
    const container = mainMapInstance?.getContainer?.();
    if (!container) return;

    // Leaflet separa panes; filtramos SOLO tile-pane (base raster)
    const tilePane = container.querySelector(".leaflet-pane.leaflet-tile-pane");
    if (!tilePane) return;

    // B/N + un poco de contraste/brillo para legibilidad
    tilePane.style.filter = "grayscale(100%) contrast(1.08) brightness(1.05)";
    tilePane.style.webkitFilter = tilePane.style.filter;
  } catch (_) {}
}

function addPulsingPerimeter(map, feature, bufferMeters = 250) {
  if (!map || !feature) return null;

  let outline = feature;

  // Buffer chico para que el perímetro se note (si hay Turf)
  if (HAS_TURF && turf?.buffer) {
    try {
      outline = turf.buffer(feature, bufferMeters, { units: "meters" });
    } catch (_) {
      outline = feature;
    }
  }

  const layer = L.geoJSON(outline, {
    style: () => ({
      className: "pulse-perimeter",
      // dejamos valores base por si el browser no aplica CSS:
      color: "#bef264",
      weight: 5,
      fillOpacity: 0,
      opacity: 0.95
    }),
    interactive: false
  }).addTo(map);

  return layer;
}

function addGroupLabel(map, feature, text) {
  if (!HAS_TURF || !feature || !text) return null;
  try {
    const c = turf.centroid(feature);
    const [lng, lat] = c.geometry.coordinates;
    const tip = L.tooltip({
      permanent: true,
      direction: "center",
      className: "groupTag"
    })
      .setLatLng([lat, lng])
      .setContent(text);
    tip.addTo(map);
    return tip;
  } catch {
    return null;
  }
}

window.toggleMainLabels = function () {
  labelsVisible = !labelsVisible;
  mainLabelLayers.forEach(l =>
    labelsVisible ? l.addTo(mainMap) : mainMap.removeLayer(l)
  );
};


function initMainMap(lat, lng, links) {
  mainLabelLayers = [];
  mainPulseLayers = [];

  mainMap = L.map("map", { zoomControl: true, preferCanvas: true })
    .setView([lat, lng], 12);

  // Panes para controlar BN SOLO en el satélite (sin afectar labels)
  mainMap.createPane("paneSat");
  mainMap.getPane("paneSat").style.zIndex = 200;

  mainMap.createPane("paneLabels");
  mainMap.getPane("paneLabels").style.zIndex = 350;
  mainMap.getPane("paneLabels").style.pointerEvents = "none";

  // Satélite (Esri) en paneSat
  L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    {
      pane: "paneSat",
      maxZoom: 19,
      attribution: "Tiles &copy; Esri",
      crossOrigin: true
    }
  ).addTo(mainMap);

  // Monocromo SOLO al satélite del mapa resumen
  mainMap.getPane("paneSat").style.filter =
    "grayscale(100%) brightness(1.05) contrast(1.1)";

  // Labels livianos (Carto) en paneLabels
  L.tileLayer(
    "https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png",
    {
      pane: "paneLabels",
      subdomains: "abcd",
      maxZoom: 20,
      attribution: "© OpenStreetMap © CARTO",
      crossOrigin: true
    }
  ).addTo(mainMap);

  // Punto consultado
  pointMarker = L.circleMarker([lat, lng], {
    radius: 8,
    weight: 3,
    color: "#65a30d",
    fillColor: "#bef264",
    fillOpacity: 0.85,
    zIndexOffset: 1000
  }).addTo(mainMap);

  pointMarker.bindTooltip("📍 Punto consultado", { direction: "top" });

  // ✅ Bounds master (robusto): parte vacío y FORZAMOS incluir POI
  const bounds = L.latLngBounds([]);
  bounds.extend([lat, lng]);

  links.forEach((link, idx) => {
    const { feature, distance_m } = link;
    if (!feature || !isFinite(distance_m) || distance_m > MAX_DISTANCE_FOR_DRAW) return;

    let color = "#22c55e";
    let fillOpacity = 0.14;

    if (link.link_type === "inside") {
      fillOpacity = 0.22;
    } else if (link.link_type === "nearest_perimeter") {
      color = "#f59e0b";
    }

    const poly = L.geoJSON(feature, {
      style: { color, weight: 2, fillColor: color, fillOpacity }
    }).addTo(mainMap);

    try { bounds.extend(poly.getBounds()); } catch (e) {}

    const pulse = addPulsingPerimeter(mainMap, feature, 250);
    if (pulse) {
      mainPulseLayers.push(pulse);
      try { bounds.extend(pulse.getBounds()); } catch (e) {}
    }

    const labelText = link.layer_id;
    const tag = addGroupLabel(mainMap, feature, labelText);
    if (tag) mainLabelLayers.push(tag);

    const data = extractGroupData(link);
    const dictamen = getDictamen(link.link_type, isFinite(link.distance_border_m) ? (link.distance_border_m / 1000) : null);
    const distKm = isFinite(link.distance_border_m) ? fmtKm(link.distance_border_m) : fmtKm(distance_m);

    poly.bindPopup(`
      <div style="min-width:180px;">
        <div style="font-weight:600;">${labelText}</div>
        <div style="opacity:.85;margin:4px 0;">${data.nombre}</div>
        <div style="display:flex;gap:6px;align-items:center;">
          <span class="badgeMini ${dictamen.class}">${dictamen.text}</span>
          <span>${link.link_type === "inside" ? "0 km" : distKm}</span>
        </div>
        <button
          onclick="scrollToGroup(${idx})"
          class="btnSm btn--primary"
          style="width:100%;margin-top:6px;"
        >↓ Ver detalle</button>
      </div>
    `);
  });

  // ✅ Fit final + guardar bounds como COPIA (para que recenter incluya POI)
  const finalBounds = L.latLngBounds(bounds.getSouthWest(), bounds.getNorthEast());
  mainMap.fitBounds(finalBounds, { padding: [40, 40], maxZoom: 13 });
  mainMapBounds = finalBounds;

  setTimeout(() => mainMap.invalidateSize(true), 100);
}





/* ===========================
   Generar resumen humano (B) + menciona >300 km
=========================== */
function generarResumenAreas(lat, lng, links) {
  const resumenEl = document.getElementById("resumenAreas");
  if (!resumenEl) return;

  const near = links.filter(isVisualizable);
  const far = links.filter(isFar);

  near.sort((a, b) => {
    if (a.link_type === "inside" && b.link_type !== "inside") return -1;
    if (b.link_type === "inside" && a.link_type !== "inside") return 1;
    return (a.distance_m ?? Infinity) - (b.distance_m ?? Infinity);
  });

  const pickPhrase = (link) => {
    const data = extractGroupData(link);
    const grupoNombre = link.layer_name || link.layer_id;
    const areaNombre = data.nombre !== "—" ? data.nombre : "área sin nombre";
    const isInside = link.link_type === "inside";

    let orientacion = null;
    if (!isInside && HAS_TURF && link.feature?.geometry) {
      try {
        const centroid = turf.centroid(link.feature);
        const [centLng, centLat] = centroid.geometry.coordinates;
        orientacion = calcularOrientacion(lat, lng, centLat, centLng);
      } catch (e) {
        orientacion = null;
      }
    }

    const distKm = link.distance_m != null ? (link.distance_m / 1000) : null;

    if (isInside) {
      return {
        grupoNombre,
        areaNombre,
        kind: "inside",
        text: `estás dentro del área <em>${areaNombre}</em> (${grupoNombre})`,
      };
    }

    const dirTxt = orientacion ? ` hacia el <strong>${orientacion}</strong>` : "";
    return {
      grupoNombre,
      areaNombre,
      kind: "near",
      text: `la <em>${areaNombre}</em> (${grupoNombre}), a <strong>${distKm.toFixed(2)} km</strong>${dirTxt}`,
    };
  };

  if (!near.length && !far.length) {
    resumenEl.innerHTML = `
      <p class="muted" style="margin:0;font-size:0.9rem;">
        No se encontraron resultados asociados a la consulta.
      </p>
    `;
    return;
  }

  const inside = near.find((l) => l.link_type === "inside");
  const first = near[0] || null;
  const second = near[1] || null;

  let mainHTML = `<div style="font-size:0.95rem;line-height:1.7;color:var(--text);">`;

  if (inside) {
    const p = pickPhrase(inside);
    mainHTML += `
      Considerando un radio de alerta territorial de <strong>${currentBufferKm} km</strong> alrededor del punto consultado, lo más relevante es que ${p.text}.
    `;
    const next = near.find((l) => l !== inside);
    if (next) {
      const p2 = pickPhrase(next);
      mainHTML += ` Como antecedente cercano adicional, aparece ${p2.text}.`;
    }
  } else if (first) {
    const p1 = pickPhrase(first);
    mainHTML += `
      Considerando un radio de alerta territorial de <strong>${currentBufferKm} km</strong> alrededor del punto consultado, lo más relevante es que la referencia protegida más cercana corresponde al grupo <strong>${p1.grupoNombre}</strong>:
      <em>${p1.areaNombre}</em>, ubicada a <strong>${(first.distance_m / 1000).toFixed(2)} km</strong>${p1.kind === "near" ? (p1.text.includes("hacia el") ? p1.text.slice(p1.text.indexOf(" hacia")) : "") : ""}.
    `;
    if (second) {
      const p2 = pickPhrase(second);
      mainHTML += ` Como segundo antecedente, aparece ${p2.text}.`;
    }
  } else {
    mainHTML += `
      <span class="muted">
        No se detectaron áreas visualizables dentro de <strong>300 km</strong> del punto consultado.
      </span>
    `;
  }

  if (far.length) {
    const n = far.length;
    mainHTML += `
      <div class="muted" style="margin-top:10px;">
        Adicionalmente, se identifican <strong>${n}</strong> área${n !== 1 ? "s" : ""} protegida${n !== 1 ? "s" : ""}
        fuera del radio de visualización (<strong>más de 300 km</strong>), las cuales se listan al final como referencia contextual.
      </div>
    `;
  }

  mainHTML += `</div>`;
  resumenEl.innerHTML = mainHTML;
}

/* ===========================
   Mapa individual por grupo
=========================== */
function initGroupMap(containerId, lat, lng, feature, distanceM) {
  if (groupMaps[containerId]) return;

  const map = L.map(containerId, { zoomControl: false, preferCanvas: true })
    .setView([lat, lng], 12);

  // ✅ Base estándar opción 3 (detalle EN COLOR)
  addBasemapSatelliteWithLabels(map, { grayscale: false });

  const pointMarker = L.circleMarker([lat, lng], {
    radius: 6,
    weight: 2,
    color: "#65a30d",
    fillColor: "#bef264",
    fillOpacity: 0.7,
  }).addTo(map);

  let layer = null;

  if (feature && distanceM != null && distanceM <= MAX_DISTANCE_FOR_DRAW) {
    layer = L.geoJSON(feature, {
      style: {
        color: "#22c55e",
        weight: 2,
        fillColor: "#22c55e",
        fillOpacity: 0.15,
      },
    }).addTo(map);

    groupLayers[containerId] = layer;

    try {
      const bounds = layer.getBounds();
      const extendedBounds = bounds.extend([lat, lng]);
      map.fitBounds(extendedBounds, { padding: [30, 30] });
    } catch (e) {
      map.setView([lat, lng], 12);
    }

    try {
      addFocusMarker(map, feature);
    } catch (e) {}
  } else {
    map.setView([lat, lng], 12);
  }

  groupMaps[containerId] = map;

  // ✅ toggle Punto + área vs Solo área (igual que lo tienes)
  if (layer) {
    const toggleBtnId = `toggle-${containerId}`;
    const toggleBtn = document.getElementById(toggleBtnId);
    if (toggleBtn) {
      let showingPoint = true;
      toggleBtn.addEventListener("click", () => {
        if (showingPoint) {
          map.removeLayer(pointMarker);
          try {
            map.fitBounds(layer.getBounds(), { padding: [30, 30] });
          } catch (e) {
            map.setView([lat, lng], 12);
          }
          toggleBtn.textContent = "📍 Ver punto + área";
          showingPoint = false;
        } else {
          pointMarker.addTo(map);
          try {
            const bounds = layer.getBounds();
            const extendedBounds = bounds.extend([lat, lng]);
            map.fitBounds(extendedBounds, { padding: [30, 30] });
          } catch (e) {
            map.setView([lat, lng], 12);
          }
          toggleBtn.textContent = "🗺️ Ver solo área";
          showingPoint = true;
        }
      });
    }
  }

  setTimeout(() => map.invalidateSize(true), 100);
}


/* ===========================
   Extracción de datos por grupo
=========================== */
function extractGroupData(link) {
  const props = link.feature?.properties || {};
  const layerId = (link.layer_id || "").toLowerCase();

  let nombre = "—";
  let categoria = null;
  let superficie = null;
  let regiones = [];
  let decreto = null;
  let decretoLink = null;
  let emisor = null;
  let linkBcn = null;
  let ubicacion = null;
  let tipo = null;

  // ✅ Superficie universal (para cualquier grupo)
  const m2 = computeSurfaceM2(link.feature);
  if (m2 != null) superficie = fmtArea(m2);

  // Mantengo nombres/atributos por grupos conocidos (se pueden ampliar),
  // pero la superficie ya NO depende del grupo.
  if (layerId.includes("snaspe")) {
    nombre = props.NOMBRE_TOT || props.NOMBRE_UNI || props.NOMBRE || props.nombre || "—";
    categoria = props.CATEGORIA || props.TIPO_DE_PR || props.categoria || null;

    if (props.REGION) {
      regiones = normalizarRegiones(props.REGION);
    }

    decreto = props.DECRETO || props.decreto || null;
    decretoLink = props.LINK || props.link || null;
    emisor = props.EMISOR || props.emisor || null;
    linkBcn = props.LINK_BCN || props.link_bcn || props.BCN || props.bcn || decretoLink || null;
  }

  if (layerId.includes("ramsar")) {
    nombre = props.Nombre || props.nombre || props.NOMBRE || "—";
    tipo = props.Tipo || props.tipo || null;

    const reg = props.Nomreg || props.nomreg || null;
    const prov = props.Nomprov || props.nomprov || null;
    const com = props.Nomcom || props.nomcom || null;
    ubicacion = [reg, prov, com].filter(Boolean).join(", ") || null;

    decreto = props.Decreto || props.decreto || null;
    emisor = props.Emisor || props.emisor || null;
    linkBcn = props.LinkBCN || props.link_bcn || props.BCN || props.bcn || null;
  }

  emisor = emisor || props.emisor || props.Emisor || props.MINISTERIO || props.ministerio || null;
  linkBcn = linkBcn || props.LINK_BCN || props.link_bcn || props.url_bcn || props.URL_BCN || null;

  // Fallback genérico de nombre si no calzó grupo
  if (nombre === "—") {
    nombre =
      props.nombre ||
      props.Nombre ||
      props.NOMBRE ||
      props.NOMBRE_TOT ||
      props.NOMBRE_UNI ||
      props.NOM ||
      props.NAME ||
      "—";
  }

  return {
    nombre,
    categoria,
    superficie,
    regiones,
    decreto,
    decretoLink,
    emisor,
    linkBcn,
    ubicacion,
    tipo,
  };
}

/* ===========================
   Renderizar tarjeta de grupo (≤300 km) con mapa
=========================== */
function renderGroupCard(link, clickLat, clickLng, index) {
  const distanceBorderKm = isFinite(link.distance_border_m) ? (link.distance_border_m / 1000) : null;
  const dictamen = getDictamen(link.link_type, distanceBorderKm);
  const distanceBorderM = link.distance_border_m;
  const data = extractGroupData(link);

  const groupId = `group-${index}`;
  const mapId = `map-${groupId}`;

  const borderKm = isFinite(distanceBorderM) ? fmtKm(distanceBorderM) : "—";
  const isInside = link.link_type === "inside";
  const distanceCentroidKm = getCentroidDistanceKm(link.feature, clickLat, clickLng);
  const surfaceM2 = computeSurfaceM2(link.feature);
  const areaKm2 = isFinite(surfaceM2) ? (surfaceM2 / 1e6) : null;
  const perimeterKm = computePerimeterKm(link.feature);
  const diametroKm = calcDiametroEquivalenteKm(areaKm2);
  const relacion = calcRelacionDistanciaTamano(distanceBorderKm, diametroKm);
  const interpretacion = getInterpretacionEspacial(distanceBorderKm, isInside);
  const centroide = getCentroideInfo(link.feature);
  const relationText = isInside
    ? "El POI se encuentra dentro del área protegida."
    : (isFinite(relacion)
      ? `El POI está a ${relacion.toFixed(1)} veces el diámetro equivalente del área protegida.`
      : "No fue posible calcular la relación distancia/tamaño por datos incompletos.");

  const bodyId = `body-${groupId}`;
  const toggleBtnId = `toggle-${mapId}`;

  let bodyHTML = `
    <div class="groupBody" id="${bodyId}">
      <div class="groupGrid">
        <div class="groupMapCard">
          <div class="groupMapHead">
            <div class="left">${data.nombre}</div>
            <div class="right">
              <button class="btnSm btn--ghost" id="${toggleBtnId}" type="button">🗺️ Ver solo área</button>
            </div>
          </div>
          <div class="groupMap" id="${mapId}"></div>
        </div>

        <div class="groupSide">
          <div class="groupKpis">
            <div>
              <div class="kpi__label">🧭 Dictamen</div>
              <div class="badge badge--${dictamen.class}">${dictamen.text}</div>
            </div>
            <div>
              <div class="kpi__label">📏 Distancia al borde</div>
              <div class="kpi__value">${isInside ? "0.00 km (dentro)" : borderKm}</div>
            </div>
            <div>
              <div class="kpi__label">🎯 Distancia al centroide</div>
              <div class="kpi__value">${isFinite(distanceCentroidKm) ? formatKm(distanceCentroidKm) : "—"}</div>
            </div>
            <div>
              <div class="kpi__label">🔎 Relación distancia/tamaño</div>
              <div class="kpi__value">${isFinite(relacion) ? `${relacion.toFixed(2)}x` : "—"}</div>
            </div>
          </div>

          <div class="groupBlock">
            <div class="groupBlock__title">Relación POI–Polígono</div>
            <div class="insightText">${relationText}</div>
          </div>

          <div class="groupBlock">
            <div class="groupBlock__title">Interpretación automática</div>
            <div class="insightText">${interpretacion}</div>
          </div>

          <div class="groupBlock">
            <div class="groupBlock__title">Indicadores geométricos</div>
            <div class="miniKpiGrid">
              <div class="miniKpi">
                <div class="kpi__label">📐 Superficie</div>
                <div class="kpi__value">${isFinite(areaKm2) ? formatKm(areaKm2).replace(" km", " km²") : "—"}</div>
              </div>
              <div class="miniKpi">
                <div class="kpi__label">⭕ Perímetro</div>
                <div class="kpi__value">${isFinite(perimeterKm) ? formatKm(perimeterKm) : "—"}</div>
              </div>
              <div class="miniKpi">
                <div class="kpi__label">◯ Diámetro</div>
                <div class="kpi__value">${isFinite(diametroKm) ? formatKm(diametroKm) : "—"}</div>
              </div>
              ${centroide ? `
              <div class="miniKpi">
                <div class="kpi__label">📍 Centroide</div>
                <div class="kpi__value">${centroide.lat.toFixed(5)}, ${centroide.lng.toFixed(5)}</div>
              </div>
              ` : ""}
            </div>
          </div>

          <div class="groupAttrs">
            <table class="attrTable">
  `;

  bodyHTML += `<tr><td class="k">Nombre</td><td class="v">${data.nombre}</td></tr>`;
  if (data.categoria) bodyHTML += `<tr><td class="k">Categoría</td><td class="v">${data.categoria}</td></tr>`;
  if (data.tipo) bodyHTML += `<tr><td class="k">Tipo</td><td class="v">${data.tipo}</td></tr>`;
  if (data.superficie) bodyHTML += `<tr><td class="k">Superficie</td><td class="v">${data.superficie}</td></tr>`;
  if (data.regiones.length) bodyHTML += `<tr><td class="k">Región(es)</td><td class="v">${data.regiones.join(", ")}</td></tr>`;
  if (data.ubicacion) bodyHTML += `<tr><td class="k">Ubicación</td><td class="v">${data.ubicacion}</td></tr>`;
  if (data.decreto) {
    let decretoHTML = data.decreto;
    if (data.decretoLink) {
      decretoHTML += ` <a href="${data.decretoLink}" target="_blank" rel="noopener" style="color:#65a30d;">🔗</a>`;
    }
    bodyHTML += `<tr><td class="k">Decreto</td><td class="v">${decretoHTML}</td></tr>`;
  }
  if (data.emisor) bodyHTML += `<tr><td class="k">Emisor</td><td class="v">${data.emisor}</td></tr>`;
  bodyHTML += `<tr><td class="k">Link BCN</td><td class="v">${
    data.linkBcn
      ? `<a href="${data.linkBcn}" target="_blank" rel="noopener" style="color:#65a30d;">Ver fuente BCN</a>`
      : `<span class="muted">Fuente BCN no disponible</span>`
  }</td></tr>`;

  bodyHTML += `
            </table>
          </div>

          <div style="margin-top:12px;text-align:center;">
            <button class="btnSm btn--ghost" onclick="scrollToTop()" type="button">↑ Volver arriba</button>
          </div>
        </div>
      </div>
    </div>
  `;

  const headHTML = `
    <div class="groupHead" data-target="${bodyId}">
      <div class="groupTitle">
        <div class="groupTitle__name">${link.layer_name || link.layer_id}</div>
        <div class="groupTitle__sub">${data.nombre}</div>
      </div>
      <div class="groupMeta">
        <div class="badgeMini ${dictamen.class}">🧭 ${dictamen.text}</div>
        <div class="badgeMini">${isInside ? "0.00 km" : borderKm}</div>
        <div class="groupChevron">▼</div>
      </div>
    </div>
  `;

  const cardHTML = `
    <div class="groupCard" data-index="${index}">
      ${headHTML}
      ${bodyHTML}
    </div>
  `;

  const wrap = document.getElementById("groupsWrap");
  if (!wrap) return;

  const div = document.createElement("div");
  div.innerHTML = cardHTML;
  wrap.appendChild(div.firstElementChild);

  const head = document.querySelector(`[data-target="${bodyId}"]`);
  const body = document.getElementById(bodyId);

  if (head && body) {
    head.addEventListener("click", () => {
      const isHidden = body.classList.toggle("isHidden");
      const chevron = head.querySelector(".groupChevron");
      if (chevron) chevron.textContent = isHidden ? "▶" : "▼";

      if (!isHidden && !groupMaps[mapId]) {
        setTimeout(() => {
          initGroupMap(mapId, clickLat, clickLng, link.feature, link.distance_m);
        }, 100);
      }
    });
  }
}

/* ===========================
   Renderizar tarjeta LITE (>300 km) SIN MAPA (solo info relevante)
=========================== */
function renderGroupCardLite(link, index) {
  const distanceBorderKm = isFinite(link.distance_border_m) ? (link.distance_border_m / 1000) : null;
  const dictamen = getDictamen(link.link_type, distanceBorderKm);
  const distanceBorderM = link.distance_border_m;
  const data = extractGroupData(link);

  const groupId = `far-${index}`;
  const bodyId = `body-${groupId}`;

  const borderKm = isFinite(distanceBorderM) ? fmtKm(distanceBorderM) : "—";
  const isInside = link.link_type === "inside";

  let bodyHTML = `
    <div class="groupBody isHidden" id="${bodyId}">
      <div class="groupGrid" style="grid-template-columns: 1fr;">
        <div class="groupSide" style="max-width: 100%;">
          <div class="groupKpis">
            <div>
              <div class="kpi__label">🧭 Dictamen</div>
              <div class="badge badge--${dictamen.class}">${dictamen.text}</div>
            </div>
            <div>
              <div class="kpi__label">📏 Distancia al borde</div>
              <div class="kpi__value">${isInside ? "0.00 km (dentro)" : borderKm}</div>
            </div>
            <div>
              <div class="kpi__label">🎯 Distancia al centroide</div>
              <div class="kpi__value">—</div>
            </div>
            <div>
              <div class="kpi__label">Visualización</div>
              <div class="kpi__value"><span class="muted">&gt; 300 km (sin mapa)</span></div>
            </div>
          </div>

          <div class="groupAttrs">
            <table class="attrTable">
  `;

  if (data.categoria) bodyHTML += `<tr><td class="k">Categoría</td><td class="v">${data.categoria}</td></tr>`;
  if (data.tipo) bodyHTML += `<tr><td class="k">Tipo</td><td class="v">${data.tipo}</td></tr>`;
  if (data.superficie) bodyHTML += `<tr><td class="k">Superficie</td><td class="v">${data.superficie}</td></tr>`;
  if (data.regiones.length) bodyHTML += `<tr><td class="k">Región(es)</td><td class="v">${data.regiones.join(", ")}</td></tr>`;
  if (data.ubicacion) bodyHTML += `<tr><td class="k">Ubicación</td><td class="v">${data.ubicacion}</td></tr>`;
  if (data.decreto) {
    let decretoHTML = data.decreto;
    if (data.decretoLink) {
      decretoHTML += ` <a href="${data.decretoLink}" target="_blank" rel="noopener" style="color:#65a30d;">🔗</a>`;
    }
    bodyHTML += `<tr><td class="k">Decreto</td><td class="v">${decretoHTML}</td></tr>`;
  }

  bodyHTML += `
            </table>
          </div>

          <div style="margin-top:12px;text-align:center;">
            <button class="btnSm btn--ghost" onclick="scrollToTop()" type="button">↑ Volver arriba</button>
          </div>
        </div>
      </div>
    </div>
  `;

  const headHTML = `
    <div class="groupHead" data-target="${bodyId}">
      <div class="groupTitle">
        <div class="groupTitle__name">${link.layer_name || link.layer_id}</div>
        <div class="groupTitle__sub">${data.nombre}</div>
      </div>
      <div class="groupMeta">
        <div class="badgeMini ${dictamen.class}">🧭 ${dictamen.text}</div>
        <div class="badgeMini">${isInside ? "0.00 km" : borderKm}</div>
        <div class="badgeMini muted" style="opacity:0.9;">sin mapa</div>
        <div class="groupChevron">▶</div>
      </div>
    </div>
  `;

  const cardHTML = `
    <div class="groupCard" data-index="${index}">
      ${headHTML}
      ${bodyHTML}
    </div>
  `;

  const wrapFar = ensureFarSectionContainer();
  if (!wrapFar) return;

  const div = document.createElement("div");
  div.innerHTML = cardHTML;
  wrapFar.appendChild(div.firstElementChild);

  const head = wrapFar.querySelector(`[data-target="${bodyId}"]`);
  const body = document.getElementById(bodyId);
  if (head && body) {
    head.addEventListener("click", () => {
      const isHidden = body.classList.toggle("isHidden");
      const chevron = head.querySelector(".groupChevron");
      if (chevron) chevron.textContent = isHidden ? "▶" : "▼";
    });
  }
}

function ensureFarSectionContainer() {
  const mainWrap = document.getElementById("groupsWrap");
  if (!mainWrap) return null;

  let farWrap = document.getElementById("groupsWrapFar");
  if (farWrap) return farWrap;

  const hr = document.createElement("div");
  hr.style.margin = "18px 0 10px";
  hr.style.borderTop = "1px solid rgba(0,0,0,0.10)";
  mainWrap.appendChild(hr);

  const h = document.createElement("div");
  h.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin:6px 0 12px;">
      <div style="font-weight:700;">Fuera de 300 km (sin mapa)</div>
      <div class="muted" style="font-size:0.9em;">Resultados detectados como referencia contextual</div>
    </div>
  `;
  mainWrap.appendChild(h);

  farWrap = document.createElement("div");
  farWrap.id = "groupsWrapFar";
  mainWrap.appendChild(farWrap);

  return farWrap;
}

/* ===========================
   Cargar y renderizar
=========================== */
function loadAndRender() {
  try {
    resultEventSent = false;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      document.body.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:20px;">
          <h2>No hay consulta disponible</h2>
          <button class="btn btn--primary" onclick="window.close()">← Volver</button>
        </div>
      `;
      return;
    }

    const data = JSON.parse(raw);
    const click = data.click || {};
    const links = data.links || [];

    if (!Number.isFinite(click.lat) || !Number.isFinite(click.lng)) {
      throw new Error("Punto consultado inválido");
    }

    const sorted = links.slice().sort((a, b) => {
      const dA = a.distance_m ?? Infinity;
      const dB = b.distance_m ?? Infinity;
      return dA - dB;
    });

    const near = sorted.filter(isVisualizable).sort((a, b) => {
      if (a.link_type === "inside" && b.link_type !== "inside") return -1;
      if (b.link_type === "inside" && a.link_type !== "inside") return 1;
      return (a.distance_m ?? Infinity) - (b.distance_m ?? Infinity);
    });

    const far = sorted.filter(isFar);

    emitResultOpenEventOnce(sorted);

    initMainMap(click.lat, click.lng, sorted);
    generarResumenAreas(click.lat, click.lng, sorted);

    const coordsEl = document.getElementById("coordsDisplay");
    if (coordsEl) {
      coordsEl.textContent = `${click.lat.toFixed(6)}, ${click.lng.toFixed(6)}`;
    }

    const countEl = document.getElementById("groupsCount");
    if (countEl) {
      countEl.textContent = `${sorted.length} grupo${sorted.length !== 1 ? "s" : ""}`;
    }

    // Mapear índice original para scrollToGroup(idx)
    const originalIndex = new Map();
    sorted.forEach((l, i) => originalIndex.set(l, i));

    // Render near con mapas
    near.forEach((link) => {
      const idx = originalIndex.get(link);
      renderGroupCard(link, click.lat, click.lng, idx);
    });

    // Lazy init: abrir el primer near por defecto
    if (near.length) {
      const firstIdx = originalIndex.get(near[0]);
      const firstBody = document.getElementById(`body-group-${firstIdx}`);
      const firstHead = document.querySelector(`[data-target="body-group-${firstIdx}"]`);
      const firstChevron = firstHead?.querySelector(".groupChevron");

      if (firstBody && firstHead) {
        firstBody.classList.remove("isHidden");
        if (firstChevron) firstChevron.textContent = "▼";
        setTimeout(() => {
          initGroupMap(`map-group-${firstIdx}`, click.lat, click.lng, near[0].feature, near[0].distance_m);
        }, 200);
      }
    }

    // Cerrar los demás near por defecto
    near.slice(1).forEach((link) => {
      const idx = originalIndex.get(link);
      const body = document.getElementById(`body-group-${idx}`);
      const head = document.querySelector(`[data-target="body-group-${idx}"]`);
      const chevron = head?.querySelector(".groupChevron");
      if (body) body.classList.add("isHidden");
      if (chevron) chevron.textContent = "▶";
    });

    // Render far al final (SIN MAPA)
    far.forEach((link) => {
      const idx = originalIndex.get(link);
      renderGroupCardLite(link, idx);
    });

    toast(`✅ ${sorted.length} grupo(s) procesados`, 2000);
  } catch (e) {
    console.error("Error cargando datos:", e);
    document.body.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:20px;">
        <h2>Error al cargar los datos</h2>
        <p style="color:#999;">${e.message}</p>
        <button class="btn btn--primary" onclick="window.close()">← Volver</button>
      </div>
    `;
  }
}

/* ===========================
   KML EXPORT (Mapa principal)
   - Punto consultado
   - Polígonos dibujados (<=300 km)
=========================== */

function kmlEscape(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function ensureRingClosed(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return ring;
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (!first || !last) return ring;
  const same = first[0] === last[0] && first[1] === last[1];
  return same ? ring : ring.concat([first]);
}

function ringToKmlCoords(ring) {
  const closed = ensureRingClosed(ring || []);
  return closed.map((c) => `${c[0]},${c[1]},0`).join(" ");
}

function polygonToKml(polyCoords) {
  // polyCoords: [ outerRing, hole1, hole2, ... ]
  const outer = polyCoords?.[0] || [];
  const holes = (polyCoords || []).slice(1);

  let k = `<Polygon><outerBoundaryIs><LinearRing><coordinates>${ringToKmlCoords(
    outer
  )}</coordinates></LinearRing></outerBoundaryIs>`;

  for (const h of holes) {
    k += `<innerBoundaryIs><LinearRing><coordinates>${ringToKmlCoords(
      h
    )}</coordinates></LinearRing></innerBoundaryIs>`;
  }

  k += `</Polygon>`;
  return k;
}

function geometryToKml(geom) {
  if (!geom || !geom.type) return "";
  const t = geom.type;

  if (t === "Point") {
    const [lng, lat] = geom.coordinates;
    return `<Point><coordinates>${lng},${lat},0</coordinates></Point>`;
  }

  if (t === "Polygon") {
    return polygonToKml(geom.coordinates);
  }

  if (t === "MultiPolygon") {
    const polys = geom.coordinates || [];
    return `<MultiGeometry>${polys.map(polygonToKml).join("")}</MultiGeometry>`;
  }

  return "";
}

function placemarkKml({ name, description, geomKml, styleUrl }) {
  if (!geomKml) return "";
  return `
  <Placemark>
    <name>${kmlEscape(name)}</name>
    ${description ? `<description>${kmlEscape(description)}</description>` : ""}
    ${styleUrl ? `<styleUrl>${styleUrl}</styleUrl>` : ""}
    ${geomKml}
  </Placemark>`;
}

function buildKmlDocument(placemarks, docName) {
  const styles = `
  <Style id="polyStyle">
    <LineStyle><color>ff00ff00</color><width>3</width></LineStyle>
    <PolyStyle><color>4d00ff00</color></PolyStyle>
  </Style>
  <Style id="ptStyle">
    <IconStyle>
      <scale>1.1</scale>
      <Icon><href>http://maps.google.com/mapfiles/kml/paddle/red-circle.png</href></Icon>
    </IconStyle>
  </Style>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>${kmlEscape(docName || "GeoNEMO export")}</name>
  ${styles}
  ${placemarks.join("\n")}
</Document>
</kml>`;
}

function downloadTextFile(text, filename, mime = "application/vnd.google-earth.kml+xml") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

function buildMainMapKmlFromStorage() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;

  const data = JSON.parse(raw);
  const click = data.click || {};
  const links = data.links || [];

  if (!isFinite(click.lat) || !isFinite(click.lng)) return null;

  // Solo lo que aparece en el MAPA PRINCIPAL (tu misma regla)
  const visibleLinks = links.filter(isVisualizable);

  const placemarks = [];

  // 1) Punto consultado
  placemarks.push(
    placemarkKml({
      name: "Punto consultado",
      description: `Coordenadas: ${click.lat.toFixed(6)}, ${click.lng.toFixed(6)}`,
      geomKml: geometryToKml({
        type: "Point",
        coordinates: [click.lng, click.lat],
      }),
      styleUrl: "#ptStyle",
    })
  );

  // 2) Polígonos por grupo (los que dibujas)
  visibleLinks.forEach((link) => {
    const feat = link.feature;
    if (!feat?.geometry) return;

    const dataG = extractGroupData(link);
    const grupo = link.layer_name || link.layer_id || "Grupo";
    const nombreArea = dataG?.nombre && dataG.nombre !== "—" ? dataG.nombre : "Área";
    const distTxt =
      link.link_type === "inside"
        ? "Dentro del área"
        : (isFinite(link.distance_border_m) ? `Distancia al borde: ${(link.distance_border_m / 1000).toFixed(2)} km` : "");

    placemarks.push(
      placemarkKml({
        name: `${grupo} — ${nombreArea}`,
        description: distTxt,
        geomKml: geometryToKml(feat.geometry),
        styleUrl: "#polyStyle",
      })
    );
  });

  const kml = buildKmlDocument(
    placemarks,
    `GeoNEMO - Mapa principal (${new Date().toISOString().slice(0, 10)})`
  );

  return kml;
}

/* ===========================
   Botones de acción
=========================== */
function bindUI() {
  const btnBack = document.getElementById("btnBack");
  if (btnBack) {
    btnBack.addEventListener("click", () => {
      if (window.opener) window.close();
      else window.history.back();
    });
  }

  // Dropdown Descargas
  const btnDownloads = document.getElementById("btnDownloads");
  const downloadsMenu = document.getElementById("downloadsMenu");
  if (btnDownloads && downloadsMenu) {
    btnDownloads.addEventListener("click", (e) => {
      e.stopPropagation();
      downloadsMenu.classList.toggle("open");
    });

    document.addEventListener("click", () => {
      downloadsMenu.classList.remove("open");
    });
  }

  // Descargar JSON (resultado completo)
  const btnDownloadJSON = document.getElementById("btnDownloadJSON");
  if (btnDownloadJSON) {
    btnDownloadJSON.addEventListener("click", () => {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) {
          toast("⚠️ No hay datos para descargar", 2000);
          return;
        }

        const blob = new Blob([raw], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `geonemo-resultado-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);

        toast("✅ JSON descargado", 1500);
      } catch (e) {
        console.error(e);
        toast("⚠️ Error al descargar JSON", 2000);
      }
    });
  }

  // Descargar KML (mapa principal: punto + polígonos dibujados <=300km)
  const btnDownloadKML = document.getElementById("btnDownloadKML");
  if (btnDownloadKML) {
    btnDownloadKML.addEventListener("click", () => {
      trackEvent({
        event: "geo_download_attempt",
        file_type: "kml",
        site: TRACK_SITE
      }, { dedupeKey: "geo_download_attempt:kml" });

      try {
        const kml = buildMainMapKmlFromStorage();
        if (!kml) {
          toast("⚠️ No hay datos válidos para KML", 2000);
          return;
        }

        downloadTextFile(
          kml,
          `geonemo-mapa-principal-${new Date().toISOString().slice(0, 10)}.kml`
        );

        trackEvent({
          event: "geo_download_success",
          file_type: "kml",
          site: TRACK_SITE
        }, { dedupeKey: "geo_download_success:kml" });

        toast("✅ KML descargado", 1500);
      } catch (e) {
        console.error(e);
        toast("⚠️ Error al generar KML", 2000);
      }
    });
  }

  // (placeholder) GeoJSON polígono seleccionado
  // OJO: tu HTML lo tiene disabled. Si luego lo habilitas, aquí conectas su lógica.
  const btnDownloadSelectedGeoJSON = document.getElementById("btnDownloadSelectedGeoJSON");
  if (btnDownloadSelectedGeoJSON) {
    btnDownloadSelectedGeoJSON.addEventListener("click", () => {
      toast("ℹ️ Aún no implementado: GeoJSON (polígono seleccionado)", 1800);
    });
  }

  // Copiar link
  const btnCopyLink = document.getElementById("btnCopyLink");
  if (btnCopyLink) {
    btnCopyLink.addEventListener("click", () => {
      navigator.clipboard
        .writeText(window.location.href)
        .then(() => toast("✅ Link copiado", 1500))
        .catch(() => toast("⚠️ No se pudo copiar el link", 2000));
    });
  }
}

/* ===========================
   Init
=========================== */
(function init() {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      bindUI();
      loadAndRender();
    });
  } else {
    bindUI();
    loadAndRender();
  }
})();
