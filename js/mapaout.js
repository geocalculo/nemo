/************************************************************
 * GeoNEMO - mapaout.js
 * - Lee el resultado desde localStorage
 * - Muestra mapa cuadrado y dibuja:
 *    1) Polígono vinculado (verde brillante semitransparente)
 *    2) Punto consultado (icono llamativo)
 * - Tabla por capa: permite cambiar capa activa
 ************************************************************/
const OUT_STORAGE_KEY = "geonemo_out_v2";

function esc(s){
  return String(s ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function getOut(){
  try{
    const raw = localStorage.getItem(OUT_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch(e){
    return null;
  }
}

function setText(id, v){
  const el = document.getElementById(id);
  if (el) el.textContent = v ?? "—";
}

function fmtLatLon(lat, lon){
  if (!isFinite(lat) || !isFinite(lon)) return "—";
  return `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
}

function fmtBbox(bb){
  if (!bb) return "—";
  return `${bb.west.toFixed(3)}, ${bb.south.toFixed(3)} — ${bb.east.toFixed(3)}, ${bb.north.toFixed(3)}`;
}

function badge(linkType){
  if (linkType === "inside") return `<span class="badge ok">inside</span>`;
  if (linkType === "nearest_perimeter") return `<span class="badge warn">proximidad</span>`;
  if (linkType === "none") return `<span class="badge err">sin match</span>`;
  return `<span class="badge err">${esc(linkType)}</span>`;
}

function renderAttrs(props){
  const el = document.getElementById("attrs");
  if (!el) return;
  const keys = Object.keys(props || {});
  if (!keys.length){
    el.innerHTML = '<div class="muted">Sin atributos.</div>';
    return;
  }

  const preferred = ["NOMBRE","Nombre","nombre","NAME","Name","name","CATEGORIA","categoria","TIPO","tipo","COD","codigo","ID","id"];
  const ordered = [];
  for (const k of preferred) if (k in props) ordered.push(k);
  for (const k of keys) if (!ordered.includes(k)) ordered.push(k);

  el.innerHTML = ordered.map(k => {
    const v = props[k];
    const vv = (v === null || v === undefined || v === "") ? "—" : String(v);
    return `<div class="attr"><div class="ak">${esc(k)}</div><div class="av">${esc(vv)}</div></div>`;
  }).join("");
}

function downloadJson(obj){
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "geonemo_resultado.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

/* ===========================
   MapaOut: Leaflet
=========================== */
let outMap = null;
let polyLayer = null;
let pointLayer = null;

function initOutMap(){
  outMap = L.map("outMap", { zoomControl: true, preferCanvas:true });

  // Mantener el mismo basemap "brutal"
  const topoBase = L.tileLayer(
    "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
    { maxZoom: 17, subdomains:"abc", opacity:1.0,
      attribution:"Map data: &copy; OpenStreetMap contributors, SRTM | OpenTopoMap"
    }
  );

  const satOverlay = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 19, opacity:0.25, attribution:"Tiles &copy; Esri" }
  );

  topoBase.addTo(outMap);
  satOverlay.addTo(outMap);

  // Vista inicial (se ajusta al renderizar)
  outMap.setView([-33.5, -71.0], 5);
  setTimeout(() => outMap.invalidateSize(true), 250);
}

function makePointIcon(){
  return L.divIcon({
    className: "",
    html: '<div class="pin" title="Punto consultado"></div>',
    iconSize: [18,18],
    iconAnchor: [9,9]
  });
}

function clearMapDraw(){
  if (polyLayer){ try{ outMap.removeLayer(polyLayer); } catch(_){} polyLayer=null; }
  if (pointLayer){ try{ outMap.removeLayer(pointLayer); } catch(_){} pointLayer=null; }
}

function drawSelection(feature, click){
  if (!outMap) return;
  clearMapDraw();

  // Punto consultado
  if (click && isFinite(click.lat) && isFinite(click.lon)){
    pointLayer = L.marker([click.lat, click.lon], { icon: makePointIcon() }).addTo(outMap);
  }

  // Polígono vinculado (verde brillante semitransparente)
  if (feature && feature.geometry){
    polyLayer = L.geoJSON(feature, {
      style: {
        color: "#22c55e",
        weight: 3,
        opacity: 1,
        fillColor: "#22c55e",
        fillOpacity: 0.30
      }
    }).addTo(outMap);

    // Ajustar vista a polígono + punto
    const bounds = polyLayer.getBounds();
    if (pointLayer) bounds.extend(pointLayer.getLatLng());
    outMap.fitBounds(bounds.pad(0.20), { animate: true });
  } else if (pointLayer){
    outMap.setView(pointLayer.getLatLng(), 12, { animate:true });
  }
}

/* ===========================
   Tabla de capas y selección
=========================== */
function renderLinksTable(links){
  const container = document.getElementById("links");
  if (!container) return;

  if (!Array.isArray(links) || !links.length){
    container.innerHTML = '<div class="muted" style="padding:12px;">No hay capas vinculadas.</div>';
    return;
  }

  const rows = links.map((l, i) => {
    const dist = (l.distance_km == null) ? "—" : `${l.distance_km.toFixed(3)} km`;
    return `<tr data-idx="${i}">
      <td>${esc(l.layer_name || l.layer_id || "—")}</td>
      <td>${badge(l.link_type)}</td>
      <td class="mono">${dist}</td>
      <td>${l.feature ? "✔" : "—"}</td>
    </tr>`;
  }).join("");

  container.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Capa</th>
          <th>Vinculación</th>
          <th>Dist. perímetro</th>
          <th>Polígono</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function setActiveRow(idx){
  const tbody = document.querySelector("#links tbody");
  if (!tbody) return;
  for (const tr of tbody.querySelectorAll("tr")){
    tr.classList.toggle("active", tr.getAttribute("data-idx") === String(idx));
  }
}

(function init(){
  const out = getOut();

  const btnBack = document.getElementById("btnBack");
  const btnDownloadJson = document.getElementById("btnDownloadJson");
  const btnClearOut = document.getElementById("btnClearOut");

  if (btnBack) btnBack.addEventListener("click", () => history.back());
  if (btnDownloadJson) btnDownloadJson.addEventListener("click", () => {
    const obj = getOut();
    if (!obj) return alert("No hay resultado guardado todavía.");
    downloadJson(obj);
  });
  if (btnClearOut) btnClearOut.addEventListener("click", () => {
    localStorage.removeItem(OUT_STORAGE_KEY);
    location.reload();
  });

  initOutMap();

  if (!out){
    setText("outUpdated","—");
    setText("outClick","—");
    setText("outBbox","—");
    setText("st1","—"); setText("st2","—"); setText("st3","—");
    renderLinksTable([]);
    renderAttrs({});
    drawSelection(null, null);
    return;
  }

  setText("outUpdated", out.updated_at || out.created_at || "—");
  setText("outClick", fmtLatLon(out?.click?.lat, out?.click?.lon));
  setText("outBbox", fmtBbox(out?.bbox || null));

  const st = out.stats || {};
  setText("st1", st.areas_bbox != null ? String(st.areas_bbox) : "—");
  setText("st2", st.total_bbox != null ? String(st.total_bbox) : "—");
  setText("st3", st.protected_area_fmt || "—");

  const links = Array.isArray(out.links) ? out.links : [];
  renderLinksTable(links);

  // Selección inicial: primera capa con feature; si no, la primera
  let active = 0;
  const firstWithFeature = links.findIndex(l => !!l.feature);
  if (firstWithFeature >= 0) active = firstWithFeature;

  setActiveRow(active);
  renderAttrs(links[active]?.feature?.properties || {});
  drawSelection(links[active]?.feature || null, out.click || null);

  // Click en tabla => cambia capa activa
  const tbody = document.querySelector("#links tbody");
  if (tbody){
    tbody.addEventListener("click", (ev) => {
      const tr = ev.target.closest("tr");
      if (!tr) return;
      const idx = parseInt(tr.getAttribute("data-idx"), 10);
      if (Number.isNaN(idx)) return;

      setActiveRow(idx);
      renderAttrs(links[idx]?.feature?.properties || {});
      drawSelection(links[idx]?.feature || null, out.click || null);
    });
  }
})();