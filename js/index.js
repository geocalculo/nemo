/************************************************************
 * GeoConserva - index.js
 *  - Carga data/regiones.json
 *  - Menú desplegable para centrar mapa por región
 *  - Botón Home (vista Chile)
 *  - Botón GPS (ubicación del usuario)
 *  - Deja listo "modo clic permanente" (hook para siguiente etapa)
 ************************************************************/

const REGIONES_URL = "data/regiones.json";

// Vista inicial (Chile)
const HOME_VIEW = {
  center: [-33.5, -71.0],
  zoom: 5
};

let map;
let userMarker = null;

function toast(msg, ms = 2400){
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  window.clearTimeout(toast._t);
  toast._t = window.setTimeout(() => el.classList.remove("show"), ms);
}

function crearMapa(){
  map = L.map("map", {
    zoomControl: true,
    preferCanvas: true
  }).setView(HOME_VIEW.center, HOME_VIEW.zoom);

  // Base OSM
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);

  // Hook: modo clic permanente (aquí después conectas consulta de conservación)
  map.on("click", (e) => {
    const { lat, lng } = e.latlng;
    toast(`📍 Clic: ${lat.toFixed(6)}, ${lng.toFixed(6)} (pronto: consulta conservación)`, 2200);
    // TODO (siguiente etapa):
    // - buscar área protegida que contiene el punto
    // - si no hay, buscar la más cercana
    // - habilitar descargas KML/GeoJSON, etc.
  });
}

async function cargarRegiones(){
  const sel = document.getElementById("selRegion");
  sel.innerHTML = `<option value="">Selecciona región…</option>`;

  let data;
  try{
    const res = await fetch(REGIONES_URL, { cache: "no-store" });
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  }catch(err){
    console.error(err);
    sel.innerHTML = `<option value="">Error cargando regiones</option>`;
    toast("⚠️ No pude cargar data/regiones.json", 3000);
    return [];
  }

  // Acepta 2 formatos:
  // A) { "regiones": [ ... ] }
  // B) [ ... ]
  const regiones = Array.isArray(data) ? data : (data.regiones || []);

  // Normaliza y ordena por código
  regiones.sort((a,b) => String(a.codigo_ine||a.id||"").localeCompare(String(b.codigo_ine||b.id||"")));

  // Render opciones
  for(const r of regiones){
    const id = r.id ?? r.codigo_ine ?? r.codigo ?? r.nombre;
    const nombre = r.nombre ?? `Región ${id}`;
    const opt = document.createElement("option");
    opt.value = String(id);
    opt.textContent = nombre;
    opt.dataset.center = JSON.stringify(r.centro || r.center || null);
    opt.dataset.zoom = String(r.zoom ?? 7);
    sel.appendChild(opt);
  }

  return regiones;
}

function bindUI(){
  const sel = document.getElementById("selRegion");
  const btnHome = document.getElementById("btnHome");
  const btnGPS  = document.getElementById("btnGPS");

  sel.addEventListener("change", () => {
    const opt = sel.options[sel.selectedIndex];
    if(!opt || !opt.dataset.center) return;

    let center = null;
    try{ center = JSON.parse(opt.dataset.center); }catch(_){}
    const zoom = parseInt(opt.dataset.zoom || "7", 10);

    if(Array.isArray(center) && center.length === 2){
      map.setView(center, zoom, { animate: true });
      toast(`🧭 ${opt.textContent}`, 1500);
    }else{
      toast("⚠️ Esta región no tiene 'centro' definido en regiones.json", 2500);
    }
  });

  btnHome.addEventListener("click", () => {
    map.setView(HOME_VIEW.center, HOME_VIEW.zoom, { animate: true });
    toast("🏠 Vista inicial", 1400);
  });

  btnGPS.addEventListener("click", () => {
    if(!navigator.geolocation){
      toast("⚠️ Tu navegador no soporta geolocalización", 2500);
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;

        if(userMarker) map.removeLayer(userMarker);

        userMarker = L.circleMarker([lat, lng], {
          radius: 7,
          weight: 2,
          opacity: 1,
          fillOpacity: 0.4
        }).addTo(map);

        map.setView([lat, lng], Math.max(map.getZoom(), 14), { animate: true });
        toast("🎯 Ubicación detectada", 1600);
      },
      (err) => {
        console.warn(err);
        toast("⚠️ No pude obtener tu ubicación (permiso/precisión)", 2800);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  });
}

(async function init(){
  crearMapa();
  await cargarRegiones();
  bindUI();
  toast("Listo ✅ Selecciona una región y haz clic en el mapa.", 2600);
})();
