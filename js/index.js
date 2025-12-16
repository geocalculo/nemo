/************************************************************
 * GeoConserva - index.js (GeoJSON UTM 19S)
 * - Basemap: OSM normal (tile.openstreetmap.org) como GeoIPT
 *   + fallback automático a OSM HOT (sigue siendo OSM)
 * - GeoJSON en EPSG:32719 (UTM 19S): capas/nuevo_2.geojson
 * - Click Leaflet (EPSG:4326) -> reproyecta a UTM 19S con proj4
 * - Consulta punto/polígono con Turf (mismo CRS)
 * - NO dibuja polígonos (solo punto clickeado)
 * - Regiones.json solo navegación/zoom
 ************************************************************/

const REGIONES_URL = "data/regiones.json";
const GEOJSON_URL  = "capas/nuevo_2.geojson"; // asegúrate del nombre exacto
const HOME_VIEW = { center: [-33.5, -71.0], zoom: 5 };

// CRS
const CRS_WGS84 = "EPSG:4326";
const CRS_UTM19S = "EPSG:32719";

let map;
let userMarker = null;
let clickMarker = null;

let dataLoaded = false;
let featuresIndex = []; // [{ feature, bbox:[minx,miny,maxx,maxy] }]

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

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setPanel({ nav="—", click="—", estado="—", sub="", attrs=null, categoria="SNASPE" }) {
  const sbNav = document.getElementById("sbNav");
  const sbClick = document.getElementById("sbClick");
  const sbEstado = document.getElementById("sbEstado");
  const sbSub = document.getElementById("sbSub");
  const sbAttrs = document.getElementById("sbAttrs");
  const sbCategoria = document.getElementById("sbCategoria");

  if (sbNav) sbNav.textContent = nav;
  if (sbClick) sbClick.textContent = click;
  if (sbEstado) sbEstado.textContent = estado;
  if (sbSub) sbSub.textContent = sub;
  if (sbCategoria) sbCategoria.textContent = categoria;

  if (attrs !== null && sbAttrs) sbAttrs.innerHTML = attrs;
}

function attrsToHtml(props = {}) {
  const keys = Object.keys(props);
  if (!keys.length) return `<div class="muted">Sin atributos.</div>`;

  // Orden sugerido (si existe)
  const preferred = ["NOMBRE", "nombre", "Name", "name", "CATEGORIA", "categoria", "TIPO", "tipo"];
  const ordered = [];
  for (const k of preferred) if (k in props) ordered.push(k);
  for (const k of keys) if (!ordered.includes(k)) ordered.push(k);

  return ordered.map(k => {
    const v = props[k];
    const vv = (v === null || v === undefined || v === "") ? "—" : String(v);
    return `
      <div class="attr">
        <div class="ak">${escapeHtml(k)}</div>
        <div class="av">${escapeHtml(vv)}</div>
      </div>
    `;
  }).join("");
}

function bboxContainsXY(bb, x, y) {
  return x >= bb[0] && x <= bb[2] && y >= bb[1] && y <= bb[3];
}

// ===========================
// Distancias geométricas (UTM)
// ===========================

// distancia punto-segmento
function pointToSegmentDistance(x, y, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;

  if (dx === 0 && dy === 0) {
    return Math.hypot(x - x1, y - y1);
  }

  const t = ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy);
  const tt = Math.max(0, Math.min(1, t));

  const cx = x1 + tt * dx;
  const cy = y1 + tt * dy;

  return Math.hypot(x - cx, y - cy);
}

// distancia mínima a un anillo
function minDistanceToRing(x, y, ring) {
  let dmin = Infinity;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    const d = pointToSegmentDistance(x, y, x1, y1, x2, y2);
    if (d < dmin) dmin = d;
  }
  return dmin;
}

// distancia mínima al perímetro (Polygon / MultiPolygon)
function distanceToPerimeterUTM(feature, x, y) {
  const g = feature.geometry;
  let dmin = Infinity;

  if (g.type === "Polygon") {
    g.coordinates.forEach(ring => {
      dmin = Math.min(dmin, minDistanceToRing(x, y, ring));
    });
  }

  if (g.type === "MultiPolygon") {
    g.coordinates.forEach(poly => {
      poly.forEach(ring => {
        dmin = Math.min(dmin, minDistanceToRing(x, y, ring));
      });
    });
  }

  return dmin;
}

