/************************************************************
 * GeoConserva - index.js (WGS84 grados + Resumen BBOX)
 * - Basemap: OSM normal + fallback HOT
 * - GeoJSON WGS84: capas/SNASPE_Monumento_Natural.geojson
 * - Resumen dinámico al pan/zoom:
 *   1) N° áreas protegidas en bbox
 *   2) Total áreas en bbox
 *   3) Superficie protegida dentro del bbox (ha / km²)
 * - Click opcional: marcador y mensaje rápido
 ************************************************************/

const REGIONES_URL = "data/regiones.json";
const GEOJSON_URL  = "capas/SNASPE_Monumento_Natural.geojson";
const HOME_VIEW = { center: [-33.5, -71.0], zoom: 5 };

let map;
let userMarker = null;
let clickMarker = null;

let dataLoaded = false;
let featuresIndex = []; // [{ feature, bbox:[minLon,minLat,maxLon,maxLat], areaM2? }]

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

function bboxIntersects(b1, b2){
  // [minLon,minLat,maxLon,maxLat]
  return !(b2[0] > b1[2] || b2[2] < b1[0] || b2[1] > b1[3] || b2[3] < b1[1]);
}

function bboxContainsLonLat(bb, lon, lat) {
  return lon >= bb[0] && lon <= bb[2] && lat >= bb[1] && lat <= bb[3];
}

/* ===========================
   Map init (OSM normal + fallback)
=========================== */
function crearMapa() {
  map = L.map("map", { zoomControl: true, preferCanvas: true })
    .setView(HOME_VIEW.center, HOME_VIEW.zoom);

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

  let switched = false;
  osmNormal.on("tileerror", () => {
    if (switched) return;
    switched = true;
    try { map.removeLayer(osmNormal); } catch(_) {}
    osmHOT.addTo(map);
    toast("⚠️ OSM normal falló. Cambié a OSM HOT.", 2600);
  });

  // Actualización dinámica por BBOX
  map.on("moveend", scheduleStatsUpdate);
  map.on("zoomend", scheduleStatsUpdate);

  // Click opcional (no es necesario para el resumen, pero útil)
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
   GeoJSON load (WGS84 grados)
=========================== */
async function loadGeoJSON() {
  if (dataLoaded) return;

  // UI inicial (barra)
  setStatsUI("…", "…", "Cargando…");

  const res = await fetch(GEOJSON_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`No se pudo cargar ${GEOJSON_URL} (HTTP ${res.status})`);

  const gj = await res.json();
  const feats = gj.features || [];

  featuresIndex = [];
  for (const f of feats) {
    const t = f?.geometry?.type;
    if (t === "Polygon" || t === "MultiPolygon") {
      try {
        const bb = turf.bbox(f); // [minLon,minLat,maxLon,maxLat]
        // (opcional) precalcula área total para modo rápido
        let areaM2 = NaN;
        try { areaM2 = turf.area(f); } catch(_) {}
        featuresIndex.push({ feature: f, bbox: bb, areaM2 });
      } catch (_) {}
    }
  }

  if (!featuresIndex.length) {
    throw new Error("GeoJSON sin polígonos válidos (Polygon/MultiPolygon).");
  }

  dataLoaded = true;
  toast(`✅ Cargado: ${featuresIndex.length} polígonos`, 2000);

  // Primer cálculo
  scheduleStatsUpdate();
}

/* ===========================
   Stats BBOX (dinámico)
   - “protegidas” = esta capa (por ahora)
   - “total” = igual (por ahora)
   - superficie = área intersección con bbox
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

async function updateBboxStats(){
  // si aún no cargó, intenta cargar automáticamente (lazy)
  if (!dataLoaded) {
    try { await loadGeoJSON(); } catch (e) {
      console.error(e);
      setStatsUI("—", "—", "—");
      return;
    }
  }

  if (!featuresIndex.length || !map){
    setStatsUI("—", "—", "—");
    return;
  }

  const b = map.getBounds();
  const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  const bboxPoly = turf.bboxPolygon(bbox);

  let totalAreas = 0;
  let protectedAreas = 0;
  let protectedAreaM2 = 0;

  for (const it of featuresIndex){
    if (!bboxIntersects(it.bbox, bbox)) continue;

    let touches = false;
    try { touches = turf.booleanIntersects(it.feature, bboxPoly); } catch(_) {}
    if (!touches) continue;

    totalAreas += 1;
    protectedAreas += 1;

    // Área dentro del bbox: intersección (más correcto)
    // Nota: puede ser pesado en datasets grandes. Si se vuelve lento, cambiamos a “modo rápido”.
    try {
      const inter = turf.intersect(it.feature, bboxPoly);
      if (inter) protectedAreaM2 += turf.area(inter);
      else protectedAreaM2 += (isFinite(it.areaM2) ? it.areaM2 : 0);
    } catch(_) {
      // fallback
      protectedAreaM2 += (isFinite(it.areaM2) ? it.areaM2 : 0);
    }
  }

  setStatsUI(fmtInt(protectedAreas), fmtInt(totalAreas), fmtArea(protectedAreaM2));
}

/* ===========================
   Click (opcional): marcador y “dentro”
   - No afecta el resumen
=========================== */
async function onMapClick(e){
  const lat = e.latlng.lat;
  const lon = e.latlng.lng;

  if (clickMarker) map.removeLayer(clickMarker);
  clickMarker = L.circleMarker([lat, lon], {
    radius: 7, weight: 2, opacity: 1, fillOpacity: 0.25
  }).addTo(map);

  // carga si falta
  try { await loadGeoJSON(); } catch(_) {}

  const pt = turf.point([lon, lat]);

  // cuenta cuántos polígonos contienen el punto (normalmente 0 o 1)
  let hits = 0;
  for (const it of featuresIndex){
    if (!bboxContainsLonLat(it.bbox, lon, lat)) continue;
    let inside = false;
    try { inside = turf.booleanPointInPolygon(pt, it.feature); } catch(_) {}
    if (inside) hits++;
  }

  toast(hits ? `✅ Punto dentro de ${hits} polígono(s)` : "❌ Punto fuera", 1600);
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

  if (btnHome) {
    btnHome.addEventListener("click", () => {
      map.setView(HOME_VIEW.center, HOME_VIEW.zoom, { animate: true });
      toast("🏠 Vista inicial", 1200);
      setTimeout(() => map.invalidateSize(true), 150);
      scheduleStatsUpdate();
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
          const lon = pos.coords.longitude;

          if (userMarker) map.removeLayer(userMarker);
          userMarker = L.circleMarker([lat, lon], {
            radius: 7, weight: 2, opacity: 1, fillOpacity: 0.35
          }).addTo(map);

          map.setView([lat, lon], Math.max(map.getZoom(), 14), { animate: true });
          toast("🎯 Ubicación detectada", 1400);
          setTimeout(() => map.invalidateSize(true), 150);
          scheduleStatsUpdate();
        },
        () => toast("⚠️ No pude obtener tu ubicación", 2600),
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
      );
    });
  }

  if (btnClear) {
    btnClear.addEventListener("click", clearPoint);
  }

  if (btnPreload) {
    btnPreload.addEventListener("click", async () => {
      try {
        await loadGeoJSON();
        toast("⬇️ Datos precargados", 1400);
        scheduleStatsUpdate();
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

  // precarga “silenciosa” (puedes comentarla si no quieres)
  loadGeoJSON().catch(err => console.warn(err));

  toast("Listo ✅ Pan/Zoom para ver resumen SNASPE en BBOX.", 2400);
})();
