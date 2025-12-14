/************************************************************
 * GeoConserva - index.js
 * - Regiones (data/regiones.json)
 * - Panel izquierdo con resultado
 * - Click permanente: punto-en-poligono
 * - Carga por región: /capas_XX/conservacion.json
 *   que lista categorías y archivos GeoJSON
 ************************************************************/

const REGIONES_URL = "data/regiones.json";

const HOME_VIEW = {
  center: [-33.5, -71.0],
  zoom: 5
};

let map;
let userMarker = null;
let clickMarker = null;
let hitLayer = null;

// Cache por región: { "03": { categorias:[...], featuresIndex:[...] } }
const cacheRegion = new Map();

function toast(msg, ms = 2200){
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  window.clearTimeout(toast._t);
  toast._t = window.setTimeout(() => el.classList.remove("show"), ms);
}

function setPanelBase({ regionName="—", clickText="—", estado="—", categoria="—", attrsHtml=null, sub="—" }){
  document.getElementById("sbRegion").textContent = regionName;
  document.getElementById("sbClick").textContent = clickText;
  document.getElementById("sbEstado").textContent = estado;
  document.getElementById("sbCategoria").textContent = categoria;
  document.getElementById("sbSub").textContent = sub;

  const sbAttrs = document.getElementById("sbAttrs");
  if (attrsHtml !== null) sbAttrs.innerHTML = attrsHtml;
}