function fmtMeters(m) {
  if (!isFinite(m)) return "—";
  return m < 1000 ? `${m.toFixed(1)} m` : `${(m / 1000).toFixed(2)} km`;
}


/* ===========================
   Map init (OSM normal + fallback)
=========================== */

function crearMapa() {
  map = L.map("map", { zoomControl: true, preferCanvas: true })
    .setView(HOME_VIEW.center, HOME_VIEW.zoom);

  // ✅ OSM normal (GeoIPT)
  const osmNormal = L.tileLayer(
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    {
      maxZoom: 19,
      subdomains: "abc",
      attribution: "&copy; OpenStreetMap contributors",
      crossOrigin: true,
      updateWhenIdle: true
    }
  );

  // ✅ Fallback OSM (HOT) - sigue siendo OSM
  const osmHOT = L.tileLayer(
    "https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png",
    {
      maxZoom: 19,
      subdomains: "abc",
      attribution: "&copy; OpenStreetMap contributors, HOT",
      crossOrigin: true,
      updateWhenIdle: true
    }
  );

  osmNormal.addTo(map);

  // Fallback automático si el normal falla (bloqueo/rate limit/adblock)
  let switched = false;
  osmNormal.on("tileerror", () => {
    if (switched) return;
    switched = true;
    try { map.removeLayer(osmNormal); } catch(_) {}
    osmHOT.addTo(map);
    toast("⚠️ OSM normal falló. Cambié a OSM HOT.", 2600);
  });

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
    if (!opt || !opt.value) {
      setPanel({ nav: "—" });
      return;
    }
    let center = null;
    try { center = JSON.parse(opt.dataset.center); } catch(_) {}
    const zoom = parseInt(opt.dataset.zoom || "7", 10);

    if (Array.isArray(center) && center.length === 2) {
      map.setView(center, zoom, { animate: true });
      setPanel({ nav: opt.textContent });
      setTimeout(() => map.invalidateSize(true), 150);
    }
  });
}

/* ===========================
   GeoJSON load (UTM 19S)
=========================== */

async function loadGeoJSON() {
  if (dataLoaded) return;

  if (!window.proj4) {
    throw new Error("proj4 no está cargado. Agrega proj4 antes de index.js");
  }

  // Definir UTM 19S si no existe
  if (!proj4.defs(CRS_UTM19S)) {
    proj4.defs(CRS_UTM19S, "+proj=utm +zone=19 +south +datum=WGS84 +units=m +no_defs");
  }

  setPanel({
    estado: "Cargando…",
    sub: `Cargando SNASPE desde ${GEOJSON_URL} (UTM 19S)`,
    attrs: `<div class="muted">Cargando datos…</div>`
  });

  const res = await fetch(GEOJSON_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`No se pudo cargar ${GEOJSON_URL} (HTTP ${res.status})`);

  const gj = await res.json();
  const feats = gj.features || [];

  featuresIndex = [];
  for (const f of feats) {
    const t = f?.geometry?.type;
    if (t === "Polygon" || t === "MultiPolygon") {
      try {
        const bb = turf.bbox(f); // bbox en UTM (m)
        featuresIndex.push({ feature: f, bbox: bb });
      } catch (_) {}
    }
  }

  if (!featuresIndex.length) {
    throw new Error("GeoJSON sin polígonos válidos (Polygon/MultiPolygon).");
  }

  dataLoaded = true;
  toast(`✅ GeoJSON cargado (${featuresIndex.length} polígonos)`, 2000);

  setPanel({
    estado: "Listo",
    sub: "Haz clic en el mapa para consultar pertenencia (punto/polígono).",
    attrs: `<div class="muted">Datos cargados. Aún no hay selección.</div>`
  });
}

/* ===========================
   Click consulta (WGS84 -> UTM19S)
=========================== */

