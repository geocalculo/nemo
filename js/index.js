/************************************************************
 * GeoConserva - index.js
 * - Consulta punto/polígono sobre KML único:
 *     capas/snaspe_resto_kml.kml
 * - El polígono NO se muestra en mapa (consulta interna).
 ************************************************************/

const KML_URL = "capas/snaspe_resto_kml.kml";

// Vista inicial
const HOME_VIEW = { center: [-33.5, -71.0], zoom: 5 };

let map;
let userMarker = null;
let clickMarker = null;

// Cache KML
let kmlLoaded = false;
let featuresIndex = []; // { feature, bbox }

/* ---------- UI helpers ---------- */

function toast(msg, ms = 2200){
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  window.clearTimeout(toast._t);
  toast._t = window.setTimeout(() => el.classList.remove("show"), ms);
}

function escapeHtml(s){
  return String(s)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function setPanel({ clickText="—", estado="—", categoria="SNASPE", attrsHtml=null, sub="—" }){
  document.getElementById("sbRegion").textContent = "SNASPE (KML)";
  document.getElementById("sbClick").textContent = clickText;
  document.getElementById("sbEstado").textContent = estado;
  document.getElementById("sbCategoria").textContent = categoria;
  document.getElementById("sbSub").textContent = sub;

  if (attrsHtml !== null){
    document.getElementById("sbAttrs").innerHTML = attrsHtml;
  }
}

function attrsToHtml(props){
  const keys = Object.keys(props || {});
  if (!keys.length) return `<div class="muted">Sin atributos en properties.</div>`;

  // KML suele usar "name", y ExtendedData a veces queda como claves varias
  const preferred = ["name","Name","nombre","NOMBRE","tipo","TIPO","categoria","CATEGORIA","admin","ADMIN","decreto","DECRETO","region","REGION","comuna","COMUNA"];
  const ordered = [];

  for (const p of preferred) if (p in props) ordered.push(p);
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

/* ---------- Geometry helpers ---------- */

function bboxContainsPoint(bb, lng, lat){
  return lng >= bb[0] && lng <= bb[2] && lat >= bb[1] && lat <= bb[3];
}

/* ---------- Map ---------- */

function crearMapa(){
  map = L.map("map", { zoomControl:true, preferCanvas:true })
    .setView(HOME_VIEW.center, HOME_VIEW.zoom);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);

  map.on("click", onMapClick);
}

/* ---------- KML load ---------- */

async function loadKMLOnce(){
  if (kmlLoaded) return;

  setPanel({
    estado: "Cargando…",
    sub: `Cargando polígonos desde ${KML_URL}`,
    attrsHtml: `<div class="muted">Cargando KML…</div>`
  });

  const res = await fetch(KML_URL, { cache:"no-store" });
  if (!res.ok) throw new Error(`No se pudo cargar ${KML_URL} (HTTP ${res.status})`);

  const kmlText = await res.text();
  const parser = new DOMParser();
  const kmlDom = parser.parseFromString(kmlText, "text/xml");

  const toGeo = window.toGeoJSON; // UMD expone window.toGeoJSON
  if (!toGeo || typeof toGeo.kml !== "function"){
    throw new Error("toGeoJSON.kml no disponible (revisa togeojson.umd.js en index.html)");
  }

  const gj = toGeo.kml(kmlDom);
  const feats = (gj && gj.features) ? gj.features : [];

  featuresIndex = [];
  for (const f of feats){
    const t = f?.geometry?.type;
    if (t === "Polygon" || t === "MultiPolygon"){
      const bb = turf.bbox(f); // [minLon,minLat,maxLon,maxLat]
      featuresIndex.push({ feature: f, bbox: bb });
    }
  }

  kmlLoaded = true;
  toast(`✅ KML cargado: ${featuresIndex.length} polígonos`, 2000);

  setPanel({
    estado: "Listo",
    sub: "Haz clic en el mapa para consultar pertenencia (punto/polígono).",
    attrsHtml: `<div class="muted">KML cargado. Aún no hay selección.</div>`
  });
}

/* ---------- Click logic ---------- */

async function onMapClick(e){
  const lat = e.latlng.lat;
  const lng = e.latlng.lng;

  // Marker del clic (solo punto)
  if (clickMarker) map.removeLayer(clickMarker);
  clickMarker = L.circleMarker([lat,lng], { radius:7, weight:2, opacity:1, fillOpacity:0.2 }).addTo(map);

  setPanel({
    clickText: `${lat.toFixed(6)}, ${lng.toFixed(6)}`,
    estado: "Consultando…",
    sub: "Consulta punto/polígono en KML (capa invisible).",
    attrsHtml: `<div class="muted">Buscando polígono que contenga el punto…</div>`
  });

  try{
    if(!kmlLoaded) await loadKMLOnce();
  }catch(err){
    console.error(err);
    toast("⚠️ Error cargando KML", 2400);
    setPanel({
      clickText: `${lat.toFixed(6)}, ${lng.toFixed(6)}`,
      estado: "Error de datos",
      sub: "No se pudo cargar/parsear el KML. Revisa consola.",
      attrsHtml: `<div class="muted">Error cargando KML. Ver consola.</div>`
    });
    return;
  }

  // Prefiltro por BBOX
  const candidates = [];
  for (const it of featuresIndex){
    if (bboxContainsPoint(it.bbox, lng, lat)) candidates.push(it.feature);
  }

  // Point in polygon
  const pt = turf.point([lng, lat]);
  let hit = null;

  for (const f of candidates){
    try{
      if (turf.booleanPointInPolygon(pt, f)){
        hit = f;
        break;
      }
    }catch(_){
      // ignora geometrías puntualmente inválidas
    }
  }

  if (hit){
    const props = hit.properties || {};
    const nombre = props.name || props.Name || props.nombre || props.NOMBRE || "Área (sin nombre)";

    toast("✅ DENTRO (SNASPE)", 1600);

    setPanel({
      clickText: `${lat.toFixed(6)}, ${lng.toFixed(6)}`,
      estado: "DENTRO",
      categoria: "SNASPE",
      sub: "Polígono encontrado (no se dibuja en el mapa).",
      attrsHtml: `
        <div class="attr">
          <div class="ak">Nombre</div>
          <div class="av">${escapeHtml(nombre)}</div>
        </div>
        ${attrsToHtml(props)}
      `
    });
  } else {
    toast("❌ FUERA (SNASPE)", 1800);

    setPanel({
      clickText: `${lat.toFixed(6)}, ${lng.toFixed(6)}`,
      estado: "FUERA",
      categoria: "SNASPE",
      sub: "No hay polígonos del KML que contengan el punto.",
      attrsHtml: `<div class="muted">Sin coincidencias (punto fuera).</div>`
    });
  }
}

/* ---------- Buttons ---------- */

function clearSelection(){
  if (clickMarker){ map.removeLayer(clickMarker); clickMarker=null; }
  setPanel({
    clickText:"—",
    estado: kmlLoaded ? "Listo" : "—",
    categoria:"SNASPE",
    sub: "Haz clic en el mapa para consultar
