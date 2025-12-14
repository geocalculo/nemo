/************************************************************
 * GeoConserva
 * - Select regiones: SOLO navegación (mover/zoom)
 * - Consulta SIEMPRE contra KML único:
 *     capas/snaspe_resto_kml.kml
 * - Polígono NO se dibuja (consulta interna)
 ************************************************************/

const REGIONES_URL = "data/regiones.json";
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

function setPanel({ nav="—", clickText="—", estado="—", categoria="SNASPE", attrsHtml=null, sub="—" }){
  document.getElementById("sbNav").textContent = nav;
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

/* ---------- Regiones (solo navegación) ---------- */

async function cargarRegiones(){
  const sel = document.getElementById("selRegion");
  sel.innerHTML = `<option value="">Selecciona región…</option>`;

  let data;
  try{
    const res = await fetch(REGIONES_URL, { cache:"no-store" });
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  }catch(err){
    console.error(err);
    sel.innerHTML = `<option value="">(No se pudo cargar regiones.json)</option>`;
    toast("⚠️ No pude cargar data/regiones.json", 2800);
    return [];
  }

  const regiones = Array.isArray(data) ? data : (data.regiones || []);
  regiones.sort((a,b) => String(a.codigo_ine||a.id||"").localeCompare(String(b.codigo_ine||b.id||"")));

  for(const r of regiones){
    const nombre = r.nombre ?? `Región ${r.codigo_ine ?? ""}`;
    const opt = document.createElement("option");
    opt.value = String(r.codigo_ine ?? r.id ?? nombre);
    opt.textContent = nombre;
    opt.dataset.center = JSON.stringify(r.centro || r.center || null);
    opt.dataset.zoom = String(r.zoom ?? 7);
    sel.appendChild(opt);
  }

  sel.addEventListener("change", () => {
    const opt = sel.options[sel.selectedIndex];
    if(!opt || !opt.dataset.center) return;

    let center = null;
    try{ center = JSON.parse(opt.dataset.center); }catch(_){}
    const zoom = parseInt(opt.dataset.zoom || "7", 10);

    if(Array.isArray(center) && center.length === 2){
      map.setView(center, zoom, { animate:true });
      setPanel({ nav: opt.textContent }); // solo navegación
      toast(`🧭 ${opt.textContent}`, 1400);
    }
  });

  return regiones;
}

/* ---------- KML load (consulta) ---------- */

async function loadKMLOnce(){
  if (kmlLoaded) return;

  setPanel({
    estado: "Cargando…",
    sub: `Cargando SNASPE desde ${KML_URL}`,
    attrsHtml: `<div class="muted">Cargando KML…</div>`
  });

  const res = await fetch(KML_URL, { cache:"no-store" });
  if (!res.ok) throw new Error(`No se pudo cargar ${KML_URL} (HTTP ${res.status})`);

  const kmlText = await res.text();
  const parser = new DOMParser();
  const kmlDom = parser.parseFromString(kmlText, "text/xml");

  const toGeo = window.toGeoJSON;
  if (!toGeo || typeof toGeo.kml !== "function"){
    throw new Error("toGeoJSON.kml no disponible (revisa togeojson en index.html)");
  }

  const gj = toGeo.kml(kmlDom);
  const feats = (gj && gj.features) ? gj.features : [];

  featuresIndex = [];
  for (const f of feats){
    const t = f?.geometry?.type;
    if (t === "Polygon" || t === "MultiPolygon"){
      const bb = turf.bbox(f);
      featuresIndex.push({ feature: f, bbox: bb });
    }
  }

  kmlLoaded = true;
  toast(`✅ SNASPE cargado: ${featuresIndex.length} polígonos`, 2000);

  setPanel({
    estado: "Listo",
    sub: "Haz clic en el mapa para consultar pertenencia (punto/polígono).",
    attrsHtml: `<div class="muted">KML cargado. Aún no hay selección.</div>`
  });
}

/* ---------- Click logic (consulta) ---------- */

async function onMapClick(e){
  const lat = e.latlng.lat;
  const lng = e.latlng.lng;

  // marker del clic (solo punto)
  if (clickMarker) map.removeLayer(clickMarker);
  clickMarker = L.circleMarker([lat,lng], { radius:7, weight:2, opacity:1, fillOpacity:0.2 }).addTo(map);

  // navegación actual (solo informativa)
  const sel = document.getElementById("selRegion");
  const navName = (sel && sel.value) ? sel.options[sel.selectedIndex].textContent : "—";

  setPanel({
    nav: navName,
    clickText: `${lat.toFixed(6)}, ${lng.toFixed(6)}`,
    estado: "Consultando…",
    sub: "Consulta punto/polígono sobre SNASPE (KML).",
    attrsHtml: `<div class="muted">Buscando polígono que contenga el punto…</div>`
  });

  try{
    if(!kmlLoaded) await loadKMLOnce();
  }catch(err){
    console.error(err);
    toast("⚠️ Error cargando KML", 2400);
    setPanel({
      nav: navName,
      clickText: `${lat.toFixed(6)}, ${lng.toFixed(6)}`,
      estado: "Error de datos",
      sub: "No se pudo cargar/parsear el KML. Revisa consola.",
      attrsHtml: `<div class="muted">Error cargando KML. Ver consola.</div>`
    });
    return;
  }

  // Prefiltro bbox
  const candidates = [];
  for (const it of featuresIndex){
    if (bboxContainsPoint(it.bbox, lng, lat)) candidates.push(it.feature);
  }

  const pt = turf.point([lng, lat]);
  let hit = null;

  for (const f of candidates){
    try{
      if (turf.booleanPointInPolygon(pt, f)){
        hit = f;
        break;
      }
    }catch(_){}
  }

  if (hit){
    const props = hit.properties || {};
    const nombre = props.name || props.Name || props.nombre || props.NOMBRE || "Área (sin nombre)";

    toast("✅ DENTRO (SNASPE)", 1600);

    setPanel({
      nav: navName,
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
      nav: navName,
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

  const sel = document.getElementById("selRegion");
  const navName = (sel && sel.value) ? sel.options[sel.selectedIndex].textContent : "—";

  setPanel({
    nav: navName,
    clickText:"—",
    estado: kmlLoaded ? "Listo" : "—",
    categoria:"SNASPE",
    sub: "Haz clic en el mapa para consultar pertenencia (punto/polígono).",
    attrsHtml: `<div class="muted">Aún no hay selección.</div>`
  });
}

function bindUI(){
  document.getElementById("btnHome").addEventListener("click", () => {
    map.setView(HOME_VIEW.center, HOME_VIEW.zoom, { animate:true });
    toast("🏠 Vista inicial", 1200);
  });

  document.getElementById("btnGPS").addEventListener("click", () => {
    if(!navigator.geolocation){
      toast("⚠️ Tu navegador no soporta geolocalización", 2400);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;

        if(userMarker) map.removeLayer(userMarker);
        userMarker = L.circleMarker([lat, lng], { radius:7, weight:2, opacity:1, fillOpacity:0.35 }).addTo(map);

        map.setView([lat, lng], Math.max(map.getZoom(), 14), { animate:true });
        toast("🎯 Ubicación detectada", 1400);
      },
      () => toast("⚠️ No pude obtener tu ubicación (permiso/precisión)", 2600),
      { enableHighAccuracy:true, timeout:10000, maximumAge:0 }
    );
  });

  document.getElementById("btnClear").addEventListener("click", () => {
    clearSelection();
    toast("🧹 Selección limpiada", 1200);
  });

  document.getElementById("btnPreload").addEventListener("click", async () => {
    try{
      await loadKMLOnce();
    }catch(err){
      console.error(err);
      toast("⚠️ Error precargando KML", 2200);
    }
  });
}

/* ---------- Init ---------- */

(async function init(){
  crearMapa();
  bindUI();
  await cargarRegiones();    // ✅ SOLO navegación
  clearSelection();
  toast("Listo ✅ Selecciona una región para navegar y haz clic para consultar SNASPE.", 2600);
})();
