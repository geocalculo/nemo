(function () {
  "use strict";

  const PDF_LAYOUT = { marginLeft: 10, marginRight: 10, marginTop: 13, marginBottom: 14, headerHeight: 8, footerHeight: 8, sectionGap: 4, panelGap: 3 };
  const COLORS = { ink: [31,41,55], muted: [107,114,128], line: [220,226,235], soft: [248,250,252], accent: [14,116,144], accentSoft: [236,253,245], warning: [146,64,14] };
  const LINE = 4.2;

  function assertGeoNemoPDFDependencies() {
    if (!window.jspdf || typeof window.jspdf.jsPDF !== "function") throw new Error("jsPDF no disponible");
    if (typeof window.domtoimage?.toPng !== "function") throw new Error("dom-to-image no disponible"); const { jsPDF } = window.jspdf; const testDoc = new jsPDF(); if (typeof testDoc.autoTable !== "function") throw new Error("jsPDF-AutoTable no disponible");
  }

  function createGeoNemoPdfDocument() {
    const { jsPDF } = window.jspdf;
    return new jsPDF({ orientation: "portrait", unit: "mm", format: "letter", compress: true });
  }

  function fmtDate(date = new Date()) { return new Date(date).toISOString().slice(0, 10); }
  function fmtDateCL(date = new Date()) { const d = new Date(date); return `${String(d.getDate()).padStart(2,"0")}-${String(d.getMonth()+1).padStart(2,"0")}-${d.getFullYear()}`; }
  function present(value) { const text = String(value ?? "").replace(/\s+/g, " ").trim(); return text && !["undefined","null","nan","n/d","—"].includes(text.toLowerCase()) ? text : ""; }
  function fmtNumber(value, digits = 6) { const n = Number(value); return Number.isFinite(n) ? n.toFixed(digits) : ""; }
  function fmtKm(value) { const n = Number(value); return Number.isFinite(n) ? `${n.toLocaleString("es-CL", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} km` : "N/D"; }
  function cleanItems(items) { return (items || []).filter(item => present(item?.label) || present(item?.value)); }
  function deduplicateLabelValueRows(rows) { const seen = new Set(); return (rows || []).filter((row) => { const key = String(row?.label ?? row?.[0] ?? "").trim().toLowerCase(); if (!key || seen.has(key)) return false; seen.add(key); return true; }); }
  function normalizeGeoNemoRelationLabel(value) { const raw = String(value || "none").toLowerCase(); return raw === "intersects" ? "Intersección" : raw === "nearest" ? "Cercanía" : raw === "intersección" || raw === "cercanía" || raw === "sin resultado" ? value : "Sin resultado"; }
  function fmtMeters(value) { const n = Number(value); if (!Number.isFinite(n)) return "N/D"; return n < 1000 ? `${Math.round(n).toLocaleString("es-CL")} m` : `${(n / 1000).toLocaleString("es-CL", { maximumFractionDigits: 2 })} km`; }
  function splitPdfText(doc, text, maxWidth) { return doc.splitTextToSize(String(text ?? ""), maxWidth); }
  function sanitizePdfFilenamePart(value) { return String(value ?? "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80); }
  function normalizePdfUrl(value) { const raw = String(value ?? "").trim(); return /^https?:\/\//i.test(raw) ? raw : ""; }
  function buildFilename(model, filename) {
    if (filename) return sanitizePdfFilenamePart(filename).replace(/\.pdf$/i, "") + ".pdf";
    const date = fmtDate(model?.identity?.generatedAt || new Date());
    const lat = fmtNumber(model?.query?.lat, 6);
    const lon = fmtNumber(model?.query?.lon, 6);
    return lat && lon ? `GeoNEMO_Reporte_${sanitizePdfFilenamePart(lat)}_${sanitizePdfFilenamePart(lon)}_${date}.pdf` : `GeoNEMO_Reporte_${date}.pdf`;
  }

  function createContext(doc, model, map, mapElement) {
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const contentLeft = PDF_LAYOUT.marginLeft;
    const contentRight = pageWidth - PDF_LAYOUT.marginRight;
    const contentWidth = contentRight - contentLeft;
    const contentTop = PDF_LAYOUT.marginTop + PDF_LAYOUT.headerHeight;
    const pageBottom = pageHeight - PDF_LAYOUT.marginBottom - PDF_LAYOUT.footerHeight;
    return { model, map, mapElement, pageWidth, pageHeight, contentLeft, contentRight, contentWidth, contentTop, pageBottom, y: contentTop, sectionGap: PDF_LAYOUT.sectionGap, panelGap: PDF_LAYOUT.panelGap, capturedCharts: [] };
  }

  function setColor(doc, key) { doc.setTextColor(...COLORS[key]); }
  function drawRoundedPanel(doc, x, y, w, h, fill = COLORS.soft) { doc.setFillColor(...fill); doc.setDrawColor(...COLORS.line); doc.roundedRect(x, y, w, h, 2.2, 2.2, "FD"); }
  function addPdfPage(doc, context) { doc.addPage(); context.y = context.contentTop; }
  function ensurePdfSpace(doc, context, requiredHeight) {
    const availableHeight = context.pageBottom - context.contentTop;
    const safeHeight = Math.min(requiredHeight, availableHeight);
    if (context.y + safeHeight > context.pageBottom) addPdfPage(doc, context);
  }
  function drawSectionTitle(doc, title, context) {
    if (!title) return;
    ensurePdfSpace(doc, context, 8);
    doc.setFont("helvetica", "bold"); doc.setFontSize(10.5); doc.setTextColor(...COLORS.accent);
    doc.text(String(title), context.contentLeft, context.y + 4);
    doc.setDrawColor(...COLORS.line); doc.line(context.contentLeft, context.y + 6, context.contentRight, context.y + 6);
    context.y += 9;
  }

  function drawDocumentIntro(doc, context) {
    const q = context.model.query || {};
    const lines = [`Generado: ${fmtDateCL(context.model.identity?.generatedAt || new Date())}`];
    if (Number.isFinite(Number(q.lat)) && Number.isFinite(Number(q.lon))) lines.push(`Coordenadas: ${fmtNumber(q.lat)} / ${fmtNumber(q.lon)}`);
    if (present(q.region) || present(q.commune)) lines.push(`Ubicación administrativa: ${present(q.region) || "N/D"}${present(q.commune) ? ` · ${present(q.commune)}` : ""}`);
    doc.setFont("helvetica", "bold"); doc.setFontSize(15); doc.setTextColor(...COLORS.ink);
    doc.text("GeoNEMO | Reporte del punto consultado", context.contentLeft, context.y + 2);
    doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); setColor(doc, "muted");
    lines.forEach((line, i) => doc.text(line, context.contentLeft, context.y + 8 + i * 4));
    context.y += 10 + lines.length * 4;
  }

  function drawKpiGrid(doc, section, context) {
    const items = cleanItems(section.data?.items || section.data || []);
    const columns = section.data?.columns || 4;
    drawSectionTitle(doc, section.title, context);
    const gap = 2.2, cellW = (context.contentWidth - gap * (columns - 1)) / columns;
    doc.setFontSize(7.2); doc.setFont("helvetica", "bold");
    let rowH = 16;
    items.slice(0, columns).forEach(item => { rowH = Math.max(rowH, 8 + splitPdfText(doc, present(item.value) || "N/D", cellW - 6).length * 3.4); });
    ensurePdfSpace(doc, context, rowH);
    items.slice(0, columns).forEach((item, i) => {
      const x = context.contentLeft + i * (cellW + gap);
      drawRoundedPanel(doc, x, context.y, cellW, rowH, COLORS.accentSoft);
      doc.setFont("helvetica", "bold"); doc.setFontSize(6.8); setColor(doc, "muted"); doc.text(String(item.label || ""), x + 3, context.y + 5);
      doc.setFont("helvetica", "bold"); doc.setFontSize(8.5); setColor(doc, "ink"); doc.text(splitPdfText(doc, present(item.value) || "N/D", cellW - 6), x + 3, context.y + 10);
    });
    context.y += rowH + context.sectionGap;
  }

  function drawLabelValueGrid(doc, section, context) {
    const data = cleanItems(section.data?.items || section.data || []);
    drawSectionTitle(doc, section.title, context);
    if (!data.length) return drawNoticePanel(doc, { data: { text: "Sin información disponible para esta sección." } }, context);
    const cols = section.data?.columns || 2, gap = 3, cellW = (context.contentWidth - gap * (cols - 1)) / cols;
    for (let i = 0; i < data.length; i += cols) {
      const row = data.slice(i, i + cols);
      let h = 12;
      row.forEach(item => { doc.setFontSize(8); h = Math.max(h, 8 + splitPdfText(doc, present(item.value) || "N/D", cellW - 7).length * 3.8); });
      ensurePdfSpace(doc, context, h);
      row.forEach((item, idx) => { const x = context.contentLeft + idx * (cellW + gap); drawRoundedPanel(doc, x, context.y, cellW, h, [255,255,255]); doc.setFont("helvetica", "bold"); doc.setFontSize(7); setColor(doc, "muted"); doc.text(String(item.label || ""), x + 3, context.y + 5); doc.setFont("helvetica", "normal"); doc.setFontSize(8); setColor(doc, "ink"); doc.text(splitPdfText(doc, present(item.value) || "N/D", cellW - 7), x + 3, context.y + 9); });
      context.y += h + context.panelGap;
    }
    context.y += context.sectionGap - context.panelGap;
  }

  function drawTextPanel(doc, section, context) {
    drawSectionTitle(doc, section.title, context);
    const text = section.data?.text ?? section.data ?? "";
    const lines = splitPdfText(doc, text, context.contentWidth - 8);
    const h = Math.max(14, lines.length * LINE + 8);
    ensurePdfSpace(doc, context, h);
    drawRoundedPanel(doc, context.contentLeft, context.y, context.contentWidth, h, [255,255,255]);
    doc.setFont("helvetica", "normal"); doc.setFontSize(8.6); setColor(doc, "ink"); doc.text(lines, context.contentLeft + 4, context.y + 6);
    context.y += h + context.sectionGap;
  }
  function drawNoticePanel(doc, section, context) { drawTextPanel(doc, { title: section.title, data: { text: section.data?.text || section.data || "Sin información disponible." } }, context); }
  function drawMetricGrid(doc, section, context) { drawLabelValueGrid(doc, { title: section.title, data: { items: (section.data?.groups || []).flatMap(g => [{ label: g.title, value: "" }, ...(g.items || [])]).filter(i => i.value !== "") } }, context); }

  function drawCardGrid(doc, section, context) {
    const cards = section.data?.items || section.data || [];
    drawSectionTitle(doc, section.title, context);
    const cols = section.data?.columns || 2, gap = 3, w = (context.contentWidth - gap) / cols;
    for (let i = 0; i < cards.length; i += cols) {
      const row = cards.slice(i, i + cols);
      let h = 24;
      row.forEach(card => { const lineCount = (card.fields || []).reduce((sum, f) => sum + splitPdfText(doc, `${f.label}: ${present(f.value) || "N/D"}`, w - 8).length, 0); h = Math.max(h, 12 + lineCount * 3.4); });
      ensurePdfSpace(doc, context, h);
      row.forEach((card, idx) => { const x = context.contentLeft + idx * (w + gap); drawRoundedPanel(doc, x, context.y, w, h, [255,255,255]); doc.setFont("helvetica", "bold"); doc.setFontSize(8.2); setColor(doc, "accent"); doc.text(splitPdfText(doc, card.title || "Registro", w - 8), x + 4, context.y + 5); doc.setFont("helvetica", "normal"); doc.setFontSize(7.2); setColor(doc, "ink"); let yy = context.y + 10; (card.fields || []).forEach(f => { const lines = splitPdfText(doc, `${f.label}: ${present(f.value) || "N/D"}`, w - 8); doc.text(lines, x + 4, yy); yy += lines.length * 3.4; }); });
      context.y += h + context.panelGap;
    }
    context.y += context.sectionGap - context.panelGap;
  }

  async function drawPointAndMapBlock(doc, section, context) {
    drawSectionTitle(doc, section.title || "Punto consultado y mapa de ubicación", context);
    const gap = 5, pointWidth = (context.contentWidth - gap) * (1.1 / 2.1), mapWidth = context.contentWidth - gap - pointWidth, h = 58;
    ensurePdfSpace(doc, context, h);
    const y = context.y;
    drawRoundedPanel(doc, context.contentLeft, y, pointWidth, h, [255,255,255]);
    drawRoundedPanel(doc, context.contentLeft + pointWidth + gap, y, mapWidth, h, [255,255,255]);
    const items = cleanItems(section.data?.pointItems || []);
    doc.setFont("helvetica", "bold"); doc.setFontSize(9); setColor(doc, "accent"); doc.text("Punto consultado", context.contentLeft + 4, y + 6);
    doc.setFont("helvetica", "normal"); doc.setFontSize(7.4); setColor(doc, "ink"); let yy = y + 12;
    items.forEach(item => { const lines = splitPdfText(doc, `${item.label}: ${present(item.value) || "N/D"}`, pointWidth - 8); doc.text(lines, context.contentLeft + 4, yy); yy += lines.length * 3.8; });
    let mapPng = section.data?.mapPng;
    if (!mapPng && context.mapElement) { try { mapPng = await captureGeoNemoMapPng({ map: context.map, mapElement: context.mapElement }); } catch (error) { console.warn("[GeoNEMO PDF] No fue posible capturar el mapa", error); } }
    const mx = context.contentLeft + pointWidth + gap + 3, my = y + 8, mw = mapWidth - 6, mh = h - 12;
    doc.setFont("helvetica", "bold"); doc.setFontSize(9); setColor(doc, "accent"); doc.text("Mapa de ubicación", context.contentLeft + pointWidth + gap + 4, y + 6);
    if (mapPng) {
      const props = doc.getImageProperties(mapPng);
      const ratio = props.width && props.height ? props.width / props.height : mw / mh;
      let drawW = mw;
      let drawH = drawW / ratio;
      if (drawH > mh) { drawH = mh; drawW = drawH * ratio; }
      const drawX = mx + (mw - drawW) / 2;
      const drawY = my + (mh - drawH) / 2;
      doc.addImage(mapPng, "PNG", drawX, drawY, drawW, drawH, undefined, "FAST");
    }
    else { doc.setFont("helvetica", "normal"); doc.setFontSize(7.8); setColor(doc, "warning"); doc.text(splitPdfText(doc, `No fue posible incorporar la imagen del mapa durante esta exportación. Coordenadas: ${fmtNumber(context.model.query?.lat)} / ${fmtNumber(context.model.query?.lon)}. Mapa base: ${present(context.model.query?.basemap) || "N/D"}.`, mw - 4), mx + 2, my + 7); }
    context.y += h + context.sectionGap;
  }

  function drawMetadataTable(doc, section, context) {
    drawSectionTitle(doc, section.title, context);
    if (typeof doc.autoTable !== "function") { console.warn("[GeoNEMO PDF] AutoTable no disponible"); return drawLabelValueGrid(doc, { data: { items: (section.data?.rows || []).flatMap(row => row.map((v, i) => ({ label: section.data?.head?.[i] || `Campo ${i+1}`, value: v }))) } }, context); }
    ensurePdfSpace(doc, context, 18);
    doc.autoTable({ head: [section.data?.head || []], body: section.data?.rows || [], startY: context.y, margin: { left: context.contentLeft, right: context.pageWidth - context.contentRight }, styles: { fontSize: 7.3, cellPadding: 1.6, overflow: "linebreak" }, headStyles: { fillColor: COLORS.accent, textColor: [255,255,255], fontStyle: "bold" }, showHead: "everyPage" });
    context.y = (doc.lastAutoTable?.finalY || context.y) + context.sectionGap;
  }

  async function captureGeoNemoMapPng({ map, mapElement }) {
    if (typeof window.domtoimage?.toPng !== "function") throw new Error("dom-to-image no disponible");
    if (!map || !mapElement) throw new Error("Mapa Leaflet no disponible");
    const center = typeof map.getCenter === "function" ? map.getCenter() : null;
    const zoom = typeof map.getZoom === "function" ? map.getZoom() : null;
    const hidden = [...mapElement.querySelectorAll(".leaflet-control-container, .leaflet-control, .map-toggle, .map-touch-hint, [role='tooltip'], .leaflet-tooltip")].map(el => [el, el.style.visibility]);
    try {
      hidden.forEach(([el]) => { el.style.visibility = "hidden"; });
      map.invalidateSize({ pan: false, animate: false });
      await nextFrames(2); await waitForGeoNemoMapTiles(mapElement); await new Promise(r => setTimeout(r, 220));
      const rect = mapElement.getBoundingClientRect(); const width = Math.round(rect.width); const height = Math.round(rect.height);
      if (width <= 0 || height <= 0) throw new Error("Contenedor de mapa sin dimensiones");
      return await window.domtoimage.toPng(mapElement, { width, height, style: { transform: "scale(1)", transformOrigin: "top left" } });
    } finally {
      hidden.forEach(([el, visibility]) => { el.style.visibility = visibility; });
      if (center && Number.isFinite(zoom) && typeof map.setView === "function") map.setView(center, zoom, { animate: false });
      map.invalidateSize({ pan: false, animate: false });
    }
  }
  function nextFrames(count) { return new Promise(resolve => { const step = n => n <= 0 ? resolve() : requestAnimationFrame(() => step(n - 1)); step(count); }); }
  async function waitForGeoNemoMapTiles(mapElement, timeout = 6000) {
    const pending = [...mapElement.querySelectorAll(".leaflet-tile")].filter(image => !image.complete);
    if (!pending.length) return;
    await Promise.race([Promise.allSettled(pending.map(image => new Promise(resolve => { image.addEventListener("load", resolve, { once: true }); image.addEventListener("error", resolve, { once: true }); }))), new Promise(resolve => setTimeout(resolve, timeout))]);
  }

  async function captureGeoNemoCharts() {
    const charts = [];
    const nodes = [...document.querySelectorAll('[data-pdf-chart="true"]')];
    for (const node of nodes) {
      try {
        let dataUrl = "";
        if (window.Plotly?.toImage && node.classList.contains("js-plotly-plot")) dataUrl = await window.Plotly.toImage(node, { format: "png", width: node.clientWidth || 800, height: node.clientHeight || 420 });
        else if (node.__chartjs?.toBase64Image) dataUrl = node.__chartjs.toBase64Image();
        else if (node instanceof HTMLCanvasElement) dataUrl = node.toDataURL("image/png");
        if (dataUrl) charts.push({ title: node.dataset.pdfTitle || node.getAttribute("aria-label") || "Gráfico", dataUrl });
      } catch (error) { console.warn("[GeoNEMO PDF] No fue posible exportar un gráfico", error); }
    }
    return charts;
  }
  function drawImageGrid(doc, section, context) {
    const images = section.data?.images || [];
    if (!images.length) return;
    drawSectionTitle(doc, section.title, context);
    images.forEach(image => { const h = Math.min(70, context.contentWidth * 0.52); ensurePdfSpace(doc, context, h + 8); doc.setFont("helvetica", "bold"); doc.setFontSize(8.4); setColor(doc, "ink"); doc.text(image.title || "Gráfico", context.contentLeft, context.y + 4); doc.addImage(image.dataUrl, "PNG", context.contentLeft, context.y + 7, context.contentWidth, h, undefined, "FAST"); context.y += h + 10; });
  }

  function addGeoNemoPdfHeader(doc, context, pageNumber, totalPages) { doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.setTextColor(...COLORS.accent); doc.text("GeoNEMO | Reporte del punto consultado", PDF_LAYOUT.marginLeft, PDF_LAYOUT.marginTop); doc.setDrawColor(...COLORS.line); doc.line(PDF_LAYOUT.marginLeft, PDF_LAYOUT.marginTop + 3, context.pageWidth - PDF_LAYOUT.marginRight, PDF_LAYOUT.marginTop + 3); }
  function addGeoNemoPdfFooter(doc, context, pageNumber, totalPages) { doc.setFont("helvetica", "normal"); doc.setFontSize(7.5); setColor(doc, "muted"); doc.text(`Fecha de generación: ${fmtDateCL(context.model.identity?.generatedAt || new Date())}`, PDF_LAYOUT.marginLeft, context.pageHeight - PDF_LAYOUT.marginBottom + 2); doc.text(`Página ${pageNumber} de ${totalPages}`, context.pageWidth - PDF_LAYOUT.marginRight - 25, context.pageHeight - PDF_LAYOUT.marginBottom + 2); }
  function addPdfHeaderFooterToAllPages(doc, context) { const total = doc.getNumberOfPages(); for (let p = 1; p <= total; p += 1) { doc.setPage(p); addGeoNemoPdfHeader(doc, context, p, total); addGeoNemoPdfFooter(doc, context, p, total); } }

  const PDF_SECTION_RENDERERS = { "kpi-grid": drawKpiGrid, "point-map": drawPointAndMapBlock, "text-panel": drawTextPanel, "metric-grid": drawMetricGrid, "card-list": drawCardGrid, "table": drawMetadataTable, "metadata": drawLabelValueGrid, "notice": drawNoticePanel, "image-grid": drawImageGrid };
  async function renderGeoNemoPdfSection(doc, section, context) { const renderer = PDF_SECTION_RENDERERS[section.type]; if (!renderer) return console.warn("[GeoNEMO PDF] Renderizador no disponible", section.type); await renderer(doc, section, context); }
  async function exportGeoNemoPDFDirect({ reportModel, map, mapElement, filename } = {}) {
    let currentPdfStep = "initialization";
    try {
      currentPdfStep = "dependencies"; assertGeoNemoPDFDependencies();
      currentPdfStep = "building_model"; const state = window.geoQueryState || {}; const qp = state.queryContext?.queryPoint || {}; const model = reportModel || window.__geonemoReportModel || { identity: { site: "geonemo", title: "GeoNEMO | Reporte del punto consultado", generatedAt: new Date().toISOString() }, query: { lat: qp.lat ?? state.lat ?? state.lat_decimal, lon: qp.lon ?? state.lon ?? state.lon_decimal, basemap: state.basemap || state.mapState?.basemap }, state }; window.__geonemoReportModel = model;
      currentPdfStep = "document"; const doc = createGeoNemoPdfDocument(); const context = createContext(doc, model, map || window.geoQueryLeafletMap, mapElement || document.getElementById("geoquery-map"));
      currentPdfStep = "capturing_charts"; context.capturedCharts = await captureGeoNemoCharts();
      currentPdfStep = "drawing_sections"; drawDocumentIntro(doc, context); const sections = collectGeoNemoPdfSections(model, context); for (const section of sections) await renderGeoNemoPdfSection(doc, section, context);
      currentPdfStep = "adding_footer"; addPdfHeaderFooterToAllPages(doc, context);
      currentPdfStep = "saving"; const safeFilename = buildFilename(model, filename); doc.save(safeFilename); console.info("[GeoNEMO PDF] Descarga solicitada:", safeFilename, { pages: doc.getNumberOfPages() }); return { filename: safeFilename, pages: doc.getNumberOfPages() };
    } catch (error) { console.error("[GeoNEMO PDF]", { step: currentPdfStep, message: error?.message, stack: error?.stack, error }); throw error; }
  }


  const GEONEMO_HTML_PDF_COVERAGE = [
    { htmlId: "geoquery-summary-cards", groupId: "general", pdfSectionId: "query-summary" },
    { htmlId: "geoquery-point-panel", groupId: "general", pdfSectionId: "point-map" },
    { htmlId: "geoquery-map-panel", groupId: "general", pdfSectionId: "point-map" },
    { htmlId: "geoquery-executive-summary", groupId: "general", pdfSectionId: "executive-summary" },
    { htmlId: "group-snaspe", groupId: "snaspe", pdfSectionId: "snaspe-result" },
    { htmlId: "group-snaspe", groupId: "snaspe", pdfSectionId: "snaspe-descriptors" },
    { htmlId: "group-snaspe", groupId: "snaspe", pdfSectionId: "snaspe-indicators" },
    { htmlId: "group-snaspe", groupId: "snaspe", pdfSectionId: "snaspe-metadata" },
    { htmlId: "group-ramsar", groupId: "ramsar", pdfSectionId: "ramsar-result" },
    { htmlId: "group-ramsar", groupId: "ramsar", pdfSectionId: "ramsar-descriptors" },
    { htmlId: "group-ramsar", groupId: "ramsar", pdfSectionId: "ramsar-indicators" },
    { htmlId: "group-ramsar", groupId: "ramsar", pdfSectionId: "ramsar-metadata" },
    { htmlId: "geoquery-technical-metadata", groupId: "general", pdfSectionId: "technical-metadata" }
  ];

  function nonEmptyItems(items) { return deduplicateLabelValueRows(items).filter((i) => present(i.label) && present(i.value)); }
  function buildGroupHeaderSection(group) { return { id: `${group.id}-header`, type: "notice", title: `Grupo ${group.title}`, order: 100, data: { text: normalizeGeoNemoRelationLabel(group.relation?.type) } }; }
  function buildGroupResultSection(group) {
    if (!group.hasResult) return { id: `${group.id}-result`, type: "notice", title: `Resultado territorial — ${group.title}`, order: 110, data: { text: group.emptyMessage || `Sin resultado para ${group.title}.` } };
    return { id: `${group.id}-result`, type: "metadata", title: `Resultado territorial — ${group.title}`, order: 110, data: { columns: 2, items: nonEmptyItems([{ label: "Grupo", value: group.title }, { label: "Feature relacionada", value: group.feature?.name }, { label: "Categoría", value: group.feature?.category }, { label: "Tipo de relación", value: group.relation?.label }, { label: "Distancia", value: group.relation?.distanceFormatted }, { label: "Punto dentro", value: group.relation?.pointInside ? "Sí" : "No" }, { label: "Región", value: group.feature?.region }, { label: "Comuna", value: group.feature?.commune }, { label: "Superficie", value: group.feature?.surfaceFormatted }, { label: "Territorio", value: group.feature?.territory }, { label: "Fuente", value: group.source?.displayName }]) } };
  }
  function buildGroupRelationSection(group) { return { id: `${group.id}-relation`, type: "metadata", title: `Relación espacial — ${group.title}`, order: 120, data: { columns: 2, items: nonEmptyItems([{ label: "Tipo de relación", value: group.relation?.label }, { label: "Distancia mínima", value: group.relation?.distanceFormatted || fmtMeters(group.relation?.distanceMeters) }, { label: "Punto dentro", value: group.relation?.pointInside ? "Sí" : "No" }, { label: group.relation?.type === "nearest" ? "Feature más cercana" : "Feature relacionada", value: group.feature?.name }]) } }; }
  function buildGroupGeometrySection(group) {
    if (!group.hasResult) return null;
    const gd = group.geometryDescriptors || {};
    return { id: `${group.id}-descriptors`, type: "metadata", title: `Descriptores geométricos — ${group.title}`, order: 130, data: { columns: 2, items: nonEmptyItems([{ label: "Superficie", value: group.feature?.surfaceFormatted }, { label: "Superficie calculada", value: Number.isFinite(Number(gd.areaHa)) ? `${Number(gd.areaHa).toLocaleString("es-CL", { maximumFractionDigits: 2 })} ha` : "" }, { label: "Perímetro", value: gd.perimeterFormatted }, { label: "Tipo de geometría", value: gd.geometryType }, { label: "Número de partes", value: gd.partsCount }, { label: "Distancia al punto", value: gd.distanceToPointFormatted }]) } };
  }
  function buildGroupSpatialIndicatorsSection(group) { const si = group.spatialIndicators || {}; return { id: `${group.id}-indicators`, type: "metadata", title: `Indicadores de relación espacial — ${group.title}`, order: 140, data: { columns: 2, items: nonEmptyItems([{ label: "Tipo de relación", value: si.relationLabel || group.relation?.label }, { label: "Punto dentro", value: si.pointInside ? "Sí" : "No" }, { label: "Distancia mínima", value: si.minimumDistance }, { label: "Feature relacionada", value: si.nearestFeature || group.feature?.name }, { label: "Categoría", value: si.featureCategory || group.feature?.category }]) } }; }
  function buildGroupMetadataSection(group) { if (!group.hasResult || !(group.metadata || []).length) return null; return { id: `${group.id}-metadata`, type: "table", title: `Metadata — ${group.title}`, order: 150, data: { head: ["Campo", "Valor"], rows: deduplicateLabelValueRows(group.metadata).map((r) => [r.label, r.value]) } }; }
  function buildGroupSourcesSection(group) { return { id: `${group.id}-sources`, type: "metadata", title: `Fuentes — ${group.title}`, order: 160, data: { columns: 2, items: nonEmptyItems(group.sources || []) } }; }
  function buildGeoNemoGroupSections(group) { return [buildGroupHeaderSection(group), buildGroupResultSection(group), buildGroupRelationSection(group), buildGroupGeometrySection(group), buildGroupSpatialIndicatorsSection(group), buildGroupMetadataSection(group), buildGroupSourcesSection(group)].filter(Boolean); }
  function auditGeoNemoHtmlPdfCoverage(model, sections) {
    const ids = new Set(sections.map((s) => s.id));
    GEONEMO_HTML_PDF_COVERAGE.forEach((entry) => { const node = document.getElementById(entry.htmlId); const groupOk = entry.groupId === "general" || (model.groups || []).some((g) => g.id === entry.groupId); if (node && groupOk && !ids.has(entry.pdfSectionId)) console.error("[GeoNEMO PDF] Sección informativa omitida", { htmlId: entry.htmlId, groupId: entry.groupId, expectedPdfSection: entry.pdfSectionId }); });
  }

  function detailItemsFromPanel(selector) { return [...document.querySelectorAll(`${selector} .detail-row`)].map(row => ({ label: row.querySelector("dt")?.textContent, value: row.querySelector("dd")?.textContent })); }

  function collectGeoNemoPdfSections(model, context) {
    if ((!model || !Array.isArray(model.groups)) && typeof window.buildGeoNemoReportModelFromResolvedState === "function") model = window.buildGeoNemoReportModelFromResolvedState();
    context.model = model;
    const q = model.query || {};
    const pointItems = nonEmptyItems([
      { label: "Latitud decimal", value: fmtNumber(q.lat) }, { label: "Longitud decimal", value: fmtNumber(q.lon) }, { label: "Latitud GMS", value: q.latDms }, { label: "Longitud GMS", value: q.lonDms }, { label: "CRS", value: q.crs }, { label: "Región", value: q.region }, { label: "Comuna", value: q.commune }, { label: "Fuente", value: q.source }, { label: "Estado", value: "Análisis territorial resuelto por grupos." }
    ]);
    const sections = [
      { id: "query-summary", type: "kpi-grid", title: "Resumen de consulta", order: 10, data: { columns: 4, items: [{ label: "Latitud", value: fmtNumber(q.lat) || "N/D" }, { label: "Longitud", value: fmtNumber(q.lon) || "N/D" }, { label: "Grupos analizados", value: `${model.summary?.totalGroups ?? (model.groups || []).length}` }, { label: "Estado", value: q.state === "resolved" ? "Resuelto" : (q.state || "Resuelto") }] } },
      { id: "point-map", type: "point-map", title: "Punto consultado y mapa de ubicación", order: 20, data: { pointItems } },
      { id: "executive-summary", type: "text-panel", title: "Resumen ejecutivo", order: 30, data: { text: model.summary?.executiveText || "Sin resumen ejecutivo disponible." } }
    ];
    (model.groups || []).forEach((group, index) => { buildGeoNemoGroupSections(group).forEach((section) => sections.push({ ...section, order: 100 + index * 100 + (section.order || 0) / 10 })); });
    sections.push(
      { id: "technical-metadata", type: "table", title: "Metadata técnica general", order: 900, data: { head: ["Campo", "Valor"], rows: deduplicateLabelValueRows(model.technicalMetadata || []).map((i) => [i.label, i.value]) } },
      { id: "methodology", type: "table", title: "Metodología", order: 940, data: { head: ["Criterio"], rows: (model.methodology || []).filter(present).map((item) => [item]) } },
      { id: "sources", type: "table", title: "Fuentes generales", order: 990, data: { head: ["Fuente", "Detalle"], rows: deduplicateLabelValueRows(model.sources || []).map((i) => [i.label, i.value]) } },
      { id: "disclaimer", type: "notice", title: "Descargo", order: 1000, data: { text: model.disclaimer || "Reporte referencial generado automáticamente desde GeoQuery." } }
    );
    auditGeoNemoHtmlPdfCoverage(model, sections);
    return sections.filter((section) => section && (section.type === "notice" || section.type === "point-map" || section.type === "kpi-grid" || (section.data && Object.keys(section.data).length))).sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
  }

  function collectGeoNemoDomPdfSections(excludedIds = new Set()) {
    return [...document.querySelectorAll("[data-pdf-section]")]
      .map((node, index) => {
        const id = present(node.dataset.pdfSection) || `dom-section-${index + 1}`;
        if (excludedIds.has(id) || node.hidden || node.matches('[data-pdf-export="false"], .pdf-no-export') || /descargas|download|exportar pdf|descargar pdf|descargar kml/i.test(node.textContent || "")) return null;
        const type = present(node.dataset.pdfType) || "text-panel";
        const order = Number(node.dataset.pdfOrder || 9000 + index);
        const title = present(node.dataset.pdfTitle) || present(node.querySelector("h1,h2,h3,h4")?.textContent) || null;
        const text = present(node.dataset.pdfText) || present(node.textContent);
        return text ? { id, type, title, order, data: { text } } : null;
      })
      .filter(Boolean);
  }


  let isGeneratingGeoNemoPDF = false;
  function getGeoNemoPdfButtons() { return [...document.querySelectorAll("button.download-button, [data-pdf-button='true']")].filter(button => /PDF/i.test(button.textContent || button.title || "")); }
  function setGeoNemoPdfButtonsReady() { const ready = Boolean(window.geoQueryState?.exportState?.pdfEnabled || window.geoQueryState?.status === "resolved"); getGeoNemoPdfButtons().forEach(button => { button.disabled = !ready || isGeneratingGeoNemoPDF; button.title = ready ? "Descargar PDF" : "Disponible cuando exista análisis territorial."; button.dataset.pdfButton = "true"; }); }
  function bindGeoNemoPdfButtonOnce() { getGeoNemoPdfButtons().forEach(button => { if (button.dataset.pdfBound === "1") return; button.dataset.pdfBound = "1"; button.addEventListener("click", async event => { event.preventDefault(); if (isGeneratingGeoNemoPDF) return; isGeneratingGeoNemoPDF = true; const buttons = getGeoNemoPdfButtons(); const original = new Map(buttons.map(b => [b, b.textContent])); buttons.forEach(b => { b.disabled = true; b.textContent = "Generando PDF…"; }); try { await exportGeoNemoPDFDirect(); } finally { isGeneratingGeoNemoPDF = false; buttons.forEach(b => b.textContent = original.get(b) || "Exportar PDF"); setGeoNemoPdfButtonsReady(); } }); }); setGeoNemoPdfButtonsReady(); }
  document.addEventListener("DOMContentLoaded", bindGeoNemoPdfButtonOnce); const geoNemoPdfReadyTimer = window.setInterval(() => { bindGeoNemoPdfButtonOnce(); if (window.geoQueryState?.exportState?.pdfEnabled) window.clearInterval(geoNemoPdfReadyTimer); }, 500);
  window.GeoNemoPdfExport = { exportGeoNemoPDFDirect, bindGeoNemoPdfButtonOnce, assertGeoNemoPDFDependencies, createGeoNemoPdfDocument, collectGeoNemoPdfSections, captureGeoNemoMapPng, captureGeoNemoCharts, waitForGeoNemoMapTiles, collectGeoNemoDomPdfSections, sanitizePdfFilenamePart, normalizePdfUrl, PDF_LAYOUT, buildGeoNemoGroupSections, normalizeGeoNemoRelationLabel, GEONEMO_HTML_PDF_COVERAGE };
})();
