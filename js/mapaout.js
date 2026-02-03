/************************************************************
 * GeoNEMO - mapaout.js
 * Lee localStorage["geonemo_out_v2"], renderiza resultados por grupo
 * con mapas individuales, lazy-draw de geometrías, y formateo inteligente.
 ************************************************************/

const STORAGE_KEY = "geonemo_out_v2";
const MAX_DISTANCE_FOR_DRAW = 300000; // 300 km - más allá no dibujamos geometría

let mainMap = null;
let pointMarker = null;
let groupMaps = {}; // { groupId: leaflet map instance }
let groupLayers = {}; // { groupId: leaflet layer }
let mainMapBounds = null; // Guardar bounds originales para recentrar

/* ===========================
   Scroll helpers
=========================== */
window.scrollToGroup = function(index) {
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

window.scrollToTop = function() {
  window.scrollTo({ top: 0, behavior: "smooth" });
};

window.recenterMainMap = function() {
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
  const partes = regionStr.split(separators).map(r => r.trim()).filter(Boolean);
  return partes.map(r => r.replace(/^Región\s+(de\s+)?/i, "").trim());
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
  
  let angulo = Math.atan2(dLng, dLat) * 180 / Math.PI;
  if (angulo < 0) angulo += 360;
  
  const direcciones = [
    "N", "NNE", "NE", "ENE", 
    "E", "ESE", "SE", "SSE",
    "S", "SSO", "SO", "OSO",
    "O", "ONO", "NO", "NNO"
  ];
  
  const idx = Math.round(angulo / 22.5) % 16;
  return direcciones[idx];
}

/* ===========================
   Mapa principal (punto + geometrías resumen)
=========================== */
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
    
    if (!feature || !distanceM || distanceM > MAX_DISTANCE_FOR_DRAW) return;

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
   Generar resumen textual de áreas detectadas
=========================== */
function generarResumenAreas(lat, lng, links) {
  const resumenEl = document.getElementById("resumenAreas");
  if (!resumenEl) return;

  const areasDetectadas = links.filter(link => {
    return link.feature && link.distance_m != null && link.distance_m <= MAX_DISTANCE_FOR_DRAW;
  });

  if (!areasDetectadas.length) {
    resumenEl.innerHTML = `
      <p class="muted" style="margin:0;font-size:0.9rem;">
        No se detectaron áreas protegidas en un radio de 300 km del punto consultado.
      </p>
    `;
    return;
  }

  let html = '<div style="font-size:0.9rem;line-height:1.6;color:var(--text);">';
  
  areasDetectadas.forEach((link, idx) => {
    const data = extractGroupData(link);
    const dictamen = getDictamen(link.link_type);
    const distKm = link.distance_m / 1000;
    const isInside = link.link_type === "inside";
    
    let orientacion = "";
    if (!isInside && link.feature?.geometry) {
      try {
        const centroid = turf.centroid(link.feature);
        const [centLng, centLat] = centroid.geometry.coordinates;
        orientacion = calcularOrientacion(lat, lng, centLat, centLng);
      } catch (e) {
        orientacion = "—";
      }
    }

    let superficie = data.superficie || "—";
    if (superficie === "—" && link.feature?.geometry) {
      try {
        const areaM2 = turf.area(link.feature);
        superficie = fmtArea(areaM2);
      } catch (e) {}
    }

    const grupoNombre = link.layer_name || link.layer_id;
    const areaNombre = data.nombre !== "—" ? data.nombre : "área sin nombre";
    
    if (isInside) {
      html += `
        El punto consultado está <strong>dentro</strong> del grupo <strong>${grupoNombre}</strong>, 
        en el área <em>${areaNombre}</em> (${superficie}).
      `;
    } else {
      html += `
        El punto consultado está asociado al grupo <strong>${grupoNombre}</strong>, 
        con el área <em>${areaNombre}</em> (${superficie}), 
        ubicada a <strong>${distKm.toFixed(2)} km</strong> de distancia 
        hacia el <strong>${orientacion}</strong>.
      `;
    }
    
    if (idx < areasDetectadas.length - 1) {
      html += '<br><br>';
    }
  });
  
  html += '</div>';
  resumenEl.innerHTML = html;
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

  if (layerId.includes("snaspe")) {
    nombre = props.NOMBRE_TOT || props.NOMBRE_UNI || props.NOMBRE || props.nombre || "—";
    categoria = props.CATEGORIA || props.TIPO_DE_PR || props.categoria || null;
    
    if (props.SUPERFICIE != null) {
      const s = String(props.SUPERFICIE).toLowerCase();
      if (s.includes("km") || s.includes("km2") || s.includes("km²")) {
        superficie = s;
      } else if (s.includes("ha")) {
        superficie = s;
      } else {
        const num = parseFloat(s.replace(/[^\d.,]/g, "").replace(",", "."));
        if (!isNaN(num)) {
          superficie = num > 10000 ? fmtArea(num * 10000) : fmtArea(num);
        }
      }
    }
    
    if (!superficie && link.feature?.geometry) {
      try {
        const areaM2 = turf.area(link.feature);
        superficie = fmtArea(areaM2);
      } catch (e) {}
    }

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

    if (props.SUPERFICIE != null) {
      const s = String(props.SUPERFICIE);
      superficie = s.includes("ha") || s.includes("km") ? s : fmtArea(parseFloat(s) * 10000);
    } else if (link.feature?.geometry) {
      try {
        const areaM2 = turf.area(link.feature);
        superficie = fmtArea(areaM2);
      } catch (e) {}
    }
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
   Renderizar tarjeta de grupo
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
  const isFar = distanceM != null && distanceM > MAX_DISTANCE_FOR_DRAW;

  const bodyId = `body-${groupId}`;
  const toggleBtnId = `toggle-${mapId}`;
  
  let bodyHTML = `
    <div class="groupBody" id="${bodyId}">
      <div class="groupGrid">
        <div class="groupMapCard">
          <div class="groupMapHead">
            <div class="left">${data.nombre}</div>
            <div class="right">
              ${isFar ? 
                '<span class="small muted">+300 km (sin mapa)</span>' : 
                `<button class="btnSm btn--ghost" id="${toggleBtnId}" type="button">🗺️ Solo área</button>`
              }
            </div>
          </div>
          ${isFar ? 
            '<div class="groupMap" style="display:flex;align-items:center;justify-content:center;background:#f5f5f5;color:#999;">Distancia muy grande para visualizar</div>' :
            `<div class="groupMap" id="${mapId}"></div>`
          }
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
            ${borderKm ? `
            <div>
              <div class="kpi__label">Distancia al borde</div>
              <div class="kpi__value">${borderKm}</div>
            </div>
            ` : ''}
          </div>

          <div class="groupAttrs">
            <table class="attrTable">
  `;

  if (data.categoria) {
    bodyHTML += `<tr><td class="k">Categoría</td><td class="v">${data.categoria}</td></tr>`;
  }
  if (data.tipo) {
    bodyHTML += `<tr><td class="k">Tipo</td><td class="v">${data.tipo}</td></tr>`;
  }
  if (data.superficie) {
    bodyHTML += `<tr><td class="k">Superficie</td><td class="v">${data.superficie}</td></tr>`;
  }
  if (data.regiones.length) {
    bodyHTML += `<tr><td class="k">Región(es)</td><td class="v">${data.regiones.join(", ")}</td></tr>`;
  }
  if (data.ubicacion) {
    bodyHTML += `<tr><td class="k">Ubicación</td><td class="v">${data.ubicacion}</td></tr>`;
  }
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
      
      if (!isHidden && !isFar && !groupMaps[mapId]) {
        setTimeout(() => {
          initGroupMap(mapId, clickLat, clickLng, link.feature, distanceM);
        }, 100);
      }
    });

    if (index > 0) {
      body.classList.add("isHidden");
      const chevron = head.querySelector(".groupChevron");
      if (chevron) chevron.textContent = "▶";
    } else {
      if (!isFar) {
        setTimeout(() => {
          initGroupMap(mapId, clickLat, clickLng, link.feature, distanceM);
        }, 200);
      }
    }
  }
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

    sorted.forEach((link, idx) => {
      renderGroupCard(link, click.lat, click.lng, idx);
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
      navigator.clipboard.writeText(window.location.href).then(() => {
        toast("✅ Link copiado", 1500);
      }).catch(() => {
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