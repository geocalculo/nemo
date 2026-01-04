(() => {
  "use strict";

  const STORAGE_KEY = "geonemo_out_v2";

  const el = {
    map: document.getElementById("map"),
    toast: document.getElementById("toast"),

    btnBack: document.getElementById("btnBack"),
    btnFit: document.getElementById("btnFit"),

    btnDownloads: document.getElementById("btnDownloads"),
    downloadsMenu: document.getElementById("downloadsMenu"),
    btnDownloadJSON: document.getElementById("btnDownloadJSON"),
    btnDownloadSelectedGeoJSON: document.getElementById("btnDownloadSelectedGeoJSON"),
    btnCopyLink: document.getElementById("btnCopyLink"),

    kpiStatus: document.getElementById("kpiStatus"),
    kpiDist: document.getElementById("kpiDist"),
    kpiLayer: document.getElementById("kpiLayer"),
    btnEvidence: document.getElementById("btnEvidence"),
    btnTech: document.getElementById("btnTech"),
    techBox: document.getElementById("techBox"),
    techUpdated: document.getElementById("techUpdated"),
    techClick: document.getElementById("techClick"),
    techBbox: document.getElementById("techBbox"),

    layersCount: document.getElementById("layersCount"),
    layersList: document.getElementById("layersList"),

    attrsBox: document.getElementById("attrsBox"),
  };

  let payload = null;
  let map = null;
  let pointMarker = null;
  let polyLayer = null;
  let selectedLayerId = null;

  function showToast(msg) {
    if (!el.toast) return;
    el.toast.textContent = msg;
    el.toast.classList.add("show");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => el.toast.classList.remove("show"), 2200);
  }

  function safeText(v) {
    if (v === null || v === undefined) return "";
    return String(v);
  }

  function fmtDist(m) {
    if (m === null || m === undefined || Number.isNaN(Number(m))) return "—";
    const mm = Math.abs(Number(m));
    if (mm < 1000) return `${Math.round(mm)} m`;
    return `${(mm / 1000).toFixed(2)} km`;
  }

  function normalizeClick(click) {
    if (!click) return null;
    if (Array.isArray(click) && click.length >= 2) return { lat: +click[0], lng: +click[1] };
    if (typeof click === "object" && click.lat !== undefined && click.lng !== undefined) return { lat: +click.lat, lng: +click.lng };
    if (typeof click === "object" && click.y !== undefined && click.x !== undefined) return { lat: +click.y, lng: +click.x };
    return null;
  }

  function statusToBadge(status) {
    const s = String(status || "").toLowerCase();
    if (["in", "inside", "within", "onedge", "on_edge", "edge"].includes(s)) return { label: "DENTRO", cls: "badge--in" };
    if (["prox", "proximity", "buffer", "zam"].includes(s)) return { label: "PROXIMIDAD", cls: "badge--prox" };
    if (["out", "outside", "fuera"].includes(s)) return { label: "FUERA", cls: "badge--out" };
    if (["none", "nomatch", "no match", "sin match", "sin_match"].includes(s)) return { label: "SIN MATCH", cls: "badge--neutral" };
    return { label: safeText(status || "—").toUpperCase() || "—", cls: "badge--neutral" };
  }

  function rowBadgeMini(status) {
    const s = String(status || "").toLowerCase();
    if (["in", "inside", "within", "edge", "onedge"].includes(s)) return { label: "in", cls: "in" };
    if (["prox", "proximity", "buffer", "zam"].includes(s)) return { label: "prox", cls: "prox" };
    if (["out", "outside", "fuera"].includes(s)) return { label: "out", cls: "out" };
    if (["none", "nomatch", "no match", "sin match", "sin_match"].includes(s)) return { label: "sin", cls: "none" };
    return { label: "—", cls: "none" };
  }

  function dom(tag, attrs = {}, children = []) {
    const n = document.createElement(tag);
    Object.entries(attrs).forEach(([k, v]) => {
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.substring(2), v);
      else n.setAttribute(k, v);
    });
    (Array.isArray(children) ? children : [children]).forEach(c => {
      if (c === null || c === undefined) return;
      if (typeof c === "string") n.appendChild(document.createTextNode(c));
      else n.appendChild(c);
    });
    return n;
  }

  function downloadText(filename, text, mime = "application/json") {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function toggleMenu(forceOpen = null) {
    if (!el.downloadsMenu) return;
    const open = forceOpen !== null ? forceOpen : !el.downloadsMenu.classList.contains("open");
    el.downloadsMenu.classList.toggle("open", open);
    el.downloadsMenu.setAttribute("aria-hidden", open ? "false" : "true");
  }

  function hasGeoJSON(gj) {
    return gj && (gj.type === "Feature" || gj.type === "FeatureCollection" || gj.type === "Polygon" || gj.type === "MultiPolygon");
  }

  function toFeatureCollection(gj) {
    if (!gj) return null;
    if (gj.type === "FeatureCollection") return gj;
    if (gj.type === "Feature") return { type: "FeatureCollection", features: [gj] };
    if (gj.type === "Polygon" || gj.type === "MultiPolygon") {
      return { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: gj }] };
    }
    return null;
  }

  function loadPayload() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    try { return JSON.parse(raw); }
    catch { return null; }
  }

  function buildFallbackPayload() {
    return {
      updatedAt: new Date().toISOString(),
      click: { lat: -33.45, lng: -70.66 },
      bbox: [-70.9, -33.7, -70.4, -33.2],
      summary: { status: "OUT", minDistanceM: null, dominantLayer: "—" },
      layers: [{ id: "snaspe_mn", name: "SNASPE - Monumento Natural", status: "sin match", distanceM: null }]
    };
  }

  function initMap(click) {
    map = L.map("map", { zoomControl: true, attributionControl: true });

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: "&copy; OpenStreetMap"
    }).addTo(map);

    polyLayer = L.geoJSON(null, {
      style: () => ({
        color: "#38bdf8",
        weight: 2,
        fillColor: "#38bdf8",
        fillOpacity: 0.14,
      }),
    }).addTo(map);

    const latlng = click ? [click.lat, click.lng] : [-33.45, -70.66];
    pointMarker = L.circleMarker(latlng, {
      radius: 8,
      weight: 2,
      color: "#ffffff",
      fillColor: "#2dd4bf",
      fillOpacity: 0.95,
    }).addTo(map);

    map.setView(latlng, 10);
  }

  function setPolygonOnMap(gj) {
    polyLayer.clearLayers();
    const fc = toFeatureCollection(gj);
    if (!fc) return;
    polyLayer.addData(fc);
  }

  function fitToContext() {
    try {
      if (polyLayer && polyLayer.getLayers().length) {
        const b = polyLayer.getBounds();
        if (b.isValid()) { map.fitBounds(b.pad(0.12)); return; }
      }
      if (payload?.bbox && Array.isArray(payload.bbox) && payload.bbox.length === 4) {
        const [w, s, e, n] = payload.bbox.map(Number);
        if ([w,s,e,n].every(v => Number.isFinite(v))) {
          map.fitBounds([[s, w], [n, e]], { padding: [30, 30] });
          return;
        }
      }
      if (pointMarker) map.setView(pointMarker.getLatLng(), 11);
    } catch {}
  }

  function renderAttrs(obj) {
    el.attrsBox.innerHTML = "";
    if (!obj || typeof obj !== "object" || !Object.keys(obj).length) {
      el.attrsBox.appendChild(dom("div", { class: "muted", text: "Sin atributos." }));
      return;
    }

    const table = dom("table", { class: "attrTable" });
    Object.keys(obj).sort().forEach((k) => {
      const tr = dom("tr");
      tr.appendChild(dom("td", { class: "k", text: safeText(k) }));
      tr.appendChild(dom("td", { class: "v", text: safeText(obj[k]) }));
      table.appendChild(tr);
    });
    el.attrsBox.appendChild(table);
  }

  function setActiveRow(id) {
    [...el.layersList.querySelectorAll(".layerRow")].forEach(r => {
      r.classList.toggle("active", r.getAttribute("data-id") === id);
    });
  }

  function getLayerById(id) {
    const layers = Array.isArray(payload.layers) ? payload.layers : [];
    return layers.find(l => l.__id === id) || null;
  }

  function selectLayer(id, opts = { zoom: true }) {
    const layer = getLayerById(id);
    if (!layer) return;
    selectedLayerId = id;

    setActiveRow(id);

    const hasPoly = hasGeoJSON(layer.polygon);
    el.btnDownloadSelectedGeoJSON.disabled = !hasPoly;

    // props
    let props = null;
    if (layer.polygon && layer.polygon.type === "Feature" && layer.polygon.properties) props = layer.polygon.properties;
    else props = layer.properties || null;
    renderAttrs(props);

    if (hasPoly) {
      setPolygonOnMap(layer.polygon);
      if (opts.zoom) fitToContext();
      showToast("Polígono seleccionado.");
    } else {
      polyLayer.clearLayers();
      if (opts.zoom) fitToContext();
      showToast("Sin polígono asociado (sin match).");
    }

    // KPIs desde la capa seleccionada
    el.kpiLayer.textContent = safeText(layer.name || "—");
    const dist = (layer.distanceM !== null && layer.distanceM !== undefined) ? layer.distanceM : (payload?.summary?.minDistanceM ?? null);
    el.kpiDist.textContent = fmtDist(dist);

    const b2 = statusToBadge(layer.status);
    el.kpiStatus.className = `badge ${b2.cls}`;
    el.kpiStatus.textContent = b2.label;
  }

  function renderTopKPIs() {
    const summary = payload.summary || {};
    const layers = Array.isArray(payload.layers) ? payload.layers : [];

    let status = summary.status;
    let dominantLayer = summary.dominantLayer;

    if (!status || !dominantLayer) {
      const rank = (s) => {
        const x = String(s || "").toLowerCase();
        if (["in","inside","within","edge","onedge"].includes(x)) return 4;
        if (["prox","proximity","buffer","zam"].includes(x)) return 3;
        if (["out","outside","fuera"].includes(x)) return 2;
        if (["none","nomatch","no match","sin match","sin_match"].includes(x)) return 1;
        return 0;
      };
      const best = [...layers].sort((a,b) => rank(b.status) - rank(a.status))[0];
      if (!status && best?.status) status = best.status;
      if (!dominantLayer && best?.name) dominantLayer = best.name;
    }

    const b = statusToBadge(status);
    el.kpiStatus.className = `badge ${b.cls}`;
    el.kpiStatus.textContent = b.label;

    let minD = summary.minDistanceM;
    if (minD === null || minD === undefined) {
      const ds = layers.map(l => l?.distanceM).filter(v => v !== null && v !== undefined && Number.isFinite(Number(v)));
      if (ds.length) minD = Math.min(...ds.map(Number));
    }
    el.kpiDist.textContent = fmtDist(minD);
    el.kpiLayer.textContent = dominantLayer ? safeText(dominantLayer) : "—";

    // tech
    el.techUpdated.textContent = safeText(payload.updatedAt || "—");
    const click = normalizeClick(payload.click);
    el.techClick.textContent = click ? `${click.lat.toFixed(6)}, ${click.lng.toFixed(6)}` : "—";
    if (payload?.bbox && Array.isArray(payload.bbox) && payload.bbox.length === 4) {
      const [w,s,e,n] = payload.bbox;
      el.techBbox.textContent = `${Number(w).toFixed(3)}, ${Number(s).toFixed(3)} — ${Number(e).toFixed(3)}, ${Number(n).toFixed(3)}`;
    } else el.techBbox.textContent = "—";
  }

  function renderLayers() {
    const layers = Array.isArray(payload.layers) ? payload.layers : [];
    el.layersCount.textContent = String(layers.length || 0);
    el.layersList.innerHTML = "";

    if (!layers.length) {
      el.layersList.appendChild(dom("div", { class: "muted", text: "Sin capas en el resultado." }));
      return;
    }

    layers.forEach((layer) => {
      const id = safeText(layer.id || layer.name || `layer_${Math.random().toString(16).slice(2)}`);
      layer.__id = id;

      const badge = rowBadgeMini(layer.status);
      const dist = fmtDist(layer.distanceM);

      const row = dom("div", { class: "layerRow", "data-id": id });
      const left = dom("div", { class: "layerRow__left" }, [
        dom("div", { class: "layerRow__name", text: safeText(layer.name || "Capa") }),
        dom("div", { class: "layerRow__meta" }, [
          dom("span", { class: `badgeMini ${badge.cls}`, text: badge.label }),
          dom("span", { class: "small", text: `Dist.: ${dist}` }),
        ]),
      ]);

      const right = dom("div", { class: "layerRow__right" }, [
        dom("button", {
          class: "iconBtn",
          title: "Zoom/centrar",
          onClick: (ev) => { ev.stopPropagation(); selectLayer(id, { zoom: true }); }
        }, "⤢"),
        dom("button", {
          class: "iconBtn",
          title: "Atributos",
          onClick: (ev) => { ev.stopPropagation(); selectLayer(id, { zoom: false }); }
        }, "≡"),
      ]);

      row.append(left, right);
      row.addEventListener("click", () => selectLayer(id, { zoom: true }));
      el.layersList.appendChild(row);
    });
  }

  function wireEvents() {
    el.btnBack.addEventListener("click", () => {
      if (history.length > 1) history.back();
      else location.href = "./index.html";
    });

    el.btnFit.addEventListener("click", () => fitToContext());

    el.btnDownloads.addEventListener("click", (e) => { e.stopPropagation(); toggleMenu(); });
    document.addEventListener("click", () => toggleMenu(false));

    el.btnDownloadJSON.addEventListener("click", () => {
      toggleMenu(false);
      downloadText(`geonemo_resultado_${Date.now()}.json`, JSON.stringify(payload, null, 2), "application/json");
      showToast("Descargando JSON…");
    });

    el.btnDownloadSelectedGeoJSON.addEventListener("click", () => {
      toggleMenu(false);
      const layer = selectedLayerId ? getLayerById(selectedLayerId) : null;
      if (!layer || !hasGeoJSON(layer.polygon)) return;
      const fc = toFeatureCollection(layer.polygon);
      downloadText(`geonemo_poligono_${(layer.__id || "seleccion")}.geojson`, JSON.stringify(fc, null, 2), "application/geo+json");
      showToast("Descargando GeoJSON…");
    });

    el.btnCopyLink.addEventListener("click", async () => {
      toggleMenu(false);
      const click = normalizeClick(payload.click);
      const url = new URL(location.href);
      if (click) { url.searchParams.set("lat", String(click.lat)); url.searchParams.set("lng", String(click.lng)); }
      url.searchParams.set("k", STORAGE_KEY);
      try { await navigator.clipboard.writeText(url.toString()); showToast("Link copiado."); }
      catch { showToast("No se pudo copiar (permiso navegador)."); }
    });

    el.btnEvidence.addEventListener("click", () => {
      // baja a la tarjeta de capas
      const card = document.getElementById("layersList")?.closest(".card");
      if (card) card.scrollIntoView({ behavior: "smooth", block: "start" });
    });

    el.btnTech.addEventListener("click", () => {
      const hidden = el.techBox.classList.contains("tech--hidden");
      el.techBox.classList.toggle("tech--hidden", !hidden);
      el.btnTech.textContent = hidden ? "Ocultar detalles" : "Detalles técnicos";
    });

    document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") toggleMenu(false); });
  }

  function boot() {
    payload = loadPayload() || buildFallbackPayload();

    const click = normalizeClick(payload.click);
    initMap(click);

    renderTopKPIs();
    renderLayers();

    // seleccionar capa inicial
    const layers = Array.isArray(payload.layers) ? payload.layers : [];
    const best = layers.find(l => hasGeoJSON(l.polygon)) || layers[0];
    if (best) selectLayer(best.__id, { zoom: false });

    // Leaflet dentro de recuadro: asegurar tamaño correcto
    setTimeout(() => { if (map) map.invalidateSize(true); fitToContext(); }, 180);

    wireEvents();
    showToast(loadPayload() ? "Resultado cargado." : "Sin datos: mostrando ejemplo (Santiago).");
  }

  window.addEventListener("load", boot);
})();