function attrsToHtml(props){
  const keys = Object.keys(props || {});
  if (!keys.length) return `<div class="muted">Sin atributos en properties.</div>`;

  // Orden simple: primero campos típicos si existen
  const preferred = ["NOMBRE","Nombre","name","tipo","TIPO","categoria","CATEGORIA","admin","ADMIN","decreto","DECRETO","region","comuna","codigo"];
  const ordered = [];

  for (const p of preferred){
    if (p in props) ordered.push(p);
  }
  for (const k of keys){
    if (!ordered.includes(k)) ordered.push(k);
  }

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

function escapeHtml(s){
  return String(s)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function crearMapa(){
  map = L.map("map", { zoomControl:true, preferCanvas:true }).setView(HOME_VIEW.center, HOME_VIEW.zoom);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);

  map.on("click", onMapClick);
}

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
    sel.innerHTML = `<option value="">Error cargando regiones</option>`;
    toast("⚠️ No pude cargar data/regiones.json", 3000);
    return [];
  }

  const regiones = Array.isArray(data) ? data : (data.regiones || []);
  regiones.sort((a,b) => String(a.codigo_ine||a.id||"").localeCompare(String(b.codigo_ine||b.id||"")));

  for(const r of regiones){
    const id = String(r.codigo_ine ?? r.id ?? r.codigo ?? "");
    const nombre = r.nombre ?? `Región ${id}`;
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = nombre;
    opt.dataset.regionName = nombre;
    opt.dataset.folder = r.carpeta || `capas_${id}`;
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
  const btnClear= document.getElementById("btnClear");

  sel.addEventListener("change", async () => {
    const opt = sel.options[sel.selectedIndex];
    if(!opt || !opt.value){
      setPanelBase({ regionName:"—", sub:"Selecciona una región y haz clic en el mapa." });
      return;
    }

    const regionName = opt.dataset.regionName || opt.textContent;
    const folder = opt.dataset.folder;
    let center = null;
    try{ center = JSON.parse(opt.dataset.center); }catch(_){}
    const zoom = parseInt(opt.dataset.zoom || "7", 10);

    if(Array.isArray(center) && center.length === 2){
      map.setView(center, zoom, { animate:true });
    }

    // Precarga (opcional): carga config de conservación para esa región
    try{
      await ensureRegionLoaded(opt.value, folder);
      toast(`🧭 ${regionName} (capas cargadas)`, 1400);
      setPanelBase({
        regionName,
        sub: "Haz clic en el mapa para consultar pertenencia (punto/polígono).",
        estado: "Listo"
      });
    }catch(err){
      console.error(err);
      toast("⚠️ No pude cargar capas de conservación de esta región", 2800);
      setPanelBase({
        regionName,
        estado: "Sin capas",
        sub: "No se pudo cargar conservacion.json o GeoJSON de la región."
      });
    }
  });

  btnHome.addEventListener("click", () => {
    map.setView(HOME_VIEW.center, HOME_VIEW.zoom, { animate:true });
    toast("🏠 Vista inicial", 1200);
  });

  btnGPS.addEventListener("click", () => {
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

  btnClear.addEventListener("click", () => {
    clearSelection();
    toast("🧹 Selección limpiada", 1200);
  });
}

function clearSelection(){
  if(clickMarker){ map.removeLayer(clickMarker); clickMarker=null; }
  if(hitLayer){ map.removeLayer(hitLayer); hitLayer=null; }

  const sel = document.getElementById("selRegion");
  const opt = sel.options[sel.selectedIndex];
  const regionName = (opt && opt.value) ? (opt.dataset.regionName || opt.textContent) : "—";

  setPanelBase({
    regionName,
    clickText: "—",
    estado: "—",
    categoria: "—",
    attrsHtml: `<div class="muted">Aún no hay selección.</div>`,
    sub: "Haz clic en el mapa para consultar pertenencia (punto/polígono)."
  });
}

async function ensureRegionLoaded(regionId, folder){
  if(cacheRegion.has(regionId)) return cacheRegion.get(regionId);

  // 1) Lee el manifiesto de categorías
  const manifestUrl = `${folder}/conservacion.json`;
  const res = await fetch(manifestUrl, { cache:"no-store" });
  if(!res.ok) throw new Error(`No se pudo cargar ${manifestUrl} (HTTP ${res.status})`);
  const manifest = await res.json();

  const categorias = manifest.categorias || [];
  if(!categorias.length) throw new Error("conservacion.json no trae categorias[]");

  // 2) Carga todos los geojson y arma un “índice” plano de features
  const featuresIndex = []; // cada item: { categoriaId, categoriaNombre, feature, bbox }
  for(const cat of categorias){
    const url = `${folder}/${cat.archivo}`;
    const gjRes = await fetch(url, { cache:"no-store" });
    if(!gjRes.ok) throw new Error(`No se pudo cargar ${url} (HTTP ${gjRes.status})`);
    const gj = await gjRes.json();
    const feats = (gj && gj.features) ? gj.features : [];

    for(const f of feats){
      const bb = turf.bbox(f); // [minX,minY,maxX,maxY] lon/lat
      featuresIndex.push({
        categoriaId: cat.id,
        categoriaNombre: cat.nombre,
        feature: f,
        bbox: bb
      });
    }
  }

  const payload = { folder, categorias, featuresIndex };
  cacheRegion.set(regionId, payload);
  return payload;
}

function bboxContainsPoint(bb, lng, lat){
  // bb = [minX,minY,maxX,maxY]
  return lng >= bb[0] && lng <= bb[2] && lat >= bb[1] && lat <= bb[3];
}

async function onMapClick(e){
  const lat = e.latlng.lat;
  const lng = e.latlng.lng;

  // marker de clic
  if(clickMarker) map.removeLayer(clickMarker);
  clickMarker = L.circleMarker([lat,lng], { radius:7, weight:2, opacity:1, fillOpacity:0.2 }).addTo(map);

  // región activa
  const sel = document.getElementById("selRegion");
  const opt = sel.options[sel.selectedIndex];

  if(!opt || !opt.value){
    toast("Selecciona una región primero", 1800);
    setPanelBase({
      clickText: `${lat.toFixed(6)}, ${lng.toFixed(6)}`,
      estado: "Sin región",
      sub: "Debes seleccionar una región en el menú."
    });
    return;
  }

  const regionId = opt.value;
  const regionName = opt.dataset.regionName || opt.textContent;
  const folder = opt.dataset.folder;

  setPanelBase({
    regionName,
    clickText: `${lat.toFixed(6)}, ${lng.toFixed(6)}`,
    estado: "Consultando…",
    categoria: "—",
    attrsHtml: `<div class="muted">Buscando polígonos que contengan el punto…</div>`,
    sub: "Consulta de pertenencia (punto/polígono)."
  });

  let data;
  try{
    data = await ensureRegionLoaded(regionId, folder);
  }catch(err){
    console.error(err);
    toast("⚠️ No pude cargar capas de conservación", 2600);
    setPanelBase({
      regionName,
      estado: "Error de datos",
      categoria: "—",
      attrsHtml: `<div class="muted">No se pudo cargar conservacion.json o algún GeoJSON.</div>`,
      sub: "Revisa rutas /capas_XX/*"
    });
    return;
  }

  // 1) Prefiltro por bbox para acelerar
  const candidates = [];
  for(const it of data.featuresIndex){
    if(bboxContainsPoint(it.bbox, lng, lat)) candidates.push(it);
  }

  // 2) Point-in-polygon real
  const pt = turf.point([lng, lat]);
  let hit = null;

  for(const it of candidates){
    try{
      if(turf.booleanPointInPolygon(pt, it.feature)){
        hit = it;
        break;
      }
    }catch(_){
      // ignora geometrías inválidas puntuales
    }
  }

  // Limpia polígono dibujado previo
  if(hitLayer){ map.removeLayer(hitLayer); hitLayer=null; }

  if(hit){
    // Dibuja polígono tocado
    hitLayer = L.geoJSON(hit.feature, {
      style: { weight: 2, opacity: 1, fillOpacity: 0.18 }
    }).addTo(map);

    const props = hit.feature.properties || {};
    const nombre = props.nombre || props.NOMBRE || props.Name || props.NAME || "Área sin nombre";

    toast("✅ Punto dentro de un área protegida / conservación", 1800);

    setPanelBase({
      regionName,
      clickText: `${lat.toFixed(6)}, ${lng.toFixed(6)}`,
      estado: "DENTRO",
      categoria: hit.categoriaNombre,
      attrsHtml: `
        <div class="attr">
          <div class="ak">Nombre</div>
          <div class="av">${escapeHtml(nombre)}</div>
        </div>
        ${attrsToHtml(props)}
      `,
      sub: "Se encontró un polígono que contiene el punto."
    });
  }else{
    toast("❌ Punto fuera de polígonos de conservación (en esta región)", 2000);

    setPanelBase({
      regionName,
      clickText: `${lat.toFixed(6)}, ${lng.toFixed(6)}`,
      estado: "FUERA",
      categoria: "—",
      attrsHtml: `<div class="muted">No hay polígonos que contengan el punto (en las capas cargadas).</div>`,
      sub: "Siguiente etapa: proximidad (área más cercana)."
    });
  }
}

(async function init(){
  crearMapa();
  await cargarRegiones();
  bindUI();
  clearSelection();
  toast("Listo ✅ Selecciona una región y haz clic en el mapa.", 2400);
})();
