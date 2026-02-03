#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
GeoNEMO debug.py
================
Audita grupos y GeoJSON para rendimiento:

- Lee capas/grupos.json
- Resuelve rutas relativas
- Valida existencia de archivos
- Resume: #features por archivo, bbox, y un estimado de vértices por feature
- Detecta "monstruos" (muchos vértices) para simplificación o bbox-only

Uso:
  python debug.py
  python debug.py --groups capas/grupos.json --top 30 --threshold 200000

Requiere:
  pip install shapely
"""

from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
from typing import Any, Dict, List, Tuple, Optional

try:
    from shapely.geometry import shape
except Exception as e:
    shape = None


def eprint(*a):
    print(*a, flush=True)


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def resolve_file(groups_path: Path, file_path: str) -> Path:
    # Respeta URLs http(s) y rutas absolutas (pero GeoNEMO debiera ser local)
    if file_path.startswith("http://") or file_path.startswith("https://"):
        return Path(file_path)  # marker: es URL
    p = Path(file_path)
    if p.is_absolute():
        return p
    # relativo al JSON de grupos, igual que en tu JS
    return (groups_path.parent / p).resolve()


def geom_vertex_estimate(coords: Any) -> int:
    """
    Estimación simple de #vertices a partir de coords GeoJSON.
    Para Polygon: coords = [ring1, ring2...]
    Para MultiPolygon: coords = [[ring1..],[ring1..]...]
    """
    if coords is None:
        return 0
    if not isinstance(coords, list):
        return 0

    # Polygon: list of rings
    if coords and isinstance(coords[0], list) and coords and coords[0] and isinstance(coords[0][0], (int, float)) is False:
        # coords[0] es ring: [[x,y], [x,y], ...]
        pass

    # Detectar Polygon vs MultiPolygon por anidación
    # Polygon: coords[0][0] ~ [x,y]
    # MultiPolygon: coords[0][0][0] ~ [x,y]
    try:
        if coords and coords[0] and coords[0][0] and isinstance(coords[0][0][0], (int, float)):
            # Polygon
            n = 0
            for ring in coords:
                if isinstance(ring, list):
                    n += len(ring)
            return n
        # MultiPolygon
        n = 0
        for poly in coords:
            if not isinstance(poly, list):
                continue
            for ring in poly:
                if isinstance(ring, list):
                    n += len(ring)
        return n
    except Exception:
        return 0


def bbox_from_geom(geom: Dict[str, Any]) -> Optional[Tuple[float, float, float, float]]:
    # Sin shapely: bbox por coordenadas (rápido y suficiente para debug)
    coords = geom.get("coordinates")
    if coords is None:
        return None

    xs: List[float] = []
    ys: List[float] = []

    def walk(x):
        if isinstance(x, (int, float)):
            return
        if isinstance(x, list):
            if len(x) == 2 and all(isinstance(v, (int, float)) for v in x):
                xs.append(float(x[0]))
                ys.append(float(x[1]))
            else:
                for it in x:
                    walk(it)

    walk(coords)
    if not xs or not ys:
        return None
    return (min(xs), min(ys), max(xs), max(ys))


def km_span_from_bbox(bb: Tuple[float, float, float, float]) -> Tuple[float, float]:
    """
    Estimación grosera de ancho/alto en km desde bbox lon/lat.
    Sirve para detectar polígonos enormes.
    """
    minx, miny, maxx, maxy = bb
    # lat promedio
    lat = (miny + maxy) / 2.0
    # 1 deg lat ~ 111.32 km
    dy_km = abs(maxy - miny) * 111.32
    # 1 deg lon ~ 111.32*cos(lat)
    dx_km = abs(maxx - minx) * 111.32 * math.cos(math.radians(lat))
    return (dx_km, dy_km)


def human_path(p: Path) -> str:
    s = str(p)
    return s


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--groups", default="capas/grupos.json", help="Ruta a grupos.json")
    ap.add_argument("--top", type=int, default=20, help="Top N features más pesadas por vértices")
    ap.add_argument("--threshold", type=int, default=200_000, help="Umbral de vértices para alertas")
    ap.add_argument("--max-files", type=int, default=0, help="Limitar #archivos (0 = sin límite)")
    args = ap.parse_args()

    groups_path = Path(args.groups).resolve()
    if not groups_path.exists():
        raise SystemExit(f"❌ No existe: {groups_path}")

    data = load_json(groups_path)
    groups = data.get("groups", [])
    if not isinstance(groups, list) or not groups:
        raise SystemExit("❌ grupos.json no tiene 'groups' o está vacío.")

    eprint("==============================================")
    eprint("🔎 GeoNEMO DEBUG")
    eprint("==============================================")
    eprint(f"Groups file : {groups_path}")
    eprint(f"Groups      : {len(groups)}")
    eprint(f"Top N       : {args.top}")
    eprint(f"Threshold   : {args.threshold:,} vertices")
    eprint(f"Shapely     : {'OK' if shape else 'NO (solo estimaciones)'}")
    eprint("----------------------------------------------")

    # Recolectar
    missing_files: List[str] = []
    url_files: List[str] = []

    per_group_summary: List[Dict[str, Any]] = []
    heavy_features: List[Dict[str, Any]] = []  # top global

    total_files = 0
    total_features = 0

    for g in groups:
        gid = str(g.get("id") or g.get("group_id") or "").strip()
        gname = str(g.get("label") or g.get("group") or g.get("name") or gid).strip()
        enabled = (g.get("enabled", True) is not False)
        files = g.get("files", []) or []
        if not isinstance(files, list):
            files = []

        g_file_count = 0
        g_feat_count = 0
        g_max_vertices = 0

        for f in files:
            if args.max_files and total_files >= args.max_files:
                break

            f = str(f)
            resolved = resolve_file(groups_path, f)

            # URL -> no auditable localmente
            if str(resolved).startswith("http://") or str(resolved).startswith("https://"):
                url_files.append(f)
                continue

            total_files += 1
            g_file_count += 1

            if not resolved.exists():
                missing_files.append(f"{gname} :: {f} -> {resolved}")
                continue

            try:
                gj = load_json(resolved)
            except Exception as e:
                missing_files.append(f"{gname} :: {f} (JSON inválido) -> {resolved} :: {e}")
                continue

            feats = gj.get("features", []) or []
            if not isinstance(feats, list):
                feats = []

            g_feat_count += len(feats)
            total_features += len(feats)

            # Recorrer features para estimar vértices y bbox
            for i, feat in enumerate(feats):
                geom = (feat or {}).get("geometry") or {}
                gtype = geom.get("type")

                if gtype not in ("Polygon", "MultiPolygon"):
                    continue

                coords = geom.get("coordinates")
                v_est = geom_vertex_estimate(coords)
                g_max_vertices = max(g_max_vertices, v_est)

                bb = bbox_from_geom(geom)
                dx_km, dy_km = (0.0, 0.0)
                if bb:
                    dx_km, dy_km = km_span_from_bbox(bb)

                # Guardar para ranking global
                heavy_features.append({
                    "group": gname,
                    "file": resolved.name,
                    "feature_index": i,
                    "geom_type": gtype,
                    "v_est": v_est,
                    "bbox": bb,
                    "span_km": (dx_km, dy_km),
                })

        per_group_summary.append({
            "group": gname,
            "id": gid,
            "enabled": enabled,
            "files": g_file_count,
            "features": g_feat_count,
            "max_vertices_est": g_max_vertices,
        })

    # Ordenar resumen por features desc
    per_group_summary.sort(key=lambda r: (r["features"], r["files"]), reverse=True)

    # Top heavy features
    heavy_features.sort(key=lambda r: r["v_est"], reverse=True)
    topN = heavy_features[: max(args.top, 1)]

    # Alertas por umbral
    alerts = [x for x in heavy_features if x["v_est"] >= args.threshold]

    eprint("✅ RESUMEN POR GRUPO")
    for r in per_group_summary:
        eprint(
            f"- {r['group']} | enabled={r['enabled']} | files={r['files']} | "
            f"features={r['features']} | max_v≈{r['max_vertices_est']:,}"
        )

    eprint("----------------------------------------------")
    eprint(f"📦 Total archivos (local) : {total_files}")
    eprint(f"🧩 Total features         : {total_features}")
    if url_files:
        eprint(f"🌐 Archivos URL (omitidos): {len(url_files)}")

    if missing_files:
        eprint("----------------------------------------------")
        eprint("❌ ARCHIVOS PROBLEMÁTICOS / NO ENCONTRADOS")
        for s in missing_files[:50]:
            eprint("  -", s)
        if len(missing_files) > 50:
            eprint(f"  ... ({len(missing_files)-50} más)")

    eprint("----------------------------------------------")
    eprint(f"🏋️ TOP {len(topN)} FEATURES MÁS PESADAS (por vértices estimados)")
    for x in topN:
        bb = x["bbox"]
        span = x["span_km"]
        bb_txt = "—" if not bb else f"[{bb[0]:.3f},{bb[1]:.3f},{bb[2]:.3f},{bb[3]:.3f}]"
        eprint(
            f"- v≈{x['v_est']:,} | {x['group']} | {x['file']}#{x['feature_index']} | "
            f"{x['geom_type']} | bbox={bb_txt} | span≈{span[0]:.0f}x{span[1]:.0f} km"
        )

    if alerts:
        eprint("----------------------------------------------")
        eprint(f"🚨 ALERTAS (vértices ≥ {args.threshold:,}) -> {len(alerts)} features")
        # mostrar hasta 30
        for x in alerts[:30]:
            eprint(
                f"  - v≈{x['v_est']:,} | {x['group']} | {x['file']}#{x['feature_index']} | {x['geom_type']}"
            )
        if len(alerts) > 30:
            eprint(f"  ... ({len(alerts)-30} más)")

    eprint("----------------------------------------------")
    eprint("SUGERENCIAS RÁPIDAS:")
    eprint("1) Si ves features con v≈200.000+ -> preprocesar:")
    eprint("   - simplificar (QGIS: Simplify) + mantener original para 'detalle'")
    eprint("   - o usar modo 'bbox-only' si distance > 300 km (tu idea).")
    eprint("2) Para el motor web: usar índice bbox por feature y evitar cargar geometría completa lejos.")
    eprint("==============================================")
    eprint("✅ FIN")


if __name__ == "__main__":
    main()
