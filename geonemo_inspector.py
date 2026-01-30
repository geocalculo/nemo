#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
GeoNEMO - Inspector Debug (grupos -> GeoJSON)
============================================

Valida:
- groups.json (array o {"groups":[...]})
- enabled/pick/files
- existencia de rutas (FS) o accesibilidad (HTTP)
- carga GeoJSON real, conteo features, bbox, tipos geom

Ejemplos:
  # 1) Modo FS (recomendado si tienes los geojson en el repo)
  python geonemo_inspector.py --groups grupos.json --root .

  # 2) Modo HTTP (si quieres testear exactamente como el navegador)
  python geonemo_inspector.py --groups grupos.json --mode http --base-url http://127.0.0.1:5500

Salida: reporte por grupo y por archivo con errores claros.
"""

import argparse
import json
import os
import sys
import time
from urllib.parse import urljoin
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError


# -----------------------------
# Helpers: impresión
# -----------------------------
def c(text, color):
    # colores ANSI básicos
    colors = {
        "red": "\033[31m",
        "green": "\033[32m",
        "yellow": "\033[33m",
        "cyan": "\033[36m",
        "gray": "\033[90m",
        "reset": "\033[0m",
        "bold": "\033[1m",
    }
    return f"{colors.get(color,'')}{text}{colors['reset']}"


def hr():
    print(c("-" * 92, "gray"))


# -----------------------------
# GeoJSON parsing: bbox sin libs
# -----------------------------
def iter_coords(geom):
    """Devuelve un iterador de (x,y) desde geom GeoJSON (Point/Line/Polygon/Multi*)."""
    if not geom:
        return
    gtype = geom.get("type")
    coords = geom.get("coordinates")

    def walk(obj, depth=0):
        if obj is None:
            return
        # caso base: par [x,y] (o [x,y,z])
        if isinstance(obj, (list, tuple)) and len(obj) >= 2 and all(
            isinstance(obj[i], (int, float)) for i in (0, 1)
        ):
            yield (float(obj[0]), float(obj[1]))
            return
        # recursión
        if isinstance(obj, (list, tuple)):
            for it in obj:
                yield from walk(it, depth + 1)

    # GeometryCollection
    if gtype == "GeometryCollection":
        for g in geom.get("geometries", []) or []:
            yield from iter_coords(g)
    else:
        yield from walk(coords)


def feature_bbox(feat):
    geom = feat.get("geometry")
    xs, ys = [], []
    for x, y in iter_coords(geom):
        xs.append(x)
        ys.append(y)
    if not xs:
        return None
    return (min(xs), min(ys), max(xs), max(ys))


def merge_bbox(b1, b2):
    if b1 is None:
        return b2
    if b2 is None:
        return b1
    return (min(b1[0], b2[0]), min(b1[1], b2[1]), max(b1[2], b2[2]), max(b1[3], b2[3]))


# -----------------------------
# IO: leer JSON desde FS o HTTP
# -----------------------------
def read_json_fs(path):
    with open(path, "r", encoding="utf-8-sig") as f:
        return json.load(f)


def read_json_http(url, timeout=20):
    req = Request(url, headers={"User-Agent": "GeoNEMO-Inspector/1.0"})
    with urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
    # utf-8-sig por si viene con BOM
    try:
        return json.loads(raw.decode("utf-8-sig"))
    except UnicodeDecodeError:
        return json.loads(raw.decode("utf-8", errors="replace"))


def http_head_or_get(url, timeout=15):
    # HEAD suele fallar en algunos servers, hacemos GET liviano
    try:
        req = Request(url, method="GET", headers={"User-Agent": "GeoNEMO-Inspector/1.0"})
        with urlopen(req, timeout=timeout) as resp:
            status = resp.status
            ctype = (resp.headers.get("Content-Type") or "").lower()
            # leemos poco para detectar HTML vs JSON
            sample = resp.read(200).decode("utf-8", errors="ignore")
        return status, ctype, sample, None
    except HTTPError as e:
        return e.code, "", "", f"HTTPError: {e}"
    except URLError as e:
        return None, "", "", f"URLError: {e}"
    except Exception as e:
        return None, "", "", f"Error: {e}"


# -----------------------------
# Normalización grupos
# -----------------------------
def normalize_groups(data):
    if isinstance(data, list):
        return data
    if isinstance(data, dict) and isinstance(data.get("groups"), list):
        return data["groups"]
    return None


def safe_bool_enabled(g):
    # enabled por defecto True si no está
    return g.get("enabled", True) is not False


def safe_pick(g):
    p = (g.get("pick") or "").strip().lower()
    return p or "first"


# -----------------------------
# Inspector principal
# -----------------------------
def inspect(groups_path, root, mode, base_url, max_features_scan, verbose):
    t0 = time.time()

    # 1) cargar groups.json
    print(c("GeoNEMO Inspector Debug", "bold"))
    print(f"Modo: {mode} | groups: {groups_path} | root: {root} | base_url: {base_url or '-'}")
    hr()

    if mode == "http":
        groups_url = urljoin(base_url.rstrip("/") + "/", groups_path.lstrip("/"))
        try:
            data = read_json_http(groups_url)
        except Exception as e:
            print(c(f"❌ No pude leer groups por HTTP: {groups_url}\n   {e}", "red"))
            sys.exit(2)
    else:
        groups_fs = os.path.join(root, groups_path)
        if not os.path.isfile(groups_fs):
            print(c(f"❌ No existe groups.json en FS: {groups_fs}", "red"))
            sys.exit(2)
        try:
            data = read_json_fs(groups_fs)
        except Exception as e:
            print(c(f"❌ Error leyendo groups.json: {groups_fs}\n   {e}", "red"))
            sys.exit(2)

    groups = normalize_groups(data)
    if not groups:
        print(c("❌ Formato groups inválido. Debe ser [..] o {\"groups\":[..]}", "red"))
        print(c(f"   Tipo recibido: {type(data).__name__}", "yellow"))
        sys.exit(3)

    print(c(f"✅ Grupos cargados: {len(groups)}", "green"))
    hr()

    total_files = 0
    total_ok = 0
    total_empty = 0
    total_missing = 0
    total_badjson = 0
    total_http_fail = 0

    # 2) inspección por grupo
    for gi, g in enumerate(groups, start=1):
        gid = g.get("id", f"(sin id #{gi})")
        label = g.get("label", "")
        enabled = safe_bool_enabled(g)
        pick = safe_pick(g)
        files = g.get("files") if isinstance(g.get("files"), list) else []

        print(c(f"[{gi}/{len(groups)}] Grupo: {gid}", "cyan") + (f" — {label}" if label else ""))
        print(f"  enabled: {enabled} | pick: {pick} | files: {len(files)}")

        if not files:
            print(c("  ⚠️  Grupo sin 'files' (o no es lista).", "yellow"))
            hr()
            continue

        if not enabled:
            print(c("  (grupo deshabilitado: se reporta igual, pero ojo que el runtime lo puede saltar)", "gray"))

        # 3) inspección por archivo
        for fi, rel in enumerate(files, start=1):
            total_files += 1
            rel_s = str(rel).strip()

            if not rel_s:
                print(c(f"  [{fi}] ❌ ruta vacía", "red"))
                total_missing += 1
                continue

            if mode == "http":
                url = urljoin(base_url.rstrip("/") + "/", rel_s.lstrip("/"))
                status, ctype, sample, err = http_head_or_get(url)
                if err or (status is None) or (status >= 400):
                    print(c(f"  [{fi}] ❌ HTTP FAIL {status}: {rel_s}", "red"))
                    if err:
                        ct = ctype if ctype else "(sin)"
                        print(c(f"       Content-Type: {ct}", "gray"))
                    total_http_fail += 1
                    continue
                # detecta HTML accidental (por 404 que devuelve HTML, etc.)
                if "<!doctype html" in sample.lower() or "<html" in sample.lower():
                    print(c(f"  [{fi}] ❌ URL devuelve HTML (probable 404/redirect): {rel_s}", "red"))
                    print(c(f"       Content-Type: {ctype or '(sin)'}", "gray"))
                    total_http_fail += 1
                    continue

                try:
                    gj = read_json_http(url)
                except Exception as e:
                    print(c(f"  [{fi}] ❌ JSON inválido en HTTP: {rel_s}", "red"))
                    print(c(f"       {e}", "gray"))
                    total_badjson += 1
                    continue
            else:
                fs_path = os.path.join(root, rel_s)
                if not os.path.isfile(fs_path):
                    print(c(f"  [{fi}] ❌ NO EXISTE: {rel_s}", "red"))
                    total_missing += 1
                    continue
                try:
                    gj = read_json_fs(fs_path)
                except Exception as e:
                    print(c(f"  [{fi}] ❌ JSON inválido: {rel_s}", "red"))
                    print(c(f"       {e}", "gray"))
                    total_badjson += 1
                    continue

            # 4) validar GeoJSON
            ftype = (gj.get("type") or "").strip()
            feats = gj.get("features") if isinstance(gj.get("features"), list) else None
            nfeat = len(feats) if feats is not None else 0

            if ftype != "FeatureCollection" or feats is None:
                print(c(f"  [{fi}] ❌ No es FeatureCollection válido: {rel_s} (type={ftype})", "red"))
                total_badjson += 1
                continue

            if nfeat == 0:
                print(c(f"  [{fi}] ⚠️  FeatureCollection vacía: {rel_s}", "yellow"))
                total_empty += 1
                continue

            # 5) scan parcial para bbox + tipos
            bbox = None
            geom_types = {}
            scan_n = min(nfeat, max_features_scan)

            for k in range(scan_n):
                feat = feats[k] or {}
                geom = feat.get("geometry") or {}
                gt = geom.get("type") or "None"
                geom_types[gt] = geom_types.get(gt, 0) + 1

                b = feature_bbox(feat)
                bbox = merge_bbox(bbox, b)

            total_ok += 1

            gt_str = ", ".join([f"{k}:{v}" for k, v in sorted(geom_types.items(), key=lambda x: (-x[1], x[0]))])
            bbox_str = "None" if bbox is None else f"[{bbox[0]:.6f},{bbox[1]:.6f}] → [{bbox[2]:.6f},{bbox[3]:.6f}]"

            print(c(f"  [{fi}] ✅ {rel_s}", "green"))
            print(f"       features: {nfeat} | geom: {gt_str}")
            if verbose:
                print(f"       bbox(scan {scan_n}): {bbox_str}")

        hr()

    dt = time.time() - t0
    print(c("RESUMEN", "bold"))
    print(f"  archivos totales: {total_files}")
    print(c(f"  ok: {total_ok}", "green"))
    print(c(f"  vacíos: {total_empty}", "yellow"))
    print(c(f"  no existen: {total_missing}", "red"))
    print(c(f"  json inválidos: {total_badjson}", "red"))
    if mode == "http":
        print(c(f"  http fail/html: {total_http_fail}", "red"))
    print(c(f"  tiempo: {dt:.2f}s", "gray"))

    # exit code útil para CI / scripts
    if total_ok == 0 or total_missing or total_badjson or total_http_fail:
        sys.exit(1)
    sys.exit(0)


def main():
    ap = argparse.ArgumentParser(description="GeoNEMO Inspector Debug (groups->geojson)")
    ap.add_argument("--groups", required=True, help="Ruta a groups.json (relativa al root o al base-url)")
    ap.add_argument("--root", default=".", help="Root del repo (solo modo fs)")
    ap.add_argument("--mode", choices=["fs", "http"], default="fs", help="fs=lee archivos; http=lee por URL")
    ap.add_argument("--base-url", default="", help="Base URL si mode=http, ej: http://127.0.0.1:5500")
    ap.add_argument("--max-scan", type=int, default=200, help="Máx features a escanear por archivo para bbox/tipos")
    ap.add_argument("--verbose", action="store_true", help="Imprime bbox y más detalles")
    args = ap.parse_args()

    if args.mode == "http" and not args.base_url:
        print("❌ En modo http debes indicar --base-url (ej: http://127.0.0.1:5500)")
        sys.exit(2)

    inspect(
        groups_path=args.groups,
        root=args.root,
        mode=args.mode,
        base_url=args.base_url,
        max_features_scan=args.max_scan,
        verbose=args.verbose,
    )


if __name__ == "__main__":
    main()
