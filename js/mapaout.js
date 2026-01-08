(() => {
  "use strict";

  const STORAGE_KEY = "geonemo_out_v2";
  const MAP_PREF_KEY = "geonemo_map_pref";

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

    // Estadígrafos (de tu HTML)
    metDistBorde: document.getElementById("metDistBorde"),
    metDistCentroid: document.getElementById("metDistCentroid"),
    metDiamEq: document.getElementById("metDiamEq"),
    metCentroidDD: document.getElementById("metCentroidDD"),
    metCentroidDMS: document.getElementById("metCentroidDMS"),
    metArea: document.getElementById("metArea"),

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

  function fmtArea(m2) {
    if (m2 === null || m2 === undefined || !Number.isFinite(Number(m2))) return "—";
    const v = Number(m2);
    const ha = v / 10000;
    const km2 = v / 1e6;
    const m2s = Math.round(v).toLocaleString("es-CL");
    const has = ha.toLocaleString("es-CL", { maximumFractionDigits: 2 });
    const km2s = km2.toLocaleString("es-CL", { maximumFractionDigits: 3 });
    return `${m2s} m² · ${has} ha · ${km2s} km²`;
  }

  function readMapPref(){
    try { return JSON.parse(localStorage.getItem(MAP_PREF_KEY) || "{}"); }
    catch { return {}; }
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

  function normalizeClick(click) {
    if (!click) return null;

    if (Array.isArray(click) && click.length >= 2) {
      const a = Number(click[0]);
      const b = Number(click[1]);
      const looksLikeLonLat = Math.abs(a) <= 180 && Math.abs(b) <= 90;
      const looksLikeLatLon = Math.abs(a) <= 90 && Math.abs(b) <= 180;
      if (looksLikeLonLat && !looksLikeLatLon) return { lat: b, lng: a };
      return { lat: a, lng: b };
    }

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

  function ddToDms(dd, isLat) {
    if (!Number.isFinite(Number(dd))) return "—";
    const v = Number(dd);
    const dir = isLat ? (v >= 0 ? "N" : "S") : (v >= 0 ? "E" : "W");
    const av = Math.abs(v);
    const deg = Math.floor(av);
    const minFloat = (av - deg) * 60;
    const min = Math.floor(minFloat);
    const sec = (minFloat - min) * 60;
    const secStr = sec.toFixed(2).padStart(5, "0");
    return `${deg}°${String(min).padStart(2, "0")}'${secStr}" ${dir}`;
  }

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

  function loadPayload() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    try { return JSON.parse(raw); }
    catch { return null; }
  }

  function canonicalStatusFromLinkType(linkType) {
    const lt = String(linkType || "").toLowerCase();
    if (["inside", "in", "within", "edge", "onedge", "on_edge"].includes(lt)) return "inside";
    if (["nearest_perimeter", "prox", "proximity", "buffer", "zam"].includes(lt)) return "prox";
    if (["out", "outside", "fuera"].includes(lt)) return "out";
    return "none";
  }

  function normalizePayload(raw) {
    if (!raw || typeof raw !== "object") return null;
    const out = { ...raw };
    out.updatedAt = out.updatedAt || out.updated_at || new Date().toISOString();

    if (out.click && typeof out.click === "object") {
      if (out.click.lng === undefined && out.click.lon !== undefined) {
        out.click = { ...out.click, lng: out.click.lon };
      }
    }

    // convertir bbox objeto -> array si viene así
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

          // Distancia de dictamen (inside=0, prox=distancia)
          distanceM: (link.distance_km != null && isFinite(link.distance_km))
            ? Number(link.distance_km) * 1000
            : (link.distance_m != null ? Number(link.distance_m) : null),

          // ✅ NUEVO: distancia al borde (estadígrafos)
          borderDistanceM: (link.distance_border_m != null && isFinite(link.distance_border_m))
            ? Number(link.distance_border_m)
            : null,

          polygon: poly,
          properties: (poly?.properties) || link.properties || null
        };
      });
    }

    return out;
  }

  function initMap(click) {
    map = L.map("map", { zoomControl: true, attributionControl: true });

    const topoBase = L.tileLayer(
      "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
      {
        maxZoom: 17,
        subdomains: "abc",
        opacity: 1.0,
        attribution: "Map data: &copy; OpenStreetMap contributors, SRTM | OpenTopoMap",
        crossOrigin: true,
        updateWhenIdle: true
      }
    );

    const satOverlay = L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      {
        maxZoom: 19,
        opacity: 0.25,
        attribution: "Tiles &copy; Esri",
        crossOrigin: true,
        updateWhenIdle: true
      }
    );

    const pref = readMapPref();
    topoBase.addTo(map);

    const wantSat = (pref.overlay === "Esri Satélite") || (pref.overlay == null);
    if (wantSat) satOverlay.addTo(map);

    polyLayer = L.geoJSON(null, {
      style: () => ({
        color: "#38bdf8",
        weight: 2,
        fillColor: "#38bdf8",
        fillOpacity: 0.14,
      }),
    }).addTo(map);

    const latlng = click ? [click.lat, click.lng] : [-24.5, -70.55];
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

  function setMetricsEmpty() {
    if (el.metDistBorde) el.metDistBorde.textContent = "—";
    if (el.metDistCentroid) el.metDistCentroid.textContent = "—";
    if (el.metDiamEq) el.metDiamEq.textContent = "—";
    if (el.metCentroidDD) el.metCentroidDD.textContent = "—";
    if (el.metCentroidDMS) el.metCentroidDMS.textContent = "—";
    if (el.metArea) el.metArea.textContent = "—";
  }

  function updateMetricsForSelectedPolygon(layer) {
    // Distancia mínima al borde (primero)
    const dB = (layer?.borderDistanceM != null) ? layer.borderDistanceM : null;
    if (el.metDistBorde) el.metDistBorde.textContent = fmtDist(dB);

    // Resto requiere Turf + polígono
    if (!window.turf || !layer || !hasGeoJSON(layer.polygon)) {
      // mantenemos borde ya seteado (si lo hay), y el resto en —
      if (el.metDistCentroid) el.metDistCentroid.textContent = "—";
      if (el.metDiamEq) el.metDiamEq.textContent = "—";
      if (el.metCentroidDD) el.metCentroidDD.textContent = "—";
      if (el.metCentroidDMS) el.metCentroidDMS.textContent = "—";
      if (el.metArea) el.metArea.textContent = "—";
      return;
    }

    try {
      const fc = toFeatureCollection(layer.polygon);
      const feat = fc?.features?.[0];
      if (!feat) return;

      const areaM2 = turf.area(feat);

      const c = turf.centroid(feat);
      const lon = c?.geometry?.coordinates?.[0];
      const lat = c?.geometry?.coordinates?.[1];

      const click = normalizeClick(payload?.click);
      let distCentroidM = null;
      if (click && Number.isFinite(lat) && Number.isFinite(lon)) {
        const pClick = turf.point([click.lng, click.lat]);
        const pC = turf.point([lon, lat]);
        distCentroidM = turf.distance(pClick, pC, { units: "kilometers" }) * 1000;
      }

      const diamM = (Number.isFinite(areaM2) && areaM2 > 0)
        ? (2 * Math.sqrt(areaM2 / Math.PI))
        : null;

      if (el.metArea) el.metArea.textContent = fmtArea(areaM2);
      if (el.metDistCentroid) el.metDistCentroid.textContent = fmtDist(distCentroidM);

      if (el.metDiamEq) {
        if (diamM == null || !Number.isFinite(diamM)) el.metDiamEq.textContent = "—";
        else el.metDiamEq.textContent = (diamM < 1000)
          ? `${Math.round(diamM)} m`
          : `${(diamM/1000).toFixed(2)} km`;
      }

      if (el.metCentroidDD) {
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          el.metCentroidDD.textContent = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
        } else el.metCentroidDD.textContent = "—";
      }

      if (el.metCentroidDMS) {
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          const latDms = ddToDms(lat, true);
          const lonDms = ddToDms(lon, false);
          el.metCentroidDMS.textContent = `${latDms} · ${lonDms}`;
        } else el.metCentroidDMS.textContent = "—";
      }

    } catch (e) {
      console.warn("updateMetricsForSelectedPolygon:", e);
    }
  }

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

    let props = null;
    if (layer.polygon && layer.polygon.type === "Feature" && layer.polygon.properties) props = layer.polygon.properties;
    else props = layer.properties || null;
    renderAttrs(props);

    if (hasPoly) {
      setPolygonOnMap(layer.polygon);
      if (opts.zoom) fitToContext();
      showToast("Polígono seleccionado.");
    } else {
      if (polyLayer) polyLayer.clearLayers();
      if (opts.zoom) fitToContext();
      showToast("Sin polígono asociado (sin match).");
    }

    if (el.kpiLayer) el.kpiLayer.textContent = safeText(layer.name || "—");
    if (el.kpiDist) el.kpiDist.textContent = fmtDist(layer.distanceM);

    if (el.kpiStatus) {
      const b2 = statusToBadge(layer.status);
      el.kpiStatus.className = `badge ${b2.cls}`;
      el.kpiStatus.textContent = b2.label;
    }

    updateMetricsForSelectedPolygon(layer);
  }

  function renderTopKPIs() {
    if (!payload) return;
    const layers = Array.isArray(payload.layers) ? payload.layers : [];

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

    setMetricsEmpty();

    if (layers.length) {
      const best = layers.find(l => hasGeoJSON(l.polygon)) || layers[0];
      if (el.kpiLayer) el.kpiLayer.textContent = safeText(best?.name || "—");
      if (el.kpiDist) el.kpiDist.textContent = fmtDist(best?.distanceM ?? null);
      if (el.kpiStatus) {
        const b = statusToBadge(best?.status);
        el.kpiStatus.className = `badge ${b.cls}`;
        el.kpiStatus.textContent = b.label;
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

    const layers = Array.isArray(payload.layers) ? payload.layers : [];
    const best = layers.find(l => hasGeoJSON(l.polygon)) || layers[0];

    // __id se setea en renderLayers
    setTimeout(() => {
      if (best && best.__id) selectLayer(best.__id, { zoom: false });
      else if (best && best.id) selectLayer(String(best.id), { zoom: false });
    }, 0);

    setTimeout(() => {
      if (map) map.invalidateSize(true);
      fitToContext();
    }, 180);

    wireEvents();
    showToast("Resultado cargado.");
  }

  window.addEventListener("load", boot);
})();
