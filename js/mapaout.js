(() => {
  "use strict";

  const STORAGE_KEY = "geonemo_out_v2";
  const MAP_PREF_KEY = "geonemo_map_pref";
  const FIT_MODE_KEY = "geonemo_fit_mode"; // "area" | "area_point"

  const el = {
    toast: document.getElementById("toast"),

    btnBack: document.getElementById("btnBack"),
    btnDownloads: document.getElementById("btnDownloads"),
    downloadsMenu: document.getElementById("downloadsMenu"),
    btnDownloadJSON: document.getElementById("btnDownloadJSON"),
    btnDownloadSelectedGeoJSON: document.getElementById("btnDownloadSelectedGeoJSON"),
    btnCopyLink: document.getElementById("btnCopyLink"),

    groupsCount: document.getElementById("groupsCount"),
    groupsWrap: document.getElementById("groupsWrap"),
  };

  let payload = null;

  // maps por grupo
  const groupMaps = new Map(); // groupId -> { map, polyLayer, pointMarker, tagLayer }
  let activeGroupId = null;    // grupo "activo" (para descarga GeoJSON)

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

  function readMapPref() {
    try { return JSON.parse(localStorage.getItem(MAP_PREF_KEY) || "{}"); }
    catch { return {}; }
  }

  function readFitMode() {
    const v = String(localStorage.getItem(FIT_MODE_KEY) || "").toLowerCase();
    return (v === "area" || v === "area_point") ? v : "area_point";
  }

  function writeFitMode(v) {
    const mode = (v === "area" || v === "area_point") ? v : "area_point";
    localStorage.setItem(FIT_MODE_KEY, mode);
    return mode;
  }

  function toggleMenu(forceOpen = null) {
    if (!el.downloadsMenu) return;
    const open = forceOpen !== null ? forceOpen : !el.downloadsMenu.classList.contains("open");
    el.downloadsMenu.classList.toggle("open", open);
    el.downloadsMenu.setAttribute("aria-hidden", open ? "false" : "true");
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

    // bbox objeto -> array
    if (out.bbox && typeof out.bbox === "object" && !Array.isArray(out.bbox)) {
      const w = Number(out.bbox.west), s = Number(out.bbox.south),
        e = Number(out.bbox.east), n = Number(out.bbox.north);
      if ([w, s, e, n].every(Number.isFinite)) out.bbox = [w, s, e, n];
    }

    // links[] -> layers[] (compat)
    if (!Array.isArray(out.layers) && Array.isArray(out.links)) {
      out.layers = out.links.map((link, i) => {
        const status = canonicalStatusFromLinkType(link.link_type || link.status);
        const poly = link.feature || link.polygon || null;

        return {
          id: link.layer_id || link.id || `layer_${i}`,
          name: link.layer_name || link.name || "Capa",
          status,
          rawStatus: String(link.link_type || link.status || "").toLowerCase(),

          distanceM: (link.distance_km != null && isFinite(link.distance_km))
            ? Number(link.distance_km) * 1000
            : (link.distance_m != null ? Number(link.distance_m) : null),

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

  function renderAttrs(boxEl, obj) {
    if (!boxEl) return;
    boxEl.innerHTML = "";

    if (!obj || typeof obj !== "object" || !Object.keys(obj).length) {
      boxEl.appendChild(dom("div", { class: "muted", text: "Sin atributos." }));
      return;
    }

    const table = dom("table", { class: "attrTable" });
    Object.keys(obj).sort().forEach((k) => {
      const tr = dom("tr");
      tr.appendChild(dom("td", { class: "k", text: safeText(k) }));
      tr.appendChild(dom("td", { class: "v", text: safeText(obj[k]) }));
      table.appendChild(tr);
    });
    boxEl.appendChild(table);
  }

  /* =========================
     Map por grupo
  ========================= */

function createLeafletMap(divId, click) {
  const map = L.map(divId, { zoomControl: true, attributionControl: true });

  // ✅ BASE SATELITAL 100% (sin OSM/OpenTopoMap debajo)
  const satBase = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    {
      name: "Esri Satélite",
      maxZoom: 19,
      opacity: 1.0,
      attribution: "Tiles &copy; Esri",
      crossOrigin: true,
      updateWhenIdle: true
    }
  );

  satBase.addTo(map);

  const latlng = click ? [click.lat, click.lng] : [-24.5, -70.55];
  const pointMarker = L.circleMarker(latlng, {
    radius: 8,
    weight: 2,
    color: "#ffffff",
    fillColor: "#2dd4bf",
    fillOpacity: 0.95,
  }).addTo(map);

  const polyLayer = L.geoJSON(null, {
    style: () => ({
      color: "#38bdf8",
      weight: 2,
      fillColor: "#38bdf8",
      fillOpacity: 0.14,
    }),
  }).addTo(map);

  map.setView(latlng, 10);
  return { map, pointMarker, polyLayer };
}


  function setPolygon(polyLayer, gj) {
    if (!polyLayer) return;
    polyLayer.clearLayers();
    const fc = toFeatureCollection(gj);
    if (!fc) return;
    polyLayer.addData(fc);
  }

  function fitToContext(mapObj, layerObj, click) {
    const { map, polyLayer, pointMarker } = mapObj;
    const mode = readFitMode(); // "area" | "area_point"
    try {
      if (polyLayer && polyLayer.getLayers().length) {
        const b = polyLayer.getBounds();
        if (b && b.isValid()) {
          if (mode === "area_point" && pointMarker) b.extend(pointMarker.getLatLng());
          map.fitBounds(b.pad(0.12));
          return;
        }
      }
      if (click && pointMarker) map.setView(pointMarker.getLatLng(), 11);
    } catch (e) {
      console.warn("fitToContext:", e);
    }
  }

  function computeMetrics(layer, click) {
    const out = {
      distBorde: "—",
      distCentroid: "—",
      diamEq: "—",
      centroidDD: "—",
      centroidDMS: "—",
      area: "—",
    };

    // borde desde payload (si viene)
    const dB = (layer?.borderDistanceM != null) ? layer.borderDistanceM : null;
    if (dB != null) out.distBorde = fmtDist(dB);

    if (!window.turf || !layer || !hasGeoJSON(layer.polygon)) return out;

    try {
      const fc = toFeatureCollection(layer.polygon);
      const feat = fc?.features?.[0];
      if (!feat) return out;

      const areaM2 = turf.area(feat);
      out.area = fmtArea(areaM2);

      const c = turf.centroid(feat);
      const lon = c?.geometry?.coordinates?.[0];
      const lat = c?.geometry?.coordinates?.[1];

      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        out.centroidDD = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
        out.centroidDMS = `${ddToDms(lat, true)} · ${ddToDms(lon, false)}`;
      }

      // dist centroide
      if (click && Number.isFinite(lat) && Number.isFinite(lon)) {
        const pClick = turf.point([click.lng, click.lat]);
        const pC = turf.point([lon, lat]);
        const distM = turf.distance(pClick, pC, { units: "kilometers" }) * 1000;
        out.distCentroid = fmtDist(distM);
      }

      // diámetro equivalente
      const diamM = (Number.isFinite(areaM2) && areaM2 > 0) ? (2 * Math.sqrt(areaM2 / Math.PI)) : null;
      if (diamM != null && Number.isFinite(diamM)) {
        out.diamEq = (diamM < 1000) ? `${Math.round(diamM)} m` : `${(diamM / 1000).toFixed(2)} km`;
      }

    } catch (e) {
      console.warn("computeMetrics:", e);
    }

    return out;
  }

  /* =========================
     Render por grupo
  ========================= */

  function setActiveGroup(groupId) {
    activeGroupId = groupId;
    // marca visual (opcional): borde del head
    document.querySelectorAll(".groupCard").forEach(card => {
      card.classList.toggle("isActive", card.getAttribute("data-group-id") === groupId);
    });

    // botón download GeoJSON depende del grupo activo con polígono
    if (el.btnDownloadSelectedGeoJSON) {
      const layer = getLayerById(groupId);
      el.btnDownloadSelectedGeoJSON.disabled = !(layer && hasGeoJSON(layer.polygon));
    }
  }

  function getLayerById(groupId) {
    const layers = Array.isArray(payload?.layers) ? payload.layers : [];
    return layers.find(l => String(l.id) === String(groupId)) || null;
  }

  function renderGroupCard(layer, click, idx) {
    const groupId = String(layer?.id ?? `group_${idx}`);
    const name = safeText(layer?.name || "Grupo");
    const status = safeText(layer?.status || "none");
    const badgeMini = rowBadgeMini(status);

    const distShownM = (layer?.borderDistanceM != null) ? layer.borderDistanceM : layer?.distanceM;
    const distText = fmtDist(distShownM);

    const b = statusToBadge(status);

    const mapDivId = `map_${groupId.replace(/[^a-zA-Z0-9_:-]/g, "_")}_${idx}`;

    // Head
    const head = dom("div", { class: "groupHead" }, [
      dom("div", { class: "groupTitle" }, [
        dom("div", { class: "groupTitle__name", text: name }),
        dom("div", { class: "groupTitle__sub", text: `Dist.: ${distText}` }),
      ]),
      dom("div", { class: "groupMeta" }, [
        dom("span", { class: `badgeMini ${badgeMini.cls}`, text: badgeMini.label }),
        dom("span", { class: "badge " + b.cls, text: b.label }),
        dom("span", { class: "groupChevron", text: "▾" }),
      ])
    ]);

    // Body
    const mapHeadRight = dom("div", { class: "right" }, [
      dom("button", {
        class: "btn btn--ghost btnSm",
        type: "button",
        title: "Centrar (área / área+punto)",
        onclick: (ev) => {
          ev.stopPropagation();
          const cur = readFitMode();
          const next = (cur === "area_point") ? "area" : "area_point";
          const mode = writeFitMode(next);
          showToast(mode === "area" ? "Vista: área" : "Vista: área + punto");
          const gm = groupMaps.get(groupId);
          if (gm) fitToContext(gm, layer, click);
        }
      }, "🎯"),
      dom("button", {
        class: "btn btn--ghost btnSm",
        type: "button",
        title: "Ajustar vista",
        onclick: (ev) => {
          ev.stopPropagation();
          const gm = groupMaps.get(groupId);
          if (gm) fitToContext(gm, layer, click);
        }
      }, "⤢"),
    ]);

    const mapCard = dom("div", { class: "groupMapCard" }, [
      dom("div", { class: "groupMapHead" }, [
        dom("div", { class: "left", text: "Mapa del grupo" }),
        mapHeadRight,
      ]),
      dom("div", { id: mapDivId, class: "groupMap" }),
    ]);

    const side = dom("div", { class: "groupSide" });
    const metrics = computeMetrics(layer, click);

    const kpis = dom("div", { class: "groupKpis" }, [
      dom("div", { class: "kpi" }, [
        dom("div", { class: "kpi__label", text: "Estado" }),
        dom("div", { class: `badge ${b.cls}`, text: b.label }),
      ]),
      dom("div", { class: "kpi" }, [
        dom("div", { class: "kpi__label", text: "Distancia mínima" }),
        dom("div", { class: "kpi__value", text: distText }),
      ]),
      dom("div", { class: "kpi kpiFull" }, [
        dom("div", { class: "kpi__label", text: "Grupo" }),
        dom("div", { class: "kpi__value", text: name }),
      ]),

      // Estadígrafos (bloque simple, mantenible)
      dom("div", { class: "kpi kpiFull" }, [
        dom("div", { class: "kpi__label", text: "Estadígrafos" }),
        dom("div", { class: "muted", text: "Geometría" }),
        dom("div", { class: "kpi__value", text: `Dist. borde: ${metrics.distBorde} · Diám. eq: ${metrics.diamEq}` }),
        dom("div", { class: "muted", style: "margin-top:6px;", text: "Localización" }),
        dom("div", { class: "kpi__value", text: `${metrics.centroidDD}` }),
        dom("div", { class: "kpi__value muted", text: `${metrics.centroidDMS}` }),
        dom("div", { class: "muted", style: "margin-top:6px;", text: "Magnitudes" }),
        dom("div", { class: "kpi__value", text: `Dist. centroide: ${metrics.distCentroid}` }),
        dom("div", { class: "kpi__value", text: `Área: ${metrics.area}` }),
      ]),
    ]);

    side.appendChild(kpis);

    // Atributos (del feature si existe)
    const attrsBox = dom("div", { class: "groupAttrs" }, [
      dom("div", { class: "muted", text: "Atributos" }),
      dom("div", { class: "attrsInner" }),
    ]);
    side.appendChild(attrsBox);

    // resolve props
    let props = null;
    if (layer.polygon && layer.polygon.type === "Feature" && layer.polygon.properties) props = layer.polygon.properties;
    else props = layer.properties || null;
    renderAttrs(attrsBox.querySelector(".attrsInner"), props);

    const grid = dom("div", { class: "groupGrid" }, [mapCard, side]);

    const body = dom("div", { class: "groupBody" }, [grid]);

    const card = dom("div", { class: "groupCard", "data-group-id": groupId }, [head, body]);

    // colapsable
    head.addEventListener("click", () => {
      const isHidden = body.classList.toggle("isHidden");
      head.querySelector(".groupChevron").textContent = isHidden ? "▸" : "▾";

      // al expandir: asegurar mapa inicializado y calzar
      if (!isHidden) {
        setActiveGroup(groupId);
        ensureGroupMap(groupId, mapDivId, layer, click, name);
        requestAnimationFrame(() => {
          const gm = groupMaps.get(groupId);
          if (gm) {
            gm.map.invalidateSize(true);
            fitToContext(gm, layer, click);
          }
        });
      }
    });

    // al hacer foco activo (sin colapsar)
    card.addEventListener("mouseenter", () => setActiveGroup(groupId));

    // init default (no-lazy) para el primer grupo: simple
    return { card, groupId, mapDivId };
  }

  function ensureGroupMap(groupId, mapDivId, layer, click, groupName) {
    if (groupMaps.has(groupId)) return;

    const mapObj = createLeafletMap(mapDivId, click);
    groupMaps.set(groupId, mapObj);

    // polígono
    if (layer && hasGeoJSON(layer.polygon)) {
      setPolygon(mapObj.polyLayer, layer.polygon);

      // etiqueta (tooltip) para UX: nombre del grupo
      try {
        const fc = toFeatureCollection(layer.polygon);
        const feat = fc?.features?.[0];
        if (feat && window.turf) {
          const c = turf.centroid(feat);
          const lon = c?.geometry?.coordinates?.[0];
          const lat = c?.geometry?.coordinates?.[1];
          if (Number.isFinite(lat) && Number.isFinite(lon)) {
            L.marker([lat, lon], { opacity: 0.0 })
              .addTo(mapObj.map)
              .bindTooltip(groupName, { permanent: true, direction: "center", className: "groupTag" })
              .openTooltip();
          }
        }
      } catch (_) {}
    }

    fitToContext(mapObj, layer, click);
  }

function renderAllGroups() {
  if (!el.groupsWrap) return;

  const layers = Array.isArray(payload?.layers) ? payload.layers : [];
  el.groupsWrap.innerHTML = "";

  if (el.groupsCount) el.groupsCount.textContent = String(layers.length || 0);

  if (!layers.length) {
    el.groupsWrap.appendChild(
      dom("div", { class: "muted", text: "Sin grupos en el resultado." })
    );
    return;
  }

  const click = normalizeClick(payload?.click);

  // ✅ ORDEN ÚNICO: distancia menor → mayor
  const sorted = [...layers].sort((a, b) => {
    const da = Number.isFinite(a?.borderDistanceM)
      ? a.borderDistanceM
      : Number.isFinite(a?.distanceM)
        ? a.distanceM
        : Infinity;

    const db = Number.isFinite(b?.borderDistanceM)
      ? b.borderDistanceM
      : Number.isFinite(b?.distanceM)
        ? b.distanceM
        : Infinity;

    return da - db;
  });

  const rendered = sorted.map((layer, idx) =>
    renderGroupCard(layer, click, idx)
  );

  rendered.forEach(r => el.groupsWrap.appendChild(r.card));

  // activar primer grupo (el más cercano)
  const first = rendered[0];
  if (first) {
    setActiveGroup(first.groupId);
    ensureGroupMap(
      first.groupId,
      first.mapDivId,
      getLayerById(first.groupId),
      click,
      getLayerById(first.groupId)?.name || "Grupo"
    );

    const body = first.card.querySelector(".groupBody");
    const chev = first.card.querySelector(".groupChevron");
    if (body) body.classList.remove("isHidden");
    if (chev) chev.textContent = "▾";

    requestAnimationFrame(() => {
      const gm = groupMaps.get(first.groupId);
      if (gm) {
        gm.map.invalidateSize(true);
        fitToContext(gm, getLayerById(first.groupId), click);
      }
    });
  }

  showToast("Resultado cargado.");
}


  function wireEvents() {
    if (el.btnBack) {
      el.btnBack.addEventListener("click", () => {
        if (history.length > 1) history.back();
        else location.href = "./index.html";
      });
    }

    if (el.btnDownloads) el.btnDownloads.addEventListener("click", (e) => { e.stopPropagation(); toggleMenu(); });
    document.addEventListener("click", () => toggleMenu(false));
    document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") toggleMenu(false); });

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
        const layer = activeGroupId ? getLayerById(activeGroupId) : null;
        if (!layer || !hasGeoJSON(layer.polygon)) return;
        const fc = toFeatureCollection(layer.polygon);
        downloadText(
          `geonemo_poligono_${String(layer.id || "grupo")}.geojson`,
          JSON.stringify(fc, null, 2),
          "application/geo+json"
        );
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

    wireEvents();

    // si no hay turf, igual renderiza (solo sin métricas avanzadas)
    renderAllGroups();
  }

  window.addEventListener("load", boot);
})();
