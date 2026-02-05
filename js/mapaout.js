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

const HAS_TURF = typeof turf !== "undefined";

let mainMap = null;
let pointMarker = null;
let groupMaps = {}; // { groupId: leaflet map instance }
let groupLayers = {}; // { groupId: leaflet layer }
let mainMapBounds = null; // Guardar bounds originales para recentrar

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

function normalizarRegiones(regionStr) {
  if (!regionStr) return [];
  const separators = /[;,\/]|\s+y\s+/gi;
  const partes = regionStr.split(separators).map((r) => r.trim()).filter(Boolean);
  return partes.map((r) => r.replace(/^Región\s+(de\s+)?/i, "").trim());
}

function getDictamen(linkType) {
  if (linkType === "inside") return { text: "DENTRO", class: "in" };
  if (linkType === "nearest_perimeter") return { text: "PROXIMIDAD", class: "prox" };
  if (linkType === "none") return { text: "SIN DATOS", class: "none" };
  if (linkType === "error") return { text: "ERROR", class: "none" };
  return { text: "—", class: "none" };
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

function initMainMap(lat, lng, links) {
  mainMap = L.map("map", { zoomControl: true, preferCanvas: true }).setView([lat, lng], 12);

  L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    {
      maxZoom: 19,
      attribution: "Tiles &copy; Esri",
      crossOrigin: true,
    }
  ).addTo(mainMap);

  // ✅ aplica filtro B/N SOLO en el mapa principal
  applyMainMapMonochrome(mainMap);

  pointMarker = L.circleMarker([lat, lng], {
    radius: 8,
    weight: 3,
    color: "#65a30d",
    fillColor: "#bef264",
    fillOpacity: 0.8,
    zIndexOffset: 1000,
  }).addTo(mainMap);

  pointMarker.bindTooltip("📍 Punto consultado", { permanent: false, direction: "top" });

  const bounds = L.latLngBounds([lat, lng]);
  let hasGeometries = false;

  links.forEach((link, idx) => {
    const distanceM = link.distance_m;
    const feature = link.feature;

    if (!feature || distanceM == null || !isFinite(distanceM) || distanceM > MAX_DISTANCE_FOR_DRAW) return;

    const data = extractGroupData(link);
    const dictamen = getDictamen(link.link_type);

    let color = "#22c55e";
    let fillOpacity = 0.12;
    if (link.link_type === "inside") {
      color = "#22c55e";
      fillOpacity = 0.18;
    } else if (link.link_type === "nearest_perimeter") {
      color = "#f59e0b";
      fillOpacity = 0.12;
    }

    const layer = L.geoJSON(feature, {
      style: {
        color: color,
        weight: 2,
        fillColor: color,
        fillOpacity: fillOpacity,
      },
    }).addTo(mainMap);

    try {
      bounds.extend(layer.getBounds());
      hasGeometries = true;
    } catch (e) {}

    const distKm = fmtKm(distanceM);
    const tooltipContent = `
      <div style="min-width:180px;">
        <div style="font-weight:600;margin-bottom:4px;">${link.layer_name || link.layer_id}</div>
        <div style="font-size:0.9em;opacity:0.85;margin-bottom:4px;">${data.nombre}</div>
        <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px;">
          <span class="badgeMini ${dictamen.class}" style="font-size:0.75em;padding:2px 6px;">${dictamen.text}</span>
          <span style="font-size:0.85em;">${link.link_type === "inside" ? "0 km" : distKm}</span>
        </div>
        <button
          onclick="scrollToGroup(${idx})"
          class="btnSm btn--primary"
          style="width:100%;font-size:0.8em;padding:4px 8px;"
        >
          ↓ Ver detalle
        </button>
      </div>
    `;

    layer.bindPopup(tooltipContent, { maxWidth: 250 });
    layer.on("click", () => {
      layer.openPopup();
    });
  });

  if (hasGeometries) {
    try {
      mainMap.fitBounds(bounds, { padding: [40, 40] });
      mainMapBounds = bounds;
    } catch (e) {
      mainMap.setView([lat, lng], 12);
      mainMapBounds = null;
    }
  } else {
    mainMap.setView([lat, lng], 12);
    mainMapBounds = null;
  }

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
      <strong>Para este punto, lo más relevante es que ${p.text}.</strong>
    `;
    const next = near.find((l) => l !== inside);
    if (next) {
      const p2 = pickPhrase(next);
      mainHTML += ` Como antecedente cercano adicional, aparece ${p2.text}.`;
    }
  } else if (first) {
    const p1 = pickPhrase(first);
    mainHTML += `
      <strong>Para este punto, lo más relevante es que la referencia protegida más cercana corresponde al grupo <strong>${p1.grupoNombre}</strong>:</strong>
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

  const map = L.map(containerId, { zoomControl: false, preferCanvas: true }).setView([lat, lng], 12);

  L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    {
      maxZoom: 19,
      attribution: "Tiles &copy; Esri",
      crossOrigin: true,
    }
  ).addTo(map);

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
          toggleBtn.textContent = "📍 Punto + área";
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
          toggleBtn.textContent = "🗺️ Solo área";
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
  }

  if (layerId.includes("ramsar")) {
    nombre = props.Nombre || props.nombre || props.NOMBRE || "—";
    tipo = props.Tipo || props.tipo || null;

    const reg = props.Nomreg || props.nomreg || null;
    const prov = props.Nomprov || props.nomprov || null;
    const com = props.Nomcom || props.nomcom || null;
    ubicacion = [reg, prov, com].filter(Boolean).join(", ") || null;

    decreto = props.Decreto || props.decreto || null;
  }

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
    ubicacion,
    tipo,
  };
}

