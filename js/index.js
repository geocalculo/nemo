/************************************************************
 * GeoConserva - index.js (GeoJSON UTM 19S + Distancia + Rumbo)
 * - Basemap: OSM normal (tile.openstreetmap.org) como GeoIPT
 *   + fallback automático a OSM HOT (sigue siendo OSM)
 * - GeoJSON en EPSG:32719 (UTM 19S): capas/nuevo_2.geojson
 * - Click Leaflet (EPSG:4326) -> reproyecta a UTM 19S con proj4
 * - Consulta punto/polígono con Turf (mismo CRS)
 * - Calcula distancia mínima al perímetro + rumbo hacia el punto más cercano
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

function fmtMeters(m) {
  if (!isFinite(m)) return "—";
  return m < 1000 ? `${m.toFixed(1)} m` : `${(m / 1000).toFixed(2)} km`;
}

/* ===========================
   Distancias geométricas (UTM)
   + rumbo hacia el punto más cercano del perímetro
=========================== */

function pointToSegmentDistanceWithPoint(x, y, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;

  // segmento degenerado
  if (dx === 0 && dy === 0) {
    const d = Math.hypot(x - x1, y - y1);
    return { d, cx: x1, cy: y1 };
  }

  const t = ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy);
  const tt = Math.max(0, Math.min(1, t));

  const cx = x1 + tt * dx;
  const cy = y1 + tt * dy;

  const d = Math.hypot(x - cx, y - cy);
  return { d, cx, cy };
}

function minDistanceToRing(x, y, ring) {
  let best = { d: Infinity, cx: null, cy: null };

  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];

    const r = pointToSegmentDistanceWithPoint(x, y, x1, y1, x2, y2);
    if (r.d < best.d) best = r;
  }
  return best; // { d, cx, cy }
}

function distanceToPerimeterUTM(feature, x, y) {
  const g = feature.geometry;
  let best = { d: Infinity, cx: null, cy: null };

  if (g.type === "Polygon") {
    g.coordinates.forEach(ring => {
      const r = minDistanceToRing(x, y, ring);
      if (r.d < best.d) best = r;
    });
  }

  if (g.type === "MultiPolygon") {
    g.coordinates.forEach(poly => {
      poly.forEach(ring => {
        const r = minDistanceToRing(x, y, ring);
        if (r.d < best.d) best = r;
      });
    });
  }

  return best; // { d, cx, cy }
}

// Rumbo azimutal desde el Norte (0°) sentido horario: 90° Este, 180° Sur, 270° Oeste
function rumboDesdeNorte(x1, y1, x2, y2) {
  const dE = x2 - x1; // Este
  const dN = y2 - y1; // Norte
  let ang = Math.atan2(dE, dN) * 180 / Math.PI; // ojo: (E, N)
  if (ang < 0) ang += 360;
  return ang;
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
   + distancia y rumbo
=========================== */

async function onMapClick(e) {
  const lat = e.latlng.lat;
  const lng = e.latlng.lng;

  if (clickMarker) map.removeLayer(clickMarker);
  clickMarker = L.circleMarker([lat, lng], {
    radius: 7, weight: 2, opacity: 1, fillOpacity: 0.25
  }).addTo(map);

  const sel = document.getElementById("selRegion");
  const navName = (sel && sel.value) ? sel.options[sel.selectedIndex].textContent : "—";

  setPanel({
    nav: navName,
    click: `${lat.toFixed(6)}, ${lng.toFixed(6)}`,
    estado: "Consultando…",
    sub: "Reproyectando clic a UTM 19S y calculando distancia + rumbo…",
    attrs: `<div class="muted">Procesando…</div>`
  });

  try {
    await loadGeoJSON();
  } catch (err) {
    console.error(err);
    toast("⚠️ Error cargando GeoJSON (ver consola)", 2600);
    setPanel({
      nav: navName,
      click: `${lat.toFixed(6)}, ${lng.toFixed(6)}`,
      estado: "Error",
      sub: "No se pudo cargar el GeoJSON.",
      attrs: `<div class="muted">Revisa consola.</div>`
    });
    return;
  }

  // ✅ WGS84 -> UTM19S
  const [x, y] = proj4(CRS_WGS84, CRS_UTM19S, [lng, lat]);

  const pt = turf.point([x, y]);

  // 1) Buscar si cae dentro
  for (const it of featuresIndex) {
    if (!bboxContainsXY(it.bbox, x, y)) continue;

    let inside = false;
    try { inside = turf.booleanPointInPolygon(pt, it.feature); } catch (_) {}

    if (inside) {
      // DENTRO: distancia mínima al perímetro para salir + rumbo hacia el perímetro
      const r = distanceToPerimeterUTM(it.feature, x, y);
      const rumbo = rumboDesdeNorte(x, y, r.cx, r.cy);

      toast(`✅ DENTRO · salida ${fmtMeters(r.d)} · ${rumbo.toFixed(1)}°`, 2200);

      setPanel({
        nav: navName,
        click: `${lat.toFixed(6)}, ${lng.toFixed(6)}`,
        estado: "DENTRO",
        sub: `Para salir: ${fmtMeters(r.d)} · Rumbo: ${rumbo.toFixed(1)}° (N=0°, S=180°)`,
        attrs: attrsToHtml(it.feature.properties || {})
      });
      return;
    }
  }

  // 2) FUERA: polígono más cercano por distancia al perímetro
  let best = { d: Infinity, cx: null, cy: null, feature: null };

  for (const it of featuresIndex) {
    // optimización: bbox expandida (cuando ya existe candidato)
    if (isFinite(best.d)) {
      const bb = it.bbox;
      const pad = best.d;
      if (
        x < bb[0] - pad || x > bb[2] + pad ||
        y < bb[1] - pad || y > bb[3] + pad
      ) continue;
    }

    const r = distanceToPerimeterUTM(it.feature, x, y);
    if (r.d < best.d) best = { ...r, feature: it.feature };
  }

  if (best.feature) {
    const rumbo = rumboDesdeNorte(x, y, best.cx, best.cy);

    toast(`❌ FUERA · ${fmtMeters(best.d)} · ${rumbo.toFixed(1)}°`, 2400);

    setPanel({
      nav: navName,
      click: `${lat.toFixed(6)}, ${lng.toFixed(6)}`,
      estado: "FUERA",
      sub: `Más cercano: ${fmtMeters(best.d)} · Rumbo: ${rumbo.toFixed(1)}° (N=0°, S=180°)`,
      attrs: attrsToHtml(best.feature.properties || {})
    });
  } else {
    toast("❌ FUERA · sin polígonos válidos", 2200);
    setPanel({
      nav: navName,
      click: `${lat.toFixed(6)}, ${lng.toFixed(6)}`,
      estado: "FUERA",
      sub: "No se encontraron polígonos válidos para calcular distancia.",
      attrs: `<div class="muted">Sin datos válidos.</div>`
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
  }
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
