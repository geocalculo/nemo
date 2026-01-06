(() => {
  "use strict";

  // ==========================
  // CONFIG
  // ==========================
  const STORAGE_KEY = "geonemo_out_v2";

  // ==========================
  // DOM REFS
  // ==========================
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

  // ==========================
  // STATE
  // ==========================
  let payload = null;
  let map = null;
  let pointMarker = null;
  let polyLayer = null;
  let selectedLayerId = null;

  // ==========================
  // UI HELPERS
  // ==========================
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

  // ==========================
  // GEO HELPERS
  // ==========================
  function normalizeClick(click) {
    if (!click) return null;

    // array [lat,lng] or [lng,lat] (we’ll detect loosely)
    if (Array.isArray(click) && click.length >= 2) {
      const a = Number(click[0]);
      const b = Number(click[1]);
      // If first looks like lon and second like lat, swap
      // lon in [-180,180], lat in [-90,90]
      const looksLikeLonLat = Math.abs(a) <= 180 && Math.abs(b) <= 90;
      const looksLikeLatLon = Math.abs(a) <= 90 && Math.abs(b) <= 180;
      if (looksLikeLonLat && !looksLikeLatLon) return { lat: b, lng: a };
      return { lat: a, lng: b };
    }

    // object {lat,lng} or {lat,lon} or {y,x}
    if (typeof click === "object") {
      if (click.lat !== undefined && click.lng !== undefined) return { lat: +click.lat, lng: +click.lng };
      if (click.lat !== undefined && click.lon !== undefined) return { lat: +click.lat, lng: +click.lon };
      if (click.y !== undefined && click.x !== undefined) return { lat: +click.y, lng: +click.x };
    }

    return null;
  }

  function hasGeoJSON(gj) {
    return !!(gj && (gj.type === "Feature" || gj.type === "FeatureCollection" || gj.type === "Polygon" || gj.type === "MultiPolygon"));
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

  // ==========================
  // BADGES (UI)
  // ==========================
  function statusToBadge(status) {
    const s = String(status || "").toLowerCase();
    if (["in", "inside", "within", "onedge", "on_edge", "edge"].includes(s)) return { label: "DENTRO", cls: "badge--in" };
    if (["prox", "proximity", "buffer", "zam", "nearest_perimeter"].includes(s)) return { label: "PROXIMIDAD", cls: "badge--prox" };
    if (["out", "outside", "fuera"].includes(s)) return { label: "FUERA", cls: "badge--out" };
    if (["none", "nomatch", "no match", "sin match", "sin_match"].includes(s)) return { label: "SIN MATCH", cls: "badge--neutral" };
    return { label: safeText(status || "—").toUpperCase() || "—", cls: "badge--neutral" };
  }

  function rowBadgeMini(status) {
    const s = String(status || "").toLowerCase();
    if (["in", "inside", "within", "edge", "onedge"].includes(s)) return { label: "in", cls: "in" };
    if (["prox", "proximity", "buffer", "zam", "nearest_perimeter"].includes(s)) return { label: "prox", cls: "prox" };
    if (["out", "outside", "fuera"].includes(s)) return { label: "out", cls: "out" };
    if (["none", "nomatch", "no match", "sin match", "sin_match"].includes(s)) return { label: "sin", cls: "none" };
    return { label: "—", cls: "none" };
  }

  // ==========================
  // STORAGE
  // ==========================
  function loadPayload() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    try { return JSON.parse(raw); }
    catch { return null; }
  }

  // ==========================
  // NORMALIZATION (index.js -> mapaout.js)
  // ==========================
  function canonicalStatusFromLinkType(linkType) {
    const lt = String(linkType || "").toLowerCase();
    if (["inside", "in", "within", "edge", "onedge", "on_edge"].includes(lt)) return "inside";
    if (["nearest_perimeter", "prox", "proximity", "buffer", "zam"].includes(lt)) return "prox";
    if (["out", "outside", "fuera"].includes(lt)) return "out";
    return "none";
  }

  function generateSummaryFromLinks(links) {
    if (!Array.isArray(links) || !links.length) {
      return { status: "none", rawStatus: "none", minDistanceM: null, dominantLayer: "—" };
    }

    const rank = (lt) => {
      const s = String(lt || "").toLowerCase();
      if (s === "inside") return 3;
      if (s === "nearest_perimeter") return 2;
      if (s === "none") return 1;
      return 0;
    };

    const sorted = [...links].sort((a, b) => {
      const r = rank(b.link_type) - rank(a.link_type);
      if (r !== 0) return r;
      const da = (a.distance_km != null) ? Number(a.distance_km) : Infinity;
      const db = (b.distance_km != null) ? Number(b.distance_km) : Infinity;
      return da - db;
    });

    const domLink = sorted[0];
    const rawStatus = String(domLink.link_type || "none").toLowerCase();
    const status = canonicalStatusFromLinkType(rawStatus);

    return {
      status,
      rawStatus,
      minDistanceM: (domLink.distance_km != null) ? Number(domLink.distance_km) * 1000 : null,
      dominantLayer: domLink.layer_name || "—"
    };
  }

  function normalizePayload(raw) {
    if (!raw || typeof raw !== "object") return null;

    // If already normalized, just patch minor differences
    const out = { ...raw };

    // updatedAt
    out.updatedAt = out.updatedAt || out.updated_at || new Date().toISOString();

    // click: lon -> lng
    if (out.click && typeof out.click === "object") {
      if (out.click.lng === undefined && out.click.lon !== undefined) {
        out.click = { ...out.click, lng: out.click.lon };
      }
    }

    // bbox: object {west,south,east,north} -> [w,s,e,n]
    if (out.bbox && typeof out.bbox === "object" && !Array.isArray(out.bbox)) {
      const w = Number(out.bbox.west), s = Number(out.bbox.south),
            e = Number(out.bbox.east), n = Number(out.bbox.north);
      if ([w, s, e, n].every(Number.isFinite)) out.bbox = [w, s, e, n];
    }

    // links[] -> layers[]
    if (!Array.isArray(out.layers) && Array.isArray(out.links)) {
      out.layers = out.links.map((link, i) => {
        const status = canonicalStatusFromLinkType(link.link_type || link.status);
        const poly = link.feature || link.polygon || null;

        return {
          id: link.layer_id || link.id || `layer_${i}`,
          name: link.layer_name || link.name || "Capa",
          status,
          rawStatus: String(link.link_type || link.status || "").toLowerCase(),
          distanceM: (link.distance_km != null && isFinite(link.distance_km)) ? Number(link.distance_km) * 1000
                   : (link.distanceM != null ? Number(link.distanceM) : null),
          polygon: poly,
          properties: (poly?.properties) || link.properties || null
        };
      });

      if (!out.summary) out.summary = generateSummaryFromLinks(out.links);
    } else if (!out.summary && Array.isArray(out.layers)) {
      // Create a minimal summary if layers exist but no summary
      const best = [...out.layers].sort((a, b) => {
        const ra = (a.status === "inside") ? 3 : (a.status === "prox") ? 2 : (a.status === "out") ? 1 : 0;
        const rb = (b.status === "inside") ? 3 : (b.status === "prox") ? 2 : (b.status === "out") ? 1 : 0;
        if (rb !== ra) return rb - ra;
        const da = (a.distanceM != null) ? Number(a.distanceM) : Infinity;
        const db = (b.distanceM != null) ? Number(b.distanceM) : Infinity;
        return da - db;
      })[0];

      out.summary = {
        status: best?.status || "none",
        rawStatus: best?.rawStatus || best?.status || "none",
        minDistanceM: (best?.distanceM != null) ? Number(best.distanceM) : null,
        dominantLayer: best?.name || "—"
      };
    }

    return out;
  }

  // ==========================
  // MAP
  // ==========================
  function initMap(click) {
    if (!window.L) {
      console.error("Leaflet (L) no está cargado.");
      return;
    }

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

    const latlng = click ? [click.lat, click.lng] : [-24.5, -70.55]; // fallback neutral norte (no Santiago)
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
    if (!polyLayer) return;
    polyLayer.clearLayers();
    const fc = toFeatureCollection(gj);
    if (!fc) return;
    polyLayer.addData(fc);
  }

  function fitToContext() {
    if (!map) return;
    try {
      if (polyLayer && polyLayer.getLayers().length) {
        const b = polyLayer.getBounds();
        if (b.isValid()) { map.fitBounds(b.pad(0.12)); return; }
      }
      if (payload?.bbox && Array.isArray(payload.bbox) && payload.bbox.length === 4) {
        const [w, s, e, n] = payload.bbox.map(Number);
        if ([w, s, e, n].every(Number.isFinite)) {
          map.fitBounds([[s, w], [n, e]], { padding: [30, 30] });
          return;
        }
      }
      if (pointMarker) map.setView(pointMarker.getLatLng(), 11);
    } catch (err) {
      console.warn("fitToContext error:", err);
    }
  }

  // ==========================
  // RENDERERS
  // ==========================
  function renderAttrs(obj) {
    if (!el.attrsBox) return;
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
    if (!el.layersList) return;
    [...el.layersList.querySelectorAll(".layerRow")].forEach(r => {
      r.classList.toggle("active", r.getAttribute("data-id") === id);
    });
  }

  function getLayerById(id) {
    const layers = Array.isArray(payload?.layers) ? payload.layers : [];
    return layers.find(l => l.__id === id) || null;
  }

  function selectLayer(id, opts = { zoom: true }) {
    const layer = getLayerById(id);
    if (!layer) return;

    selectedLayerId = id;
    setActiveRow(id);

    const hasPoly = hasGeoJSON(layer.polygon);
    if (el.btnDownloadSelectedGeoJSON) el.btnDownloadSelectedGeoJSON.disabled = !hasPoly;

    // attributes
    let props = null;
    if (layer.polygon && layer.polygon.type === "Feature" && layer.polygon.properties) props = layer.polygon.properties;
    else props = layer.properties || null;
    renderAttrs(props);

    // map polygon
    if (hasPoly) {
      setPolygonOnMap(layer.polygon);
      if (opts.zoom) fitToContext();
      showToast("Polígono seleccionado.");
    } else {
      if (polyLayer) polyLayer.clearLayers();
      if (opts.zoom) fitToContext();
      showToast("Sin polígono asociado (sin match).");
    }

    // KPIs from selected layer
    if (el.kpiLayer) el.kpiLayer.textContent = safeText(layer.name || "—");
    const dist = (layer.distanceM !== null && layer.distanceM !== undefined)
      ? layer.distanceM
      : (payload?.summary?.minDistanceM ?? null);
    if (el.kpiDist) el.kpiDist.textContent = fmtDist(dist);

    if (el.kpiStatus) {
      const b2 = statusToBadge(layer.status);
      el.kpiStatus.className = `badge ${b2.cls}`;
      el.kpiStatus.textContent = b2.label;
    }
  }

  function renderTopKPIs() {
    if (!payload) return;
    const summary = payload.summary || {};
    const layers = Array.isArray(payload.layers) ? payload.layers : [];

    let status = summary.status;
    let dominantLayer = summary.dominantLayer;

    if (!status || !dominantLayer) {
      const rank = (s) => {
        const x = String(s || "").toLowerCase();
        if (x === "inside") return 4;
        if (x === "prox") return 3;
        if (x === "out") return 2;
        if (x === "none") return 1;
        return 0;
      };
      const best = [...layers].sort((a, b) => rank(b.status) - rank(a.status))[0];
      if (!status && best?.status) status = best.status;
      if (!dominantLayer && best?.name) dominantLayer = best.name;
    }

    if (el.kpiStatus) {
      const b = statusToBadge(status);
      el.kpiStatus.className = `badge ${b.cls}`;
      el.kpiStatus.textContent = b.label;
    }

    // distance
    let minD = summary.minDistanceM;
    if (minD === null || minD === undefined) {
      const ds = layers.map(l => l?.distanceM).filter(v => v !== null && v !== undefined && Number.isFinite(Number(v)));
      if (ds.length) minD = Math.min(...ds.map(Number));
    }
    if (el.kpiDist) el.kpiDist.textContent = fmtDist(minD);
    if (el.kpiLayer) el.kpiLayer.textContent = dominantLayer ? safeText(dominantLayer) : "—";

    // tech
    if (el.techUpdated) el.techUpdated.textContent = safeText(payload.updatedAt || "—");
    const click = normalizeClick(payload.click);
    if (el.techClick) el.techClick.textContent = click ? `${click.lat.toFixed(6)}, ${click.lng.toFixed(6)}` : "—";

    if (el.techBbox) {
      if (payload?.bbox && Array.isArray(payload.bbox) && payload.bbox.length === 4) {
        const [w, s, e, n] = payload.bbox;
        el.techBbox.textContent = `${Number(w).toFixed(3)}, ${Number(s).toFixed(3)} — ${Number(e).toFixed(3)}, ${Number(n).toFixed(3)}`;
      } else {
        el.techBbox.textContent = "—";
      }
    }
  }

  function renderLayers() {
    const layers = Array.isArray(payload?.layers) ? payload.layers : [];
    if (el.layersCount) el.layersCount.textContent = String(layers.length || 0);
    if (!el.layersList) return;

    el.layersList.innerHTML = "";

    if (!layers.length) {
      el.layersList.appendChild(dom("div", { class: "muted", text: "Sin capas en el resultado." }));
      return;
    }

    layers.forEach((layer, idx) => {
      // stable id
      const id = safeText(layer.id || layer.name || `layer_${idx}`);
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

  // ==========================
  // EVENTS
  // ==========================
  function wireEvents() {
    if (el.btnBack) {
      el.btnBack.addEventListener("click", () => {
        if (history.length > 1) history.back();
        else location.href = "./index.html";
      });
    }

    if (el.btnFit) el.btnFit.addEventListener("click", () => fitToContext());

    if (el.btnDownloads) el.btnDownloads.addEventListener("click", (e) => { e.stopPropagation(); toggleMenu(); });
    document.addEventListener("click", () => toggleMenu(false));

    if (el.btnDownloadJSON) {
      el.btnDownloadJSON.addEventListener("click", () => {
        toggleMenu(false);
        downloadText(`geonemo_resultado_${Date.now()}.json`, JSON.stringify(payload, null, 2), "application/json");
        showToast("Descargando JSON…");
      });
    }

    if (el.btnDownloadSelectedGeoJSON) {
      el.btnDownloadSelectedGeoJSON.addEventListener("click", () => {
        toggleMenu(false);
        const layer = selectedLayerId ? getLayerById(selectedLayerId) : null;
        if (!layer || !hasGeoJSON(layer.polygon)) return;
        const fc = toFeatureCollection(layer.polygon);
        downloadText(`geonemo_poligono_${(layer.__id || "seleccion")}.geojson`, JSON.stringify(fc, null, 2), "application/geo+json");
        showToast("Descargando GeoJSON…");
      });
    }

    if (el.btnCopyLink) {
      el.btnCopyLink.addEventListener("click", async () => {
        toggleMenu(false);
        const click = normalizeClick(payload?.click);
        const url = new URL(location.href);
        if (click) {
          url.searchParams.set("lat", String(click.lat));
          url.searchParams.set("lng", String(click.lng));
        }
        url.searchParams.set("k", STORAGE_KEY);
        try { await navigator.clipboard.writeText(url.toString()); showToast("Link copiado."); }
        catch { showToast("No se pudo copiar (permiso navegador)."); }
      });
    }

    if (el.btnEvidence) {
      el.btnEvidence.addEventListener("click", () => {
        const card = document.getElementById("layersList")?.closest(".card");
        if (card) card.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }

    if (el.btnTech && el.techBox) {
      el.btnTech.addEventListener("click", () => {
        const hidden = el.techBox.classList.contains("tech--hidden");
        el.techBox.classList.toggle("tech--hidden", !hidden);
        el.btnTech.textContent = hidden ? "Ocultar detalles" : "Detalles técnicos";
      });
    }

    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") toggleMenu(false);
    });
  }

  // ==========================
  // BOOT
  // ==========================
  function renderNoPayload() {
    const shell = document.querySelector(".shell") || document.body;
    shell.innerHTML =
      '<div style="padding:32px;text-align:center;min-height:300px;display:flex;flex-direction:column;justify-content:center;gap:10px;">' +
      '<div style="font-size:52px;opacity:.6">📍</div>' +
      '<h2 style="margin:0">No hay resultado en localStorage</h2>' +
      '<p style="margin:0;color:#9aa4b2">Abra mapaout desde el flujo de consulta (click en index.html).</p>' +
      '<p style="margin:0;color:#9aa4b2">Clave esperada: <code>geonemo_out_v2</code></p>' +
      '<div style="margin-top:10px"><button class="btn btn--primary" onclick="location.href=\'./index.html\'">Ir al mapa principal</button></div>' +
      "</div>";
  }

  function boot() {
    const raw = loadPayload();
    payload = normalizePayload(raw);

    if (!payload) {
      renderNoPayload();
      return;
    }

    const click = normalizeClick(payload.click);
    initMap(click);

    renderTopKPIs();
    renderLayers();

    // ✅ Selección inicial: siempre escoger el primero con polígono, si existe
    const layers = Array.isArray(payload.layers) ? payload.layers : [];
    const best = layers.find(l => hasGeoJSON(l.polygon)) || layers[0];

    if (best && best.__id) {
      selectLayer(best.__id, { zoom: false });
    } else if (best && best.id) {
      // por si __id aún no existe por algún motivo
      selectLayer(String(best.id), { zoom: false });
    }

    // Leaflet en recuadro
    setTimeout(() => {
      if (map) map.invalidateSize(true);
      fitToContext();
    }, 180);

    wireEvents();
    showToast("Resultado cargado.");
  }

  window.addEventListener("load", boot);
})();