/* ===========================
   Renderizar tarjeta de grupo (≤300 km) con mapa
=========================== */
function renderGroupCard(link, clickLat, clickLng, index) {
  const dictamen = getDictamen(link.link_type);
  const distanceM = link.distance_m;
  const distanceBorderM = link.distance_border_m;
  const data = extractGroupData(link);

  const groupId = `group-${index}`;
  const mapId = `map-${groupId}`;

  const distKm = distanceM != null ? fmtKm(distanceM) : "—";
  const borderKm = distanceBorderM != null ? fmtKm(distanceBorderM) : null;
  const isInside = link.link_type === "inside";

  const bodyId = `body-${groupId}`;
  const toggleBtnId = `toggle-${mapId}`;

  let bodyHTML = `
    <div class="groupBody" id="${bodyId}">
      <div class="groupGrid">
        <div class="groupMapCard">
          <div class="groupMapHead">
            <div class="left">${data.nombre}</div>
            <div class="right">
              <button class="btnSm btn--ghost" id="${toggleBtnId}" type="button">🗺️ Solo área</button>
            </div>
          </div>
          <div class="groupMap" id="${mapId}"></div>
        </div>

        <div class="groupSide">
          <div class="groupKpis">
            <div>
              <div class="kpi__label">Dictamen</div>
              <div class="badge badge--${dictamen.class}">${dictamen.text}</div>
            </div>
            <div>
              <div class="kpi__label">Distancia mínima</div>
              <div class="kpi__value">${isInside ? "0 km (dentro)" : distKm}</div>
            </div>
            ${borderKm && link.link_type !== "none" ? `
            <div>
              <div class="kpi__label">Distancia al borde</div>
              <div class="kpi__value">${borderKm}</div>
            </div>
            ` : ""}
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
        <div class="badgeMini ${dictamen.class}">${dictamen.text}</div>
        <div class="badgeMini">${isInside ? "0 km" : distKm}</div>
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
          initGroupMap(mapId, clickLat, clickLng, link.feature, distanceM);
        }, 100);
      }
    });
  }
}

/* ===========================
   Renderizar tarjeta LITE (>300 km) SIN MAPA (solo info relevante)
=========================== */
function renderGroupCardLite(link, index) {
  const dictamen = getDictamen(link.link_type);
  const distanceM = link.distance_m;
  const distanceBorderM = link.distance_border_m;
  const data = extractGroupData(link);

  const groupId = `far-${index}`;
  const bodyId = `body-${groupId}`;

  const distKm = distanceM != null ? fmtKm(distanceM) : "—";
  const borderKm = distanceBorderM != null ? fmtKm(distanceBorderM) : null;
  const isInside = link.link_type === "inside";

  let bodyHTML = `
    <div class="groupBody isHidden" id="${bodyId}">
      <div class="groupGrid" style="grid-template-columns: 1fr;">
        <div class="groupSide" style="max-width: 100%;">
          <div class="groupKpis">
            <div>
              <div class="kpi__label">Dictamen</div>
              <div class="badge badge--${dictamen.class}">${dictamen.text}</div>
            </div>
            <div>
              <div class="kpi__label">Distancia mínima</div>
              <div class="kpi__value">${isInside ? "0 km (dentro)" : distKm}</div>
            </div>
            ${borderKm && link.link_type !== "none" ? `
            <div>
              <div class="kpi__label">Distancia al borde</div>
              <div class="kpi__value">${borderKm}</div>
            </div>
            ` : ""}
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
        <div class="badgeMini ${dictamen.class}">${dictamen.text}</div>
        <div class="badgeMini">${isInside ? "0 km" : distKm}</div>
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

    if (!click.lat || !click.lng) {
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
   Botones de acción
=========================== */
function bindUI() {
  const btnBack = document.getElementById("btnBack");
  if (btnBack) {
    btnBack.addEventListener("click", () => {
      if (window.opener) {
        window.close();
      } else {
        window.history.back();
      }
    });
  }

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

  const btnCopyLink = document.getElementById("btnCopyLink");
  if (btnCopyLink) {
    btnCopyLink.addEventListener("click", () => {
      navigator.clipboard
        .writeText(window.location.href)
        .then(() => {
          toast("✅ Link copiado", 1500);
        })
        .catch(() => {
          toast("⚠️ No se pudo copiar el link", 2000);
        });
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