async function onMapClick(e) {
  const lat = e.latlng.lat;
  const lng = e.latlng.lng;

  if (clickMarker) map.removeLayer(clickMarker);
  clickMarker = L.circleMarker([lat, lng], {
    radius: 7,
    weight: 2,
    opacity: 1,
    fillOpacity: 0.25
  }).addTo(map);

  const sel = document.getElementById("selRegion");
  const navName = (sel && sel.value) ? sel.options[sel.selectedIndex].textContent : "—";

  setPanel({
    nav: navName,
    click: `${lat.toFixed(6)}, ${lng.toFixed(6)}`,
    estado: "Consultando…",
    sub: "Evaluando pertenencia y distancia al perímetro…",
    attrs: `<div class="muted">Procesando…</div>`
  });

  try {
    await loadGeoJSON();
  } catch (err) {
    console.error(err);
    toast("⚠️ Error cargando GeoJSON", 2600);
    return;
  }

  // reproyección WGS84 → UTM 19S
  const [x, y] = proj4(CRS_WGS84, CRS_UTM19S, [lng, lat]);
  const pt = turf.point([x, y]);

  // ===========================
  // 1) ¿DENTRO de algún polígono?
  // ===========================
  for (const it of featuresIndex) {
    if (!bboxContainsXY(it.bbox, x, y)) continue;

    if (turf.booleanPointInPolygon(pt, it.feature)) {
      const d = distanceToPerimeterUTM(it.feature, x, y);

      toast(`✅ DENTRO · salida en ${fmtMeters(d)}`, 1800);
      setPanel({
        nav: navName,
        click: `${lat.toFixed(6)}, ${lng.toFixed(6)}`,
        estado: "DENTRO",
        sub: `Distancia mínima al perímetro (para salir): ${fmtMeters(d)}`,
        attrs: attrsToHtml(it.feature.properties || {})
      });
      return;
    }
  }

  // ===========================
  // 2) FUERA → polígono más cercano
  // ===========================
  let best = { d: Infinity, feature: null };

  for (const it of featuresIndex) {
    // optimización: bbox expandida
    if (isFinite(best.d)) {
      const bb = it.bbox;
      const pad = best.d;
      if (
        x < bb[0] - pad || x > bb[2] + pad ||
        y < bb[1] - pad || y > bb[3] + pad
      ) continue;
    }

    const d = distanceToPerimeterUTM(it.feature, x, y);
    if (d < best.d) best = { d, feature: it.feature };
  }

  if (best.feature) {
    toast(`❌ FUERA · más cercano a ${fmtMeters(best.d)}`, 2200);
    setPanel({
      nav: navName,
      click: `${lat.toFixed(6)}, ${lng.toFixed(6)}`,
      estado: "FUERA",
      sub: `Distancia mínima al área protegida más cercana: ${fmtMeters(best.d)}`,
      attrs: attrsToHtml(best.feature.properties || {})
    });
  }
}


/* ===========================
   Botones
=========================== */

function clearSelection() {
  if (clickMarker) {
    map.removeLayer(clickMarker);
    clickMarker = null;
  }

  const sel = document.getElementById("selRegion");
  const navName = (sel && sel.value) ? sel.options[sel.selectedIndex].textContent : "—";

  setPanel({
    nav: navName,
    click: "—",
    estado: dataLoaded ? "Listo" : "—",
    sub: "Haz clic en el mapa para consultar pertenencia (punto/polígono).",
    attrs: `<div class="muted">Aún no hay selección.</div>`
  });
}

function bindUI() {
  const btnHome = document.getElementById("btnHome");
  const btnGPS = document.getElementById("btnGPS");
  const btnClear = document.getElementById("btnClear");
  const btnPreload = document.getElementById("btnPreload");

  if (btnHome) {
    btnHome.addEventListener("click", () => {
      map.setView(HOME_VIEW.center, HOME_VIEW.zoom, { animate: true });
      toast("🏠 Vista inicial", 1200);
      setTimeout(() => map.invalidateSize(true), 150);
    });
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
        },
        () => toast("⚠️ No pude obtener tu ubicación", 2600),
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
      );
    });
  }

  if (btnClear) {
    btnClear.addEventListener("click", () => {
      clearSelection();
      toast("🧹 Selección limpiada", 1200);
    });
  }

  if (btnPreload) {
    btnPreload.addEventListener("click", async () => {
      try {
        await loadGeoJSON();
      } catch (err) {
        console.error(err);
        toast("⚠️ Error precargando GeoJSON (ver consola)", 2400);
      }
    });
  }F
}

/* ===========================
   Init
=========================== */

(async function init() {
  crearMapa();
  bindUI();
  await cargarRegiones();
  clearSelection();
  toast("Listo ✅ Selecciona región para navegar y haz clic para consultar SNASPE.", 2600);
})();
