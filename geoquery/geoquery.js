const GEOQUERY_BASE_URL = new URL("../capas_geoquery/", window.location.href);
const SNASPE_BASE_URL = new URL("../capas_geoquery/grupo_snaspe/", window.location.href);
const RAMSAR_BASE_URL = new URL("../capas_geoquery/grupo_ramsar/", window.location.href);
const GROUP_BASE_URLS = { snaspe: SNASPE_BASE_URL, ramsar: RAMSAR_BASE_URL };
const GEOQUERY_DEBUG = false;
const groupConfigCache = new Map();
const groupQueryCache = new Map();
const geojsonSourceCache = new Map();

function ensureTrailingSlash(url) { return String(url || "").endsWith("/") ? String(url) : `${url}/`; }
function parseFiniteUrlNumber(params, name) {
  const raw = params.get(name);
  if (raw === null || String(raw).trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function decimalToDMS(value, type) {
  const absolute = Math.abs(value);
  let degrees = Math.floor(absolute);
  const minutesFloat = (absolute - degrees) * 60;
  let minutes = Math.floor(minutesFloat);
  let seconds = Number(((minutesFloat - minutes) * 60).toFixed(2));
  if (seconds >= 60) { seconds = 0; minutes += 1; }
  if (minutes >= 60) { minutes = 0; degrees += 1; }
  const direction = type === "lat" ? (value >= 0 ? "N" : "S") : (value >= 0 ? "E" : "W");
  return `${degrees}° ${minutes}' ${seconds.toFixed(2)}" ${direction}`;
}

function isValidCoordinate(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

function getZoomForApproxScale(lat, scaleDenominator = 20000) {
  const metersPerPixelTarget = scaleDenominator * 0.0254 / 96;
  const zoom = Math.log2((156543.03392 * Math.cos(lat * Math.PI / 180)) / metersPerPixelTarget);
  return Math.max(0, Math.min(20, zoom));
}

function getParam(params, key, fallback) { return params.get(key) || fallback; }

function buildReturnUrl(lat, lon, zoom, basemap, viewLat, viewLon) {
  if (lat === null || lon === null) return "../index.html";
  const sourceParams = new URLSearchParams(window.location.search);
  const backParams = new URLSearchParams({ from: sourceParams.get("from") === "crossaccess" ? "crossaccess" : "geoquery", lat: String(lat), lon: String(lon), queryLat: sourceParams.get("queryLat") || String(lat), queryLon: sourceParams.get("queryLon") || String(lon), zoom: String(zoom || sourceParams.get("mapZoom") || "14"), mapZoom: String(sourceParams.get("mapZoom") || zoom || "14"), basemap: basemap || "osm" });
  const centerLat = sourceParams.get("mapCenterLat") || viewLat;
  const centerLon = sourceParams.get("mapCenterLon") || viewLon;
  if (centerLat && centerLon) { backParams.set("viewLat", centerLat); backParams.set("viewLon", centerLon); backParams.set("mapCenterLat", centerLat); backParams.set("mapCenterLon", centerLon); }
  ["viewWest", "viewSouth", "viewEast", "viewNorth", "restoreViewport"].forEach((key) => { const value = sourceParams.get(key); if (value !== null) backParams.set(key, value); });
  return `../index.html?${backParams.toString()}`;
}

async function fetchJsonOnce(url, cache = geojsonSourceCache) {
  const href = url instanceof URL ? url.toString() : String(url);
  if (!cache.has(href)) {
    cache.set(href, fetch(href, { cache: "no-store" }).then((r) => {
      const contentType = r.headers.get("content-type") || "";
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${r.url}`);
      if (contentType && !contentType.toLowerCase().includes("json")) console.warn("[GeoNEMO] Respuesta JSON sin content-type JSON", r.url, contentType);
      return r.json();
    }));
  }
  return cache.get(href);
}

function resolveGroupLayerUrl(groupBaseUrl, fileName) {
  return new URL(fileName, groupBaseUrl).toString();
}

function isUnsafeRelativeLayerPath(fileName) {
  if (typeof fileName !== "string" || fileName.trim() === "") return true;
  const trimmed = fileName.trim();
  return trimmed.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.split(/[\\/]+/).includes("..");
}

function validateGroupQueryRules(rules) {
  const context = rules?.grupo || "grupo_desconocido";
  const required = ["version", "sitio", "grupo", "regla_busqueda", "capas"];
  required.forEach((field) => { if (!(field in (rules || {}))) console.error(`[GeoNEMO][${context}] listado_query.json sin campo obligatorio: ${field}`); });
  if (!rules || !Array.isArray(rules.capas)) {
    console.error(`[GeoNEMO][${context}] listado_query.json inválido: capas debe ser un arreglo.`);
    return { ...(rules || {}), capas: [] };
  }
  const seenIds = new Set();
  const seenFiles = new Set();
  const validLayers = [];
  rules.capas.forEach((layer, index) => {
    const errors = [];
    if (!layer || typeof layer !== "object") errors.push("la entrada no es un objeto");
    if (!layer?.id || typeof layer.id !== "string") errors.push("id debe ser una cadena no vacía");
    if (layer?.id && seenIds.has(layer.id)) errors.push(`id duplicado: ${layer.id}`);
    if (isUnsafeRelativeLayerPath(layer?.archivo)) errors.push("archivo debe ser relativo, no vacío, sin rutas absolutas ni ../");
    if (layer?.archivo && seenFiles.has(layer.archivo)) errors.push(`archivo duplicado: ${layer.archivo}`);
    if (typeof layer?.activo !== "boolean") errors.push("activo debe ser booleano");
    if (typeof layer?.incluir_en_intersects !== "boolean") errors.push("incluir_en_intersects debe ser booleano");
    if (typeof layer?.incluir_en_nearest !== "boolean") errors.push("incluir_en_nearest debe ser booleano");

    if (errors.length) {
      console.error(`[GeoNEMO][${context}] capa inválida en listado_query.json índice ${index}`, { layer, errors });
      return;
    }
    seenIds.add(layer.id);
    seenFiles.add(layer.archivo);
    validLayers.push({ ...layer, archivo: layer.archivo.trim(), territorio: typeof layer.territorio === "string" && layer.territorio.trim() ? layer.territorio.trim() : "general" });
  });
  return { ...rules, capas: validLayers };
}

async function loadQueryRules(groupId, groupBaseUrl) {
  const rulesUrl = new URL("listado_query.json", groupBaseUrl);
  const href = rulesUrl.toString();
  if (!groupQueryCache.has(href)) {
    groupQueryCache.set(href, fetch(href, { cache: "no-store" }).then(async (response) => {
      const contentType = response.headers.get("content-type") || "";
      if (!response.ok) throw new Error(`[${groupId}] No fue posible cargar ${rulesUrl.pathname}: HTTP ${response.status}`);
      if (contentType && !contentType.toLowerCase().includes("json")) console.warn(`[GeoNEMO][${groupId}] content-type inesperado para listado_query.json`, contentType, href);
      const data = await response.json();
      if (!data || !Array.isArray(data.capas)) throw new Error(`[${groupId}] listado_query.json no contiene un arreglo "capas" válido`);
      return validateGroupQueryRules(data);
    }));
  }
  return groupQueryCache.get(href);
}

async function loadConfiguredQueryLayers(groupBaseUrl, queryRules) {
  const activeLayers = queryRules.capas.filter((layer) => layer.activo === true);
  const layerSettlements = await Promise.allSettled(activeLayers.map(async (layerConfig) => {
    const url = resolveGroupLayerUrl(groupBaseUrl, layerConfig.archivo);
    try {
      const geojson = await fetchJsonOnce(url, geojsonSourceCache);
      if (!geojson || geojson.type !== "FeatureCollection" || !Array.isArray(geojson.features)) throw new Error(`GeoJSON inválido: ${layerConfig.archivo}`);
      return { status: "loaded", config: layerConfig, url, geojson };
    } catch (error) {
      console.error(`[GeoNEMO][${queryRules.grupo}] Error cargando ${layerConfig.archivo}`, error);
      return { status: "error", config: layerConfig, url, geojson: null, error };
    }
  }));
  const loadedLayers = layerSettlements.map((settlement, index) => settlement.status === "fulfilled" ? settlement.value : { status: "error", config: activeLayers[index], url: resolveGroupLayerUrl(groupBaseUrl, activeLayers[index].archivo), geojson: null, error: settlement.reason });
  if (GEOQUERY_DEBUG) {
    console.table(loadedLayers.map((item) => ({ group: queryRules.grupo, id: item.config.id, file: item.config.archivo, active: item.config.activo, intersects: item.config.incluir_en_intersects, nearest: item.config.incluir_en_nearest, status: item.status, features: item.geojson?.features?.length || 0 })));
  }
  return loadedLayers;
}

async function loadGroupRegistry() {
  const registry = await fetchJsonOnce(resolveGroupLayerUrl(GEOQUERY_BASE_URL, "listado.json"), groupConfigCache);
  return (registry.grupos || []).filter((g) => g.activo).sort((a, b) => (a.orden || 0) - (b.orden || 0));
}

async function loadGroupConfig(groupEntry) {
  const groupBaseUrl = GROUP_BASE_URLS[groupEntry.id] || new URL(`${groupEntry.carpeta}/`, GEOQUERY_BASE_URL);
  const configUrl = new URL(groupEntry.config, GEOQUERY_BASE_URL).toString();
  const config = await fetchJsonOnce(configUrl, groupConfigCache);
  config.__folder = groupEntry.carpeta;
  config.__baseUrl = groupBaseUrl;
  return config;
}

function firstValue(properties, names) {
  for (const name of names || []) {
    const value = properties ? properties[name] : null;
    if (value !== null && value !== undefined && String(value).trim() !== "") return value;
  }
  return null;
}

function normalizeAreaToHectares(value) {
  const original = value;
  if (value === null || value === undefined || String(value).trim() === "") return { original, value: null, unit: "ha" };
  if (typeof value === "number") return { original, value, unit: "ha" };
  let text = String(value).trim().replace(/\s*(ha|hect[aá]reas?)\s*/ig, "").replace(/\s/g, "");
  const hasComma = text.includes(",");
  const hasDot = text.includes(".");
  if (hasComma && hasDot) text = text.replace(/\./g, "").replace(",", ".");
  else if (hasComma) text = text.replace(",", ".");
  const parsed = Number.parseFloat(text.replace(/[^0-9.-]/g, ""));
  return { original, value: Number.isFinite(parsed) ? parsed : null, unit: "ha" };
}

function stableText(value) { return String(value || "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " "); }

function buildDedupKey(groupConfig, properties) {
  if (groupConfig.id !== "snaspe") return null;
  return (groupConfig.deduplicacion || []).map((field) => stableText(properties[field])).join("|");
}

function normalizeGroupFeature(groupId, feature, sourceConfig, groupConfig, index) {
  const props = feature.properties || {};
  const fields = groupConfig.campos || {};
  const id = firstValue(props, fields.id) ?? `${sourceConfig.id}-${index}`;
  const areaHa = normalizeAreaToHectares(firstValue(props, fields.superficie));
  const common = {
    groupId, layerId: sourceConfig.id, sourceId: sourceConfig.id, sourceFile: sourceConfig.archivo, territory: sourceConfig.territorio, sourceSubtype: sourceConfig.territorio,
    featureId: id, dedupKey: buildDedupKey(groupConfig, props), originalProperties: props, geometry: feature.geometry,
    feature: { type: "Feature", properties: props, geometry: feature.geometry }, areaHa
  };
  if (groupId === "snaspe") {
    return { ...common, name: firstValue(props, fields.nombre), alternateName: firstValue(props, fields.nombre_alternativo), category: firstValue(props, fields.categoria), region: firstValue(props, fields.region), territory: sourceConfig.territorio || firstValue(props, fields.territorio), decree: firstValue(props, fields.decreto), issuer: firstValue(props, fields.emisor), condition: firstValue(props, fields.condicion), propertyType: firstValue(props, fields.tipo_propiedad), plan: firstValue(props, fields.plano) };
  }
  if (groupId === "ramsar") {
    return { ...common, name: firstValue(props, fields.nombre), type: firstValue(props, fields.tipo), region: firstValue(props, fields.region), province: firstValue(props, fields.provincia), commune: firstValue(props, fields.comuna), decree: firstValue(props, fields.decreto) };
  }
  return { ...common, name: firstValue(props, fields.nombre) || `Feature ${id}` };
}



function parseOriginalViewport(params) {
  const west = parseFiniteUrlNumber(params, "viewWest");
  const south = parseFiniteUrlNumber(params, "viewSouth");
  const east = parseFiniteUrlNumber(params, "viewEast");
  const north = parseFiniteUrlNumber(params, "viewNorth");
  const explicit = buildViewportFromBounds(west, south, east, north, "url_bbox");
  if (explicit) return explicit;

  const centerLat = parseFiniteUrlNumber(params, "viewLat") ?? parseFiniteUrlNumber(params, "mapCenterLat") ?? parseFiniteUrlNumber(params, "lat");
  const centerLon = parseFiniteUrlNumber(params, "viewLon") ?? parseFiniteUrlNumber(params, "mapCenterLon") ?? parseFiniteUrlNumber(params, "lon");
  const zoom = parseFiniteUrlNumber(params, "zoom") ?? parseFiniteUrlNumber(params, "mapZoom") ?? 14;
  const fallback = buildApproxViewport(centerLat, centerLon, zoom);
  if (fallback) {
    console.warn("[GeoQuery GeoNEMO] viewport original incompleto; se reconstruye un BBOX aproximado desde centro/zoom para compatibilidad temporal.", fallback);
    return fallback;
  }
  console.warn("[GeoQuery GeoNEMO] viewport original incompleto o inválido; se evita búsqueda nacional para SNASPE/Ramsar.", { west, south, east, north });
  return null;
}

function buildViewportFromBounds(west, south, east, north, source) {
  if ([west, south, east, north].every(Number.isFinite) && west < east && south < north && south >= -90 && north <= 90 && west >= -180 && east <= 180) {
    return { west, south, east, north, bbox: [west, south, east, north], polygon: turf.bboxPolygon([west, south, east, north]), source };
  }
  return null;
}

function buildApproxViewport(centerLat, centerLon, zoom) {
  if (!isValidCoordinate(centerLat, centerLon) || !Number.isFinite(zoom)) return null;
  const width = 1280;
  const height = 720;
  const scale = 256 * 2 ** Math.max(0, Math.min(20, zoom));
  const lonPerPixel = 360 / scale;
  const latPerPixel = lonPerPixel / Math.max(0.15, Math.cos(centerLat * Math.PI / 180));
  const west = Math.max(-180, centerLon - (width / 2) * lonPerPixel);
  const east = Math.min(180, centerLon + (width / 2) * lonPerPixel);
  const south = Math.max(-90, centerLat - (height / 2) * latPerPixel);
  const north = Math.min(90, centerLat + (height / 2) * latPerPixel);
  return buildViewportFromBounds(west, south, east, north, "fallback_center_zoom");
}

function bboxIntersects(a, b) {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

function filterFeaturesByViewport(features, originalViewport, groupConfig) {
  if (!originalViewport) return [];
  return features.filter((item) => {
    try {
      const featureBbox = turf.bbox(item.feature);
      if (!bboxIntersects(featureBbox, originalViewport.bbox)) return false;
      return turf.booleanIntersects(item.feature, originalViewport.polygon);
    } catch (error) {
      console.warn("[GeoQuery GeoNEMO] no se pudo confirmar intersección con viewport", groupConfig.id, item.sourceFile, error);
      return false;
    }
  });
}

function buildGroupMetadata(groupConfig, queryRules, loadedLayers, totals, result) {
  return {
    groupId: groupConfig.id,
    queryRulesFile: resolveGroupLayerUrl(groupConfig.__baseUrl, "listado_query.json"),
    totalConfiguredLayers: queryRules.capas.length,
    activeLayers: queryRules.capas.filter((layer) => layer.activo === true).length,
    loadedLayers: loadedLayers.filter((item) => item.status === "loaded").length,
    failedLayers: loadedLayers.filter((item) => item.status === "error").length,
    intersectsLayers: loadedLayers.filter((item) => item.status === "loaded" && item.config.activo === true && item.config.incluir_en_intersects === true).length,
    nearestLayers: loadedLayers.filter((item) => item.status === "loaded" && item.config.activo === true && item.config.incluir_en_nearest === true).length,
    totalFeaturesLoaded: totals.totalLoaded,
    totalFeaturesInViewport: totals.totalInViewport,
    evaluatedCandidates: totals.evaluatedCandidates,
    selectedLayerId: result.feature?.layerId ?? null,
    selectedSourceFile: result.feature?.sourceFile ?? null,
    relationType: result.relation || result.status,
    layerFeatureCounts: loadedLayers.map((item) => ({ id: item.config.id, file: item.config.archivo, status: item.status, features: item.geojson?.features?.length || 0 }))
  };
}

function featureBboxDistanceKm(point, bbox) {
  const [lon, lat] = point.geometry.coordinates;
  if (lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3]) return 0;
  const clampedLon = Math.max(bbox[0], Math.min(lon, bbox[2]));
  const clampedLat = Math.max(bbox[1], Math.min(lat, bbox[3]));
  return turf.distance(point, turf.point([clampedLon, clampedLat]), { units: "kilometers" });
}

function perimeterLine(feature) { return turf.polygonToLine(feature); }

function lineFeatures(feature) {
  const line = perimeterLine(feature);
  if (line.type === "FeatureCollection") return line.features || [];
  return [line];
}

function nearestPointOnFeaturePerimeter(feature, queryPoint) {
  let best = null;
  for (const line of lineFeatures(feature)) {
    const snap = turf.nearestPointOnLine(line, queryPoint, { units: "kilometers" });
    const distanceKm = turf.distance(queryPoint, snap, { units: "kilometers" });
    if (!best || distanceKm < best.distanceKm) best = { snap, distanceKm };
  }
  return best;
}

function perimeterLengthKm(feature) {
  return lineFeatures(feature).reduce((sum, line) => sum + turf.length(line, { units: "kilometers" }), 0);
}

function resolveGroupSpatialRelation(queryPoint, candidatesByRelation, groupConfig, queryRules) {
  const flow = Array.isArray(queryRules.regla_busqueda?.flujo) ? queryRules.regla_busqueda.flujo : ["intersects", "nearest"];
  if (!candidatesByRelation.intersects.length && !candidatesByRelation.nearest.length) return { groupConfig, status: "empty", feature: null };
  for (const relation of flow) {
    if (relation === "intersects") {
      const matches = [];
      for (const item of candidatesByRelation.intersects) {
        try { if (turf.booleanPointInPolygon(queryPoint, item.feature)) matches.push(item); }
        catch (error) { console.warn("No se pudo evaluar intersección", groupConfig.id, item.sourceFile, error); }
      }
      if (matches.length) return buildResolvedResult(groupConfig, matches[0], "intersects", null);
    }
    if (relation === "nearest") {
      let nearest = null;
      for (const item of candidatesByRelation.nearest) {
        try {
          const nearestOnPerimeter = nearestPointOnFeaturePerimeter(item.feature, queryPoint);
          if (nearestOnPerimeter && (!nearest || nearestOnPerimeter.distanceKm < nearest.distanceKm)) nearest = { item, snap: nearestOnPerimeter.snap, distanceKm: nearestOnPerimeter.distanceKm };
        } catch (error) { console.warn("No se pudo evaluar nearest", groupConfig.id, item.sourceFile, error); }
      }
      if (nearest) return buildResolvedResult(groupConfig, nearest.item, "nearest", nearest);
    }
  }
  return { groupConfig, status: "empty", feature: null };
}

function buildResolvedResult(groupConfig, item, relation, nearest) {
  const areaSqm = turf.area(item.feature);
  const perimeterKm = perimeterLengthKm(item.feature);
  const areaHaCalc = areaSqm / 10000;
  const equivalentDiameterKm = 2 * Math.sqrt((areaSqm / 1000000) / Math.PI);
  const equivalentPerimeterKm = Math.PI * equivalentDiameterKm;
  return { groupConfig, status: "resolved", relation, relationType: relation, feature: item, relatedFeature: item.feature, normalizedProperties: item, sourceId: item.sourceId, sourceFile: item.sourceFile, layerId: item.layerId, territory: item.territory, distanceKm: nearest?.distanceKm ?? null, minimumDistanceKm: nearest?.distanceKm ?? null, nearestPoint: nearest?.snap ?? null, nearestBoundaryPoint: nearest?.snap ?? null, metrics: { areaHaCalc, perimeterKm, equivalentDiameterKm, equivalentPerimeterKm } };
}

function formatDistance(km) { return km === null ? "No aplica" : (km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(2)} km`); }
function formatNumber(n, d = 2) { return Number.isFinite(n) ? n.toLocaleString("es-CL", { maximumFractionDigits: d }) : "—"; }
function escapeHtml(v) { return String(v ?? "").replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c])); }
function rows(items) { return `<dl class="details">${items.filter(([,v]) => v !== null && v !== undefined && v !== "").map(([k,v]) => `<div class="detail-row"><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join("")}</dl>`; }

function relationLabel(result) {
  if (result.groupConfig.id === "snaspe") return result.relation === "intersects" ? "Dentro del área SNASPE" : "Área SNASPE más cercana dentro del viewport";
  if (result.groupConfig.id === "ramsar") return result.relation === "intersects" ? "Dentro de un sitio Ramsar" : "Sitio Ramsar más cercano dentro del viewport";
  return result.relation;
}

function renderGroupSection(groupResult) {
  const cfg = groupResult.groupConfig;
  if (groupResult.status !== "resolved") {
    const emptyMessage = cfg.id === "snaspe"
      ? "No existen áreas SNASPE presentes en el viewport consultado"
      : cfg.id === "ramsar"
        ? "No existen sitios Ramsar presentes en el viewport consultado"
        : "No se encontraron geometrías válidas para este grupo.";
    return `<section class="panel group-section"><div class="group-header"><div><h2>Grupo ${escapeHtml(cfg.nombre)}</h2><p class="placeholder-text">${groupResult.status === "error" ? escapeHtml(groupResult.errorMessage || `No fue posible cargar temporalmente el grupo ${cfg.nombre}.`) : emptyMessage}</p></div><span class="status-pill">${escapeHtml(groupResult.status)}</span></div></section>`;
  }
  const f = groupResult.feature;
  const isSnaspe = cfg.id === "snaspe";
  const featureRows = isSnaspe ? [["Tipo de relación", relationLabel(groupResult)], ["Nombre", f.name], ["Categoría", f.category], ["Región", f.region], ["Territorio", f.territory]] : [["Tipo de relación", relationLabel(groupResult)], ["Nombre del sitio", f.name], ["Tipo", f.type], ["Región", f.region], ["Provincia", f.province], ["Comuna", f.commune]];
  const metaRows = isSnaspe ? [["Nombre oficial", f.name], ["Nombre alternativo", f.alternateName], ["Categoría", f.category], ["Decreto", f.decree], ["Emisor", f.issuer], ["Región", f.region], ["Territorio", f.territory], ["Fuente", cfg.nombre_largo], ["Archivo de origen", f.sourceFile], ["Subtipo", f.sourceSubtype]] : [["Nombre", f.name], ["Tipo", f.type], ["Región", f.region], ["Provincia", f.province], ["Comuna", f.commune], ["Decreto", f.decree], ["Superficie oficial", f.areaHa.value === null ? f.areaHa.original : `${formatNumber(f.areaHa.value)} ha`], ["Fuente", cfg.nombre_largo], ["Archivo de origen", f.sourceFile]];
  return `<section class="panel group-section" id="group-${cfg.id}"><div class="group-header"><div><h2>Grupo ${escapeHtml(cfg.nombre)}</h2><p class="placeholder-text">${escapeHtml(cfg.nombre_largo)}</p></div><span class="status-pill">${relationLabel(groupResult)}</span></div><div class="group-grid"><div class="subpanel"><h4>Feature relacionada</h4>${rows(featureRows)}</div><div class="subpanel"><h4>Descriptores geométricos</h4>${rows([["Superficie oficial", f.areaHa.value === null ? f.areaHa.original : `${formatNumber(f.areaHa.value)} ha`], ["Superficie calculada", `${formatNumber(groupResult.metrics.areaHaCalc)} ha`], ["Perímetro", `${formatNumber(groupResult.metrics.perimeterKm)} km`], ["Diámetro equivalente", `${formatNumber(groupResult.metrics.equivalentDiameterKm)} km`], ["Perímetro equivalente", `${formatNumber(groupResult.metrics.equivalentPerimeterKm)} km`]])}</div><div class="subpanel"><h4>Indicadores de relación espacial</h4>${rows([["Tipo de relación", relationLabel(groupResult)], ["Distancia mínima al perímetro", formatDistance(groupResult.distanceKm)], ["Método", groupResult.relation === "nearest" ? "Punto más cercano sobre el perímetro real" : "Intersección punto-polígono"]])}</div><div class="subpanel"><h4>Metadata ${escapeHtml(cfg.nombre)}</h4>${rows(metaRows)}</div></div></section>`;
}

function styleForGroup(groupId) {
  return groupId === "snaspe" ? { color: "#047857", fillColor: "#10b981", weight: 3, fillOpacity: 0.22 } : { color: "#0f766e", fillColor: "#2dd4bf", weight: 3, fillOpacity: 0.18, dashArray: "7 5" };
}

function addGroupResultToMap(groupResult, layers, queryLatLon, boundsParts) {
  if (groupResult.status !== "resolved") return;
  const groupId = groupResult.groupConfig.id;
  const targetLayer = groupId === "snaspe" ? layers.snaspeResultLayer : layers.ramsarResultLayer;
  const geoLayer = L.geoJSON(groupResult.feature.feature, { style: styleForGroup(groupId) }).bindPopup(`${groupResult.groupConfig.nombre}: ${groupResult.feature.name || "Sin nombre"}`).addTo(targetLayer);
  boundsParts.push(geoLayer);
  if (groupResult.relation === "nearest" && groupResult.nearestPoint) {
    const p = groupResult.nearestPoint.geometry.coordinates;
    const line = L.polyline([queryLatLon, [p[1], p[0]]], { color: groupId === "snaspe" ? "#065f46" : "#0e7490", weight: 3, dashArray: "4 6" }).addTo(layers.relationLinesLayer);
    line.bindTooltip(`${groupResult.groupConfig.nombre}: ${formatDistance(groupResult.distanceKm)}`, { permanent: true, direction: "center", className: "relation-label" });
    L.circleMarker([p[1], p[0]], { radius: 5, color: "#111827", fillColor: "#fff", fillOpacity: 1, weight: 2 }).addTo(layers.relationLabelsLayer);
    boundsParts.push(line);
  }
}

function buildExecutiveSummary(results) {
  const resolved = results.filter((r) => r.status === "resolved");
  if (!resolved.length) return "No fue posible resolver grupos temáticos para el punto consultado.";
  const parts = resolved.map((r) => r.relation === "intersects" ? `el punto se encuentra dentro de ${r.groupConfig.nombre}: ${r.feature.name || "sin nombre"}` : `en ${r.groupConfig.nombre}, la figura más cercana es ${r.feature.name || "sin nombre"}, a ${formatDistance(r.distanceKm)}`);
  return `Resultado independiente por grupo: ${parts.join("; ")}.`;
}

function deriveOverallStatus(groupResults) {
  const resolved = groupResults.filter((result) => result.status === "resolved").length;
  const empty = groupResults.filter((result) => result.status === "empty").length;
  const errors = groupResults.filter((result) => result.status === "error").length;
  if (resolved > 0 && errors === 0) return "Resuelto";
  if (resolved > 0 && errors > 0) return "Resuelto parcialmente";
  if (resolved === 0 && empty > 0 && errors === 0) return "Sin resultados en viewport";
  if (resolved === 0 && empty > 0 && errors > 0) return "Resuelto parcialmente";
  return "Error";
}

function applyOverallStatus(elements, overallStatus) {
  elements.cardStatus.classList.remove("status-ok", "status-error", "status-warning", "status-neutral");
  elements.cardStatus.textContent = overallStatus;
  if (overallStatus === "Resuelto") elements.cardStatus.classList.add("status-ok");
  else if (overallStatus === "Error") elements.cardStatus.classList.add("status-error");
  else if (overallStatus === "Sin resultados en viewport") elements.cardStatus.classList.add("status-neutral");
  else elements.cardStatus.classList.add("status-warning");
}

function setupMobileMapGesture(map, mapEl) {
  const hint = document.createElement("div");
  hint.className = "map-touch-hint";
  hint.textContent = "Usa dos dedos para mover el mapa";
  mapEl.appendChild(hint);
  const isCoarse = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
  if (!isCoarse) return;
  map.dragging.disable();
  mapEl.addEventListener("touchstart", (event) => {
    if (event.touches.length >= 2) map.dragging.enable();
    else { map.dragging.disable(); hint.classList.add("visible"); window.clearTimeout(hint.__timer); hint.__timer = window.setTimeout(() => hint.classList.remove("visible"), 1300); }
  }, { passive: true });
  mapEl.addEventListener("touchend", () => map.dragging.disable(), { passive: true });
}

async function processGroup(entry, queryPoint, originalViewport) {
  let groupConfig = { id: entry.id, nombre: entry.nombre, nombre_largo: entry.nombre };
  try {
    groupConfig = await loadGroupConfig(entry);
    const queryRules = await loadQueryRules(groupConfig.id, groupConfig.__baseUrl);
    const loadedLayers = await loadConfiguredQueryLayers(groupConfig.__baseUrl, queryRules);
    const normalizeLayer = (item) => (item.geojson?.features || []).flatMap((feature, index) => feature?.geometry ? [normalizeGroupFeature(groupConfig.id, feature, item.config, groupConfig, index)] : []);
    const intersectsLayers = loadedLayers.filter((item) => item.status === "loaded" && item.config.activo === true && item.config.incluir_en_intersects === true);
    const nearestLayers = loadedLayers.filter((item) => item.status === "loaded" && item.config.activo === true && item.config.incluir_en_nearest === true);
    const intersectsInViewport = filterFeaturesByViewport(intersectsLayers.flatMap(normalizeLayer), originalViewport, groupConfig);
    const nearestInViewport = filterFeaturesByViewport(nearestLayers.flatMap(normalizeLayer), originalViewport, groupConfig);
    const result = resolveGroupSpatialRelation(queryPoint, { intersects: intersectsInViewport, nearest: nearestInViewport }, groupConfig, queryRules);
    result.metadata = buildGroupMetadata(groupConfig, queryRules, loadedLayers, { totalLoaded: loadedLayers.reduce((sum, item) => sum + (item.geojson?.features?.length || 0), 0), totalInViewport: new Set([...intersectsInViewport, ...nearestInViewport].map((item) => `${item.layerId}:${item.featureId}:${item.sourceFile}`)).size, evaluatedCandidates: result.relation === "intersects" ? intersectsInViewport.length : nearestInViewport.length }, result);
    if (GEOQUERY_DEBUG) console.log("[GeoQuery GeoNEMO] capa seleccionada", { group: groupConfig.id, layerId: result.layerId, sourceFile: result.sourceFile, territory: result.territory, relation: result.relation });
    return result;
  } catch (error) {
    console.error("Error controlado al cargar grupo GeoNEMO", entry.id, error);
    const message = entry.id === "snaspe" ? "No fue posible cargar temporalmente la configuración o las capas del grupo SNASPE." : entry.id === "ramsar" ? "No fue posible cargar temporalmente la configuración o las capas del grupo Ramsar." : `No fue posible cargar temporalmente la configuración o las capas del grupo ${entry.nombre}.`;
    return { groupConfig, status: "error", feature: null, errorMessage: message, metadata: { groupId: entry.id, relationType: "error" } };
  }
}




function formatGeoNemoPdfMeters(km) {
  if (!Number.isFinite(Number(km))) return "N/D";
  const meters = Number(km) * 1000;
  return meters < 1000 ? `${Math.round(meters).toLocaleString("es-CL")} m` : `${Number(km).toLocaleString("es-CL", { maximumFractionDigits: 2 })} km`;
}

function geoNemoPdfRelationType(result) {
  if (result?.status !== "resolved") return "none";
  return result.relation === "intersects" ? "intersects" : "nearest";
}

function geoNemoPdfRelationLabel(type) {
  return type === "intersects" ? "Intersección" : type === "nearest" ? "Cercanía" : "Sin resultado";
}

function geoNemoPdfPartsCount(geometry) {
  if (!geometry) return null;
  if (geometry.type === "MultiPolygon" || geometry.type === "MultiLineString" || geometry.type === "GeometryCollection") return Array.isArray(geometry.coordinates) ? geometry.coordinates.length : Array.isArray(geometry.geometries) ? geometry.geometries.length : null;
  return 1;
}

function geoNemoPdfMetadataRows(properties) {
  const ignored = new Set(["geometry", "coordinates"]);
  const seen = new Set();
  return Object.entries(properties || {}).filter(([key, value]) => {
    const label = String(key || "").trim();
    const text = String(value ?? "").trim();
    const lower = label.toLowerCase();
    if (!label || ignored.has(lower) || !text || /^(undefined|null|nan)$/i.test(text)) return false;
    if (typeof value === "object") return false;
    if (seen.has(lower)) return false;
    seen.add(lower);
    return true;
  }).map(([label, value]) => ({ label, value: String(value) }));
}

function buildGeoNemoReportGroup(result) {
  const cfg = result.groupConfig || {};
  const f = result.feature || {};
  const props = f.originalProperties || result.relatedFeature?.properties || {};
  const relationType = geoNemoPdfRelationType(result);
  const hasResult = result.status === "resolved" && !!f;
  const distanceMeters = relationType === "intersects" ? 0 : Number.isFinite(Number(result.distanceKm)) ? Number(result.distanceKm) * 1000 : null;
  const areaHa = f.areaHa?.value ?? (Number.isFinite(Number(result.metrics?.areaHaCalc)) ? result.metrics.areaHaCalc : null);
  const surfaceFormatted = f.areaHa?.value === null && f.areaHa?.original ? String(f.areaHa.original) : Number.isFinite(Number(areaHa)) ? `${formatNumber(Number(areaHa))} ha` : "N/D";
  const title = cfg.id === "ramsar" ? "Ramsar" : (cfg.nombre || cfg.id || "Grupo");
  const source = {
    registryPath: result.metadata?.queryRulesFile || "",
    layerName: result.layerId || result.metadata?.selectedLayerId || f.layerId || "",
    fileName: result.sourceFile || result.metadata?.selectedSourceFile || f.sourceFile || "",
    displayName: cfg.nombre_largo || cfg.nombre || title,
    organization: cfg.nombre_largo || "GeoNEMO"
  };
  const metadata = geoNemoPdfMetadataRows(props);
  return {
    id: cfg.id || result.groupId || "grupo",
    title,
    enabled: true,
    resolved: result.status === "resolved",
    hasResult,
    source,
    relation: { type: relationType, label: geoNemoPdfRelationLabel(relationType), pointInside: relationType === "intersects", distanceMeters, distanceFormatted: relationType === "intersects" ? "Intersección directa" : formatGeoNemoPdfMeters(result.distanceKm) },
    feature: { found: hasResult, id: f.featureId || "", name: f.name || "", category: f.category || f.type || "", territory: f.territory || result.territory || "", surfaceM2: Number.isFinite(Number(areaHa)) ? Number(areaHa) * 10000 : null, surfaceHa: Number.isFinite(Number(areaHa)) ? Number(areaHa) : null, surfaceFormatted, commune: f.commune || "", region: f.region || "", properties: props },
    geometryDescriptors: { areaM2: Number.isFinite(Number(result.metrics?.areaHaCalc)) ? result.metrics.areaHaCalc * 10000 : null, areaHa: Number.isFinite(Number(result.metrics?.areaHaCalc)) ? result.metrics.areaHaCalc : areaHa, perimeterM: Number.isFinite(Number(result.metrics?.perimeterKm)) ? result.metrics.perimeterKm * 1000 : null, perimeterFormatted: Number.isFinite(Number(result.metrics?.perimeterKm)) ? `${formatNumber(result.metrics.perimeterKm)} km` : "N/D", distanceToPointMeters: distanceMeters, distanceToPointFormatted: relationType === "intersects" ? "0 m" : formatGeoNemoPdfMeters(result.distanceKm), geometryType: result.relatedFeature?.geometry?.type || f.geometry?.type || "", partsCount: geoNemoPdfPartsCount(result.relatedFeature?.geometry || f.geometry), additionalMetrics: [] },
    spatialIndicators: { relationLabel: geoNemoPdfRelationLabel(relationType), pointInside: relationType === "intersects", minimumDistance: relationType === "intersects" ? "0 m" : formatGeoNemoPdfMeters(result.distanceKm), nearestFeature: f.name || "", featureCategory: f.category || f.type || "", additionalIndicators: [] },
    metadata,
    sources: [["Registro de grupo", source.registryPath], ["Archivo GeoJSON", source.fileName], ["Fuente institucional", source.displayName], ["Nombre de capa", source.layerName]].filter(([,v]) => v).map(([label, value]) => ({ label, value })),
    emptyMessage: cfg.id === "snaspe" ? "No se identificó una figura SNASPE relacionada para esta consulta." : cfg.id === "ramsar" ? "No se identificó un sitio Ramsar relacionado para esta consulta." : `No se identificó una figura relacionada para el grupo ${title}.`
  };
}

function buildGeoNemoReportModelFromResolvedState() {
  const state = window.geoQueryState || {};
  const groups = (state.groupResults || []).map(buildGeoNemoReportGroup);
  const resolvedGroups = groups.filter((g) => g.resolved && g.hasResult).length;
  const files = groups.flatMap((g) => g.source?.fileName ? [g.source.fileName] : []);
  const executiveParts = groups.map((g) => {
    if (!g.hasResult) return `Para ${g.title}, ${g.emptyMessage}`;
    if (g.relation.type === "intersects") return `El punto consultado intersecta ${g.feature.name || "la figura relacionada"} del grupo ${g.title}.`;
    return `La figura más cercana del grupo ${g.title} es ${g.feature.name || "sin nombre"}, ubicada a ${g.relation.distanceFormatted}.`;
  });
  const technicalMetadata = [
    { label: "Fecha de consulta", value: state.timestamp }, { label: "Latitud decimal", value: state.lat_decimal }, { label: "Longitud decimal", value: state.lon_decimal }, { label: "Latitud GMS", value: state.lat_dms }, { label: "Longitud GMS", value: state.lon_dms }, { label: "CRS", value: state.crs }, { label: "Basemap", value: state.basemap }, { label: "Grupos activos", value: groups.length }, { label: "Grupos resueltos", value: resolvedGroups }, { label: "Registro de grupos", value: "capas_geoquery/listado.json" }, { label: "Regla espacial", value: "intersects + nearest al perímetro real por grupo" }, { label: "Restricción al viewport original", value: state.original_viewport ? "Sí" : "No" }, { label: "Archivos usados", value: files.join(", ") }, { label: "Versión del reporte", value: "geonemo-pdf-v2" }, { label: "Estado de carga", value: state.overallStatus || state.status }
  ];
  return {
    identity: { site: "GeoNEMO", title: "Reporte del punto consultado", generatedAt: new Date().toISOString(), version: "geonemo-pdf-v2" },
    query: { lat: state.lat, lon: state.lon, latDms: state.lat_dms, lonDms: state.lon_dms, crs: state.crs, source: state.source === "url_params" ? "parámetro URL" : state.source, originSite: state.site, state: state.overallStatus || state.status, basemap: state.basemap, region: "No informado", commune: "No informado" },
    summary: { executiveText: `Se analizaron de manera independiente ${groups.length} grupos temáticos. ${executiveParts.join(" ")}`, resolvedGroups, totalGroups: groups.length },
    groups,
    technicalMetadata,
    sources: groups.flatMap((g) => g.sources || []),
    methodology: ["Los grupos se analizan de manera independiente.", "Se evalúa intersección con el punto consultado.", "Cuando no existe intersección, se obtiene la figura más cercana al perímetro real.", "La búsqueda utiliza las capas registradas para cada grupo y los elementos cargados para el viewport original.", "Las distancias se expresan desde el punto consultado hacia la feature relacionada.", "Los resultados de distintos grupos no se fusionan."],
    disclaimer: "Reporte documental generado automáticamente desde GeoQuery. La información mantiene carácter referencial y debe contrastarse con fuentes oficiales.",
    sections: []
  };
}

window.buildGeoNemoReportModelFromResolvedState = buildGeoNemoReportModelFromResolvedState;

function hasKmlValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "number") return Number.isFinite(value);
  const text = String(value).trim();
  return text !== "" && !/^(undefined|null|NaN|Infinity)$/i.test(text);
}

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function safeCdata(value) {
  return String(value ?? "").replace(/]]>/g, "]]]]><![CDATA[>");
}

function firstKmlValue(...values) {
  return values.find(hasKmlValue) ?? "";
}

function formatKmlDistance(result) {
  return result?.relation === "nearest" && Number.isFinite(Number(result?.minimumDistanceKm)) ? formatDistance(Number(result.minimumDistanceKm)) : "";
}

function formatKmlArea(areaHa) {
  if (!areaHa) return "";
  if (areaHa.value === null || areaHa.value === undefined) return firstKmlValue(areaHa.original);
  return `${formatNumber(areaHa.value)} ha`;
}

function getSnaspeKmlMetadata(result) {
  const normalized = result?.normalizedProperties || result?.feature || {};
  const properties = result?.relatedFeature?.properties || normalized.originalProperties || {};
  const territory = firstKmlValue(result?.territory, normalized.territory, properties.TERRITORIO);
  const territoryFallbackName = territory === "maritimo" ? "Área SNASPE marítima" : territory === "continental" ? "Área SNASPE continental" : "Área SNASPE relacionada";
  return {
    group: "SNASPE",
    name: firstKmlValue(properties.NOMBRE_TOT, properties.NOMBRE_UNI, normalized.name, territoryFallbackName),
    unitName: firstKmlValue(properties.NOMBRE_UNI, normalized.alternateName),
    category: firstKmlValue(normalized.category, properties.CATEGORIA),
    protectionType: firstKmlValue(normalized.category, properties.CATEGORIA),
    territory,
    region: firstKmlValue(normalized.region, properties.REGION),
    commune: firstKmlValue(normalized.commune, properties.COMUNA),
    area: firstKmlValue(formatKmlArea(normalized.areaHa), properties.SUPERFICIE),
    decree: firstKmlValue(normalized.decree, properties.DECRETO),
    date: firstKmlValue(normalized.date, properties.FECHA, properties.FECHA_DEC),
    administration: firstKmlValue(normalized.issuer, properties.EMISOR_DEC),
    source: firstKmlValue(result?.groupConfig?.nombre_largo),
    sourceId: firstKmlValue(result?.sourceId, normalized.sourceId),
    sourceFile: firstKmlValue(result?.sourceFile, normalized.sourceFile),
    identifier: firstKmlValue(normalized.featureId, properties.ID_CATASTR, properties.fid),
    relationType: firstKmlValue(result?.relationType, result?.relation),
    relationLabel: relationLabel(result),
    minimumDistanceKm: result?.minimumDistanceKm,
    distance: formatKmlDistance(result)
  };
}

function getRamsarKmlMetadata(result) {
  const normalized = result?.normalizedProperties || result?.feature || {};
  const properties = result?.relatedFeature?.properties || normalized.originalProperties || {};
  return {
    group: "Ramsar",
    name: firstKmlValue(normalized.name, properties.Nombre, "Sitio Ramsar relacionado"),
    figureType: firstKmlValue(normalized.type, properties.Tipo, "Sitio Ramsar"),
    region: firstKmlValue(normalized.region, properties.Nomreg),
    province: firstKmlValue(normalized.province, properties.Nomprov),
    commune: firstKmlValue(normalized.commune, properties.Nomcom),
    area: firstKmlValue(formatKmlArea(normalized.areaHa), properties.superficie),
    designationDate: firstKmlValue(normalized.date, properties.Fecha, properties.FECHA),
    identifier: firstKmlValue(normalized.featureId, properties.Id, properties.tid),
    decree: firstKmlValue(normalized.decree, properties.Decreto),
    description: firstKmlValue(properties.Descripcion, properties.description),
    source: firstKmlValue(result?.groupConfig?.nombre_largo),
    sourceId: firstKmlValue(result?.sourceId, normalized.sourceId),
    sourceFile: firstKmlValue(result?.sourceFile, normalized.sourceFile),
    relationType: firstKmlValue(result?.relationType, result?.relation),
    relationLabel: relationLabel(result),
    minimumDistanceKm: result?.minimumDistanceKm,
    distance: formatKmlDistance(result)
  };
}

function kmlRows(items) {
  const body = items.filter(([, value]) => hasKmlValue(value)).map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`).join("");
  return body ? `<table>${body}</table>` : "";
}

function kmlSection(title, items) {
  const table = kmlRows(items);
  return table ? `<h3>${escapeHtml(title)}</h3>${table}` : "";
}

function buildSnaspeKmlDescription(metadata) {
  return `<h2>${escapeHtml(metadata.name)}</h2>${kmlSection("Identificación del área", [["Grupo", metadata.group], ["Nombre oficial", metadata.name], ["Nombre de unidad", metadata.unitName], ["Categoría", metadata.category], ["Tipo de figura", metadata.protectionType], ["Territorio", metadata.territory], ["Región", metadata.region], ["Comuna", metadata.commune], ["Superficie", metadata.area], ["Decreto o instrumento", metadata.decree], ["Fecha", metadata.date], ["Institución o administración", metadata.administration], ["Identificador", metadata.identifier]])}${kmlSection("Relación espacial", [["Tipo de relación", metadata.relationLabel], ["Distancia mínima", metadata.distance]])}${kmlSection("Fuente", [["Fuente", metadata.source], ["ID de fuente", metadata.sourceId], ["Archivo", metadata.sourceFile]])}`;
}

function buildRamsarKmlDescription(metadata) {
  return `<h2>${escapeHtml(metadata.name)}</h2>${kmlSection("Identificación del sitio", [["Grupo", metadata.group], ["Nombre", metadata.name], ["Figura", metadata.figureType], ["Región", metadata.region], ["Provincia", metadata.province], ["Comuna o ubicación", metadata.commune], ["Superficie", metadata.area], ["Fecha de designación", metadata.designationDate], ["Número o identificador Ramsar", metadata.identifier], ["Decreto o instrumento", metadata.decree], ["Descripción", metadata.description]])}${kmlSection("Relación espacial", [["Tipo de relación", metadata.relationLabel], ["Distancia mínima", metadata.distance]])}${kmlSection("Fuente", [["Fuente", metadata.source], ["ID de fuente", metadata.sourceId], ["Archivo", metadata.sourceFile]])}`;
}

function buildKmlExtendedData(entries) {
  return Object.fromEntries(entries.filter(([, value]) => hasKmlValue(value)));
}

function buildSnaspeKmlExtendedData(metadata) {
  return buildKmlExtendedData([["Grupo", metadata.group], ["Nombre", metadata.name], ["Nombre de unidad", metadata.unitName], ["Categoría", metadata.category], ["Tipo de figura", metadata.protectionType], ["Territorio", metadata.territory], ["Región", metadata.region], ["Comuna", metadata.commune], ["Superficie", metadata.area], ["Decreto", metadata.decree], ["Fecha", metadata.date], ["Institución o administración", metadata.administration], ["Identificador", metadata.identifier], ["Tipo de relación", metadata.relationLabel], ["Distancia mínima", metadata.distance], ["Fuente", metadata.source], ["ID de fuente", metadata.sourceId], ["Archivo de origen", metadata.sourceFile]]);
}

function buildRamsarKmlExtendedData(metadata) {
  return buildKmlExtendedData([["Grupo", metadata.group], ["Nombre", metadata.name], ["Tipo de figura", metadata.figureType], ["Región", metadata.region], ["Provincia", metadata.province], ["Comuna o ubicación", metadata.commune], ["Superficie", metadata.area], ["Fecha de designación", metadata.designationDate], ["Identificador", metadata.identifier], ["Decreto", metadata.decree], ["Tipo de relación", metadata.relationLabel], ["Distancia mínima", metadata.distance], ["Fuente", metadata.source], ["ID de fuente", metadata.sourceId], ["Archivo de origen", metadata.sourceFile]]);
}

function buildAuxiliaryKmlDescription(metadata) {
  return kmlSection("Relación espacial", [["Grupo", metadata.group], ["Nombre", metadata.name], ["Tipo de relación", metadata.relationLabel], ["Distancia mínima", metadata.distance], ["Archivo de origen", metadata.sourceFile]]);
}

const GEO_NEMO_KML_IDS = {
  queryPoint: "geonemo-query-point",
  snaspeFeature: "geonemo-snaspe-feature",
  ramsarFeature: "geonemo-ramsar-feature",
  snaspeNearestLine: "geonemo-snaspe-nearest-line",
  ramsarNearestLine: "geonemo-ramsar-nearest-line",
  snaspeDistanceLabel: "geonemo-snaspe-distance-label",
  ramsarDistanceLabel: "geonemo-ramsar-distance-label",
  snaspeContactPoint: "geonemo-snaspe-contact-point",
  ramsarContactPoint: "geonemo-ramsar-contact-point"
};

function addUniqueGeoNemoExportItem(registry, item) {
  if (!item?.id) return;
  if (registry.has(item.id)) {
    console.warn(`[GeoNEMO KML] Elemento duplicado omitido: ${item.id}`);
    return;
  }
  if (item.role) {
    if (!registry.semanticRoles) registry.semanticRoles = new Set();
    const groupId = item.role === "query-point" ? "general" : (item.groupId || "general");
    const roleKey = `${groupId}:${item.role}`;
    if (registry.semanticRoles.has(roleKey)) {
      console.warn(`[GeoNEMO KML] Elemento con rol duplicado omitido: ${roleKey}`);
      return;
    }
    registry.semanticRoles.add(roleKey);
  }
  registry.set(item.id, item);
}

function validateNoDuplicateSemanticRoles(exportItems) {
  const seen = new Set();
  (exportItems || []).forEach(item => {
    if (!item?.role) return;
    const groupId = item.role === "query-point" ? "general" : (item.groupId || "general");
    const key = `${groupId}:${item.role}`;
    if (seen.has(key)) {
      console.warn(`[GeoNEMO KML] Rol semántico duplicado omitido o requiere revisión: ${key}`);
      return;
    }
    seen.add(key);
  });
}

function geoNemoGroupKmlId(groupId) {
  return groupId === "ramsar" ? "ramsar" : "snaspe";
}

function buildGeoNemoMapExport(results) {
  const state = window.geoQueryState || {};
  const theme = GeoQueryKmlExporter.themeFor("geonemo");
  const st = GeoQueryKmlExporter.themedStyle("geonemo", "line", { weight: 3, fill: true });
  const labelStyle = { ...st, kmlTextColor: theme.textColor, kmlHaloColor: null, labelScale: 1, iconScale: 0 };
  const hiddenLabelStyle = { ...st, labelScale: 0 };
  const folders = [
    { id: "query", name: "Punto consultado" },
    { id: "snaspe", name: "SNASPE" },
    { id: "ramsar", name: "Sitio Ramsar" },
    { id: "relations", name: "Relación espacial" },
    { id: "labels", name: "Etiquetas" }
  ];
  const registry = new Map();

  addUniqueGeoNemoExportItem(registry, {
    id: GEO_NEMO_KML_IDS.queryPoint,
    groupId: "general",
    role: "query-point",
    folderId: "query",
    type: "point",
    name: "Punto consultado",
    geometry: { type: "Point", coordinates: [state.lon, state.lat] },
    style: { ...st, fillOpacity: .95, weight: 3, labelScale: 1 },
    extendedData: { Latitud: state.lat_decimal, Longitud: state.lon_decimal, CRS: state.crs },
    visible: true
  });

  (results || []).filter(r => r.status === "resolved" && r.relatedFeature?.geometry).forEach(r => {
    const gid = geoNemoGroupKmlId(r.groupConfig?.id || r.groupId);
    const isSnaspe = gid === "snaspe";
    const metadata = isSnaspe ? getSnaspeKmlMetadata(r) : getRamsarKmlMetadata(r);
    const description = isSnaspe ? buildSnaspeKmlDescription(metadata, r) : buildRamsarKmlDescription(metadata, r);
    const extendedData = isSnaspe ? buildSnaspeKmlExtendedData(metadata, r) : buildRamsarKmlExtendedData(metadata, r);
    const name = metadata.name || r.groupConfig?.nombre || gid;
    const folderId = isSnaspe ? "snaspe" : "ramsar";

    addUniqueGeoNemoExportItem(registry, {
      id: GEO_NEMO_KML_IDS[`${gid}Feature`],
      groupId: gid,
      role: "related-feature",
      folderId,
      type: r.relatedFeature.geometry?.type?.toLowerCase(),
      name,
      geometry: r.relatedFeature.geometry,
      style: { ...st, ...hiddenLabelStyle, opacity: 1 },
      description,
      extendedData,
      properties: { ...(r.relatedFeature.properties || {}) },
      visible: true
    });

    const label = turf.pointOnFeature(r.relatedFeature)?.geometry?.coordinates;
    if (label) addUniqueGeoNemoExportItem(registry, {
      id: `geonemo-${gid}-feature-label`,
      groupId: gid,
      role: "feature-label",
      folderId: "labels",
      type: "label",
      name,
      geometry: { type: "Point", coordinates: label },
      style: labelStyle,
      description,
      extendedData,
      properties: { ...(r.relatedFeature.properties || {}) },
      visible: true
    });

    if (r.nearestPoint?.geometry?.coordinates) {
      const p = r.nearestPoint.geometry.coordinates;
      const line = [[state.lon, state.lat], p];
      const mid = turf.midpoint(turf.point(line[0]), turf.point(line[1])).geometry.coordinates;
      const auxDescription = buildAuxiliaryKmlDescription(metadata);
      const auxExtendedData = buildKmlExtendedData([["Grupo", metadata.group], ["Nombre", metadata.name], ["Tipo de relación", metadata.relationLabel], ["Distancia mínima", metadata.distance], ["Archivo de origen", metadata.sourceFile]]);
      const distanceLabel = `${isSnaspe ? "Distancia SNASPE" : "Distancia Ramsar"}: ${formatDistance(r.distanceKm)}`;

      addUniqueGeoNemoExportItem(registry, {
        id: GEO_NEMO_KML_IDS[`${gid}NearestLine`],
        groupId: gid,
        role: "nearest-line",
        folderId: "relations",
        type: "line",
        name: "Relación espacial",
        geometry: { type: "LineString", coordinates: line },
        style: { ...st, weight: 3, opacity: 1, dashArray: "4 6", labelScale: 0 },
        description: auxDescription,
        extendedData: auxExtendedData,
        visible: true
      });
      addUniqueGeoNemoExportItem(registry, {
        id: GEO_NEMO_KML_IDS[`${gid}ContactPoint`],
        groupId: gid,
        role: "contact-point",
        folderId: "relations",
        type: "point",
        name: "Punto de contacto con perímetro",
        geometry: { type: "Point", coordinates: p },
        style: { ...st, fillOpacity: 1, weight: 2, iconType: "contact", labelScale: 1 },
        description: auxDescription,
        extendedData: auxExtendedData,
        visible: true
      });
      addUniqueGeoNemoExportItem(registry, {
        id: GEO_NEMO_KML_IDS[`${gid}DistanceLabel`],
        groupId: gid,
        role: "distance-label",
        folderId: "labels",
        type: "label",
        name: distanceLabel,
        geometry: { type: "Point", coordinates: mid },
        style: { ...labelStyle, labelScale: .9 },
        description: auxDescription,
        extendedData: auxExtendedData,
        visible: true
      });
    }
  });

  const features = Array.from(registry.values());
  validateNoDuplicateSemanticRoles(features);
  console.table(features.map(item => ({ id: item.id, groupId: item.groupId, role: item.role, name: item.name, geometryType: item.geometry?.type })));
  return { site: "geonemo", documentName: "GeoQuery | GeoNEMO", documentDescription: state.executiveSummary, queryPoint: { lat: state.lat, lon: state.lon }, folders, features };
}

window.geoQueryKmlRefresh = GeoQueryKmlExporter.installGeoQueryKmlButton(() => window.geoQueryState.mapExport);

(function initGeoQuery() {
  const params = new URLSearchParams(window.location.search);
  const lat = Number.parseFloat(params.get("lat"));
  const lon = Number.parseFloat(params.get("lon"));
  const site = getParam(params, "site", "geonemo");
  const basemapParam = (getParam(params, "basemap", "osm") || "osm").toLowerCase();
  let currentBasemap = basemapParam === "sat" ? "sat" : "osm";
  const zoomFromIndex = getParam(params, "zoom", getParam(params, "mapZoom", "14"));
  const viewLat = getParam(params, "viewLat", getParam(params, "mapCenterLat", null));
  const viewLon = getParam(params, "viewLon", getParam(params, "mapCenterLon", null));
  const from = getParam(params, "from", null);
  const originalViewport = parseOriginalViewport(params);
  const valid = isValidCoordinate(lat, lon);
  const elements = {
    cardLat: document.getElementById("card-lat"), cardLon: document.getElementById("card-lon"), cardSite: document.getElementById("card-site"), cardStatus: document.getElementById("card-status"), latDecimal: document.getElementById("lat-decimal"), lonDecimal: document.getElementById("lon-decimal"), latDms: document.getElementById("lat-dms"), lonDms: document.getElementById("lon-dms"), detailStatus: document.getElementById("detail-status"), invalidMessage: document.getElementById("invalid-message"), detailsPanel: document.getElementById("details-panel"), backLink: document.getElementById("back-link"), visualCaption: document.getElementById("visual-caption"), groups: document.getElementById("geoquery-groups"), summary: document.getElementById("executive-summary"), loadStatus: document.getElementById("groups-load-status")
  };
  elements.cardSite.textContent = site;
  if (!valid) { elements.cardStatus.textContent = "Sin coordenada"; elements.cardStatus.classList.add("status-error"); elements.invalidMessage.hidden = false; elements.detailsPanel.hidden = true; elements.backLink.href = "../index.html"; return; }
  const latDecimal = lat.toFixed(6); const lonDecimal = lon.toFixed(6); const latDms = decimalToDMS(lat, "lat"); const lonDms = decimalToDMS(lon, "lon"); const targetZoom = getZoomForApproxScale(lat, 20000);
  window.geoQueryState = { site, queryContext: { site, queryPoint: { lat, lon }, originalViewport: originalViewport ? { centerLat: Number(viewLat), centerLon: Number(viewLon), zoom: Number(zoomFromIndex), west: originalViewport.west, south: originalViewport.south, east: originalViewport.east, north: originalViewport.north, basemap: currentBasemap } : { centerLat: Number(viewLat), centerLon: Number(viewLon), zoom: Number(zoomFromIndex), basemap: currentBasemap }, from }, status: "loading", executiveSummary: "", groupResults: [], mapState: { basemap: currentBasemap, referenceScale: "1:20.000", referenceZoom: targetZoom }, exportState: { pdfEnabled: false, kmlEnabled: false }, lat, lon, lat_decimal: latDecimal, lon_decimal: lonDecimal, lat_dms: latDms, lon_dms: lonDms, view_lat: viewLat, view_lon: viewLon, original_viewport: originalViewport ? { west: originalViewport.west, south: originalViewport.south, east: originalViewport.east, north: originalViewport.north } : null, crs: "WGS84 / EPSG:4326", source: "url_params", basemap: currentBasemap, zoom_from_index: zoomFromIndex, map_reference_scale: "1:20.000", map_reference_zoom: targetZoom, timestamp: new Date().toISOString(), groupMetadata: [] };
  elements.cardLat.textContent = latDecimal; elements.cardLon.textContent = lonDecimal; elements.cardStatus.textContent = "Analizando"; elements.cardStatus.classList.add("status-ok"); elements.latDecimal.textContent = latDecimal; elements.lonDecimal.textContent = lonDecimal; elements.latDms.textContent = latDms; elements.lonDms.textContent = lonDms; elements.detailStatus.textContent = "analizando grupos temáticos"; elements.visualCaption.textContent = `Punto consultado: ${latDecimal}, ${lonDecimal}`;

  const geoQueryMap = L.map("geoquery-map", { zoomControl: true, zoomSnap: 0.25, zoomDelta: 0.25 });
  window.geoQueryLeafletMap = geoQueryMap;
  const osmLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 20, attribution: "&copy; OpenStreetMap" });
  const satLayer = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 20, attribution: "Tiles &copy; Esri" });
  const toggle = L.DomUtil.create("div", "map-toggle");
  toggle.innerHTML = `<button id="geoquery-osm-btn" class="map-toggle-btn" type="button" data-map="osm">OSM</button><button id="geoquery-sat-btn" class="map-toggle-btn" type="button" data-map="sat">SAT</button>`;
  document.getElementById("geoquery-map").appendChild(toggle); L.DomEvent.disableClickPropagation(toggle); L.DomEvent.disableScrollPropagation(toggle);
  function updateReturnLink() { elements.backLink.href = buildReturnUrl(lat, lon, zoomFromIndex || "14", currentBasemap, viewLat, viewLon); }
  elements.backLink?.addEventListener("click", (event) => { if (history.length > 1) { event.preventDefault(); history.back(); } });
  function setBasemapButtonActive(type) { document.getElementById("geoquery-osm-btn")?.classList.toggle("active", type === "osm"); document.getElementById("geoquery-sat-btn")?.classList.toggle("active", type === "sat"); }
  function setBasemap(type) { if (geoQueryMap.hasLayer(osmLayer)) geoQueryMap.removeLayer(osmLayer); if (geoQueryMap.hasLayer(satLayer)) geoQueryMap.removeLayer(satLayer); (type === "sat" ? satLayer : osmLayer).addTo(geoQueryMap); currentBasemap = type === "sat" ? "sat" : "osm"; setBasemapButtonActive(currentBasemap); window.geoQueryState.basemap = currentBasemap; window.geoQueryState.mapState.basemap = currentBasemap; window.geoQueryState.queryContext.originalViewport.basemap = currentBasemap; updateReturnLink(); }
  toggle.querySelector('[data-map="osm"]').addEventListener("click", () => setBasemap("osm")); toggle.querySelector('[data-map="sat"]').addEventListener("click", () => setBasemap("sat"));
  setBasemap(currentBasemap);
  const layers = { snaspeResultLayer: L.layerGroup().addTo(geoQueryMap), ramsarResultLayer: L.layerGroup().addTo(geoQueryMap), relationLinesLayer: L.layerGroup().addTo(geoQueryMap), queryPointLayer: L.layerGroup().addTo(geoQueryMap), relationLabelsLayer: L.layerGroup().addTo(geoQueryMap) };
  const queryMarker = L.circleMarker([lat, lon], { radius: 7, weight: 3, color: "#064e3b", fillColor: "#facc15", fillOpacity: 0.95 }).bindPopup("Punto consultado").addTo(layers.queryPointLayer);
  L.control.scale({ position: "bottomleft", metric: true, imperial: false, maxWidth: 120 }).addTo(geoQueryMap);
  const legend = L.control({ position: "bottomright" }); legend.onAdd = () => { const div = L.DomUtil.create("div", "map-legend"); div.innerHTML = '<div><span class="legend-swatch" style="background:#10b981"></span>SNASPE</div><div><span class="legend-swatch" style="background:#2dd4bf"></span>Ramsar</div>'; return div; }; legend.addTo(geoQueryMap);
  setupMobileMapGesture(geoQueryMap, document.getElementById("geoquery-map"));
  geoQueryMap.setView([lat, lon], targetZoom, { animate: false }); updateReturnLink();

  (async () => {
    if (GEOQUERY_DEBUG) {
      console.log("[GeoNEMO] URL actual:", window.location.href);
      console.log("[GeoNEMO] parámetros:", Object.fromEntries(new URLSearchParams(window.location.search)));
    }
    const queryPoint = turf.point([lon, lat]);
    const entries = await loadGroupRegistry();
    const groupSettlements = await Promise.allSettled(entries.map((entry) => processGroup(entry, queryPoint, originalViewport)));
    const results = groupSettlements.map((settlement, index) => settlement.status === "fulfilled" ? settlement.value : { groupConfig: { id: entries[index].id, nombre: entries[index].nombre, nombre_largo: entries[index].nombre }, status: "error", feature: null, errorMessage: entries[index].id === "snaspe" ? "No fue posible cargar temporalmente la configuración o las capas del grupo SNASPE." : "No fue posible cargar temporalmente la configuración o las capas del grupo Ramsar.", metadata: { groupId: entries[index].id, relationType: "error" } });
    window.geoQueryState.groupResults = results;
    window.geoQueryState.groupMetadata = results.map((result) => result.metadata).filter(Boolean);
    if (GEOQUERY_DEBUG) console.log("[GeoQuery GeoNEMO] metadata viewport por grupo", window.geoQueryState.groupMetadata);
    elements.groups.innerHTML = results.map(renderGroupSection).join("");
    const executiveSummary = buildExecutiveSummary(results);
    elements.summary.textContent = executiveSummary;
    if (elements.loadStatus) elements.loadStatus.textContent = GEOQUERY_DEBUG ? results.map((r) => `${r.groupConfig.nombre}: ${r.status} (${r.metadata?.totalInViewport ?? 0} en viewport)`).join(" | ") : "";
    const technicalPanel = document.getElementById("geoquery-technical-metadata");
    if (technicalPanel) technicalPanel.hidden = !GEOQUERY_DEBUG;
    const downloadsPanel = document.getElementById("geoquery-downloads-panel");
    if (downloadsPanel) downloadsPanel.hidden = !results.some((r) => r.status === "resolved");
    const overallStatus = deriveOverallStatus(results);
    applyOverallStatus(elements, overallStatus);
    elements.detailStatus.textContent = overallStatus === "Error" ? "error técnico en todos los grupos" : overallStatus === "Sin resultados en viewport" ? "sin resultados en el viewport original" : "análisis territorial resuelto por grupos";
    window.geoQueryState.overallStatus = overallStatus;
    window.geoQueryState.status = overallStatus === "Resuelto" ? "resolved" : overallStatus === "Sin resultados en viewport" ? "empty" : overallStatus === "Error" ? "error" : "partial";
    window.geoQueryState.executiveSummary = executiveSummary;
    window.geoQueryState.exportState = { pdfEnabled: results.some((r) => r.status === "resolved"), kmlEnabled: results.some((r) => r.status === "resolved") };
    window.geoQueryState.mapExport = buildGeoNemoMapExport(results);
    window.__geonemoReportModel = buildGeoNemoReportModelFromResolvedState();
    window.geoQueryKmlRefresh?.();
    const boundsParts = [queryMarker];
    results.forEach((result) => addGroupResultToMap(result, layers, [lat, lon], boundsParts));
    setTimeout(() => { geoQueryMap.invalidateSize(); const bounds = L.featureGroup(boundsParts).getBounds(); if (bounds.isValid()) geoQueryMap.fitBounds(bounds.pad(0.12), { maxZoom: 14, padding: window.innerWidth <= 560 ? [22, 22] : [36, 36], animate: false }); else geoQueryMap.setView([lat, lon], targetZoom, { animate: false }); }, 150);
  })().catch((error) => { console.error("Error al inicializar GeoQuery GeoNEMO", error); elements.summary.textContent = "No fue posible cargar temporalmente el registro de grupos de GeoNEMO."; elements.cardStatus.textContent = "Error"; });
})();
