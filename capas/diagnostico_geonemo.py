#!/usr/bin/env python3
"""
Script de Diagnóstico GeoNEMO
Identifica problemas con la carga de archivos GeoJSON en producción vs desarrollo
"""

import json
import os
import sys
from pathlib import Path
from typing import Dict, List, Any
import urllib.parse

# Colores para output
class Colors:
    HEADER = '\033[95m'
    OKBLUE = '\033[94m'
    OKCYAN = '\033[96m'
    OKGREEN = '\033[92m'
    WARNING = '\033[93m'
    FAIL = '\033[91m'
    ENDC = '\033[0m'
    BOLD = '\033[1m'
    UNDERLINE = '\033[4m'

def print_header(text: str):
    print(f"\n{Colors.HEADER}{Colors.BOLD}{'='*70}{Colors.ENDC}")
    print(f"{Colors.HEADER}{Colors.BOLD}{text:^70}{Colors.ENDC}")
    print(f"{Colors.HEADER}{Colors.BOLD}{'='*70}{Colors.ENDC}\n")

def print_success(text: str):
    print(f"{Colors.OKGREEN}✓ {text}{Colors.ENDC}")

def print_error(text: str):
    print(f"{Colors.FAIL}✗ {text}{Colors.ENDC}")

def print_warning(text: str):
    print(f"{Colors.WARNING}⚠ {text}{Colors.ENDC}")

def print_info(text: str):
    print(f"{Colors.OKCYAN}ℹ {text}{Colors.ENDC}")


class GeoNEMODiagnostic:
    def __init__(self, project_root: str = "."):
        self.project_root = Path(project_root)
        self.issues = []
        self.warnings = []
        self.successes = []
        
    def add_issue(self, msg: str):
        self.issues.append(msg)
        print_error(msg)
        
    def add_warning(self, msg: str):
        self.warnings.append(msg)
        print_warning(msg)
        
    def add_success(self, msg: str):
        self.successes.append(msg)
        print_success(msg)

    def check_file_exists(self, filepath: Path, description: str) -> bool:
        """Verifica que un archivo exista"""
        if filepath.exists():
            self.add_success(f"{description}: {filepath}")
            return True
        else:
            self.add_issue(f"{description} NO ENCONTRADO: {filepath}")
            return False

    def load_json_file(self, filepath: Path) -> Dict[str, Any] | None:
        """Carga y valida un archivo JSON"""
        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                data = json.load(f)
            self.add_success(f"JSON válido: {filepath}")
            return data
        except json.JSONDecodeError as e:
            self.add_issue(f"JSON INVÁLIDO en {filepath}: {e}")
            return None
        except Exception as e:
            self.add_issue(f"Error leyendo {filepath}: {e}")
            return None

    def check_grupos_json(self) -> Dict[str, Any] | None:
        """Verifica el archivo maestro de grupos"""
        print_header("1. VERIFICANDO ARCHIVO MAESTRO: grupos.json")
        
        grupos_path = self.project_root / "capas" / "grupos.json"
        
        if not self.check_file_exists(grupos_path, "grupos.json"):
            return None
            
        data = self.load_json_file(grupos_path)
        
        if data is None:
            return None
            
        # Validar estructura
        if "groups" not in data:
            self.add_issue("grupos.json no tiene la propiedad 'groups'")
            return None
            
        if not isinstance(data["groups"], list):
            self.add_issue("grupos.json: 'groups' no es un array")
            return None
            
        self.add_success(f"Estructura válida con {len(data['groups'])} grupos")
        
        return data

    def check_group_files(self, grupos_data: Dict[str, Any]):
        """Verifica los archivos GeoJSON de cada grupo"""
        print_header("2. VERIFICANDO ARCHIVOS GEOJSON DE CADA GRUPO")
        
        groups = grupos_data.get("groups", [])
        
        for idx, group in enumerate(groups):
            group_id = group.get("id", f"grupo_{idx}")
            group_name = group.get("group_name", "Sin nombre")
            enabled = group.get("enabled", False)
            files = group.get("files", [])
            
            print(f"\n{Colors.BOLD}Grupo [{idx+1}]: {group_name} (id: {group_id}){Colors.ENDC}")
            print(f"  Estado: {'✓ HABILITADO' if enabled else '✗ DESHABILITADO'}")
            print(f"  Archivos declarados: {len(files)}")
            
            if not files:
                self.add_warning(f"Grupo '{group_name}' no tiene archivos declarados")
                continue
                
            for file_idx, file_path in enumerate(files):
                print(f"\n  Archivo [{file_idx+1}]: {file_path}")
                
                # Resolver ruta relativa
                if file_path.startswith("http://") or file_path.startswith("https://"):
                    self.add_info(f"    URL absoluta: {file_path}")
                    self.add_warning(f"    No se puede verificar URL remota desde script local")
                    continue
                
                # Ruta relativa al directorio del proyecto
                resolved_path = self.project_root / file_path
                
                if not resolved_path.exists():
                    self.add_issue(f"    Archivo NO ENCONTRADO: {resolved_path}")
                    continue
                    
                # Verificar tamaño
                file_size = resolved_path.stat().st_size
                file_size_mb = file_size / (1024 * 1024)
                
                if file_size_mb > 5:
                    self.add_warning(f"    Tamaño grande: {file_size_mb:.2f} MB (puede ser lento en web)")
                else:
                    self.add_success(f"    Tamaño: {file_size_mb:.2f} MB")
                
                # Cargar y validar GeoJSON
                geojson_data = self.load_json_file(resolved_path)
                
                if geojson_data:
                    self.validate_geojson(geojson_data, file_path)

    def validate_geojson(self, data: Dict[str, Any], file_path: str):
        """Valida la estructura de un archivo GeoJSON"""
        
        # Verificar tipo
        geojson_type = data.get("type")
        if geojson_type not in ["FeatureCollection", "Feature", "Polygon", "MultiPolygon"]:
            self.add_warning(f"    Tipo GeoJSON inusual: {geojson_type}")
            return
            
        # Si es FeatureCollection, contar features
        if geojson_type == "FeatureCollection":
            features = data.get("features", [])
            feature_count = len(features)
            
            if feature_count == 0:
                self.add_issue(f"    FeatureCollection VACÍO (0 features)")
                return
            
            self.add_success(f"    Features: {feature_count}")
            
            # Validar geometrías
            geometry_types = {}
            invalid_geometries = 0
            
            for idx, feature in enumerate(features[:100]):  # Revisar primeros 100
                geom = feature.get("geometry")
                if not geom:
                    invalid_geometries += 1
                    continue
                    
                geom_type = geom.get("type", "unknown")
                geometry_types[geom_type] = geometry_types.get(geom_type, 0) + 1
                
                # Validar que tenga coordenadas
                coords = geom.get("coordinates")
                if not coords:
                    invalid_geometries += 1
            
            if invalid_geometries > 0:
                self.add_warning(f"    Geometrías inválidas: {invalid_geometries}/{feature_count}")
            else:
                self.add_success(f"    Todas las geometrías son válidas")
                
            print(f"    Tipos de geometría: {dict(geometry_types)}")
            
        elif geojson_type == "Feature":
            self.add_success(f"    Feature único válido")
        else:
            self.add_success(f"    Geometría directa: {geojson_type}")

    def check_cors_headers(self):
        """Información sobre configuración CORS"""
        print_header("3. CONFIGURACIÓN CORS (Servidor Web)")
        
        print_info("Para que los archivos GeoJSON se carguen en producción, tu servidor")
        print_info("web debe estar configurado con los headers CORS correctos.")
        print()
        
        print(f"{Colors.BOLD}Configuración recomendada:{Colors.ENDC}")
        print()
        print("Para Apache (.htaccess):")
        print("-" * 50)
        print("""<IfModule mod_headers.c>
    Header set Access-Control-Allow-Origin "*"
    Header set Access-Control-Allow-Methods "GET, OPTIONS"
    Header set Access-Control-Allow-Headers "Content-Type"
</IfModule>""")
        print()
        
        print("Para Nginx (nginx.conf):")
        print("-" * 50)
        print("""location ~* \.(geojson|json)$ {
    add_header Access-Control-Allow-Origin *;
    add_header Access-Control-Allow-Methods "GET, OPTIONS";
    add_header Access-Control-Allow-Headers "Content-Type";
}""")
        print()

    def check_file_paths_consistency(self, grupos_data: Dict[str, Any]):
        """Verifica consistencia de rutas entre desarrollo y producción"""
        print_header("4. ANÁLISIS DE RUTAS (Desarrollo vs Producción)")
        
        groups = grupos_data.get("groups", [])
        
        print_info("Analizando si las rutas funcionarán igual en desarrollo y producción...")
        print()
        
        for group in groups:
            group_name = group.get("group_name", "Sin nombre")
            files = group.get("files", [])
            
            for file_path in files:
                if file_path.startswith("http://") or file_path.startswith("https://"):
                    self.add_warning(f"'{group_name}': Usa URL absoluta - puede fallar si el servidor está offline")
                elif file_path.startswith("/"):
                    self.add_warning(f"'{group_name}': Usa ruta absoluta '{file_path}' - puede fallar en diferentes entornos")
                elif file_path.startswith("../"):
                    self.add_warning(f"'{group_name}': Usa ruta relativa con '..' - puede ser inconsistente")
                else:
                    self.add_success(f"'{group_name}': Ruta relativa correcta: {file_path}")

    def check_localStorage_structure(self):
        """Muestra estructura esperada del localStorage"""
        print_header("5. ESTRUCTURA DE LOCALSTORAGE")
        
        print_info("El payload guardado en localStorage debe tener esta estructura:")
        print()
        
        example_payload = {
            "created_at": "2025-01-30T12:00:00Z",
            "updated_at": "2025-01-30T12:00:00Z",
            "click": {"lat": -33.5, "lng": -70.5},
            "groups": [
                {
                    "group_id": "ramsar",
                    "group_name": "Sitios Ramsar",
                    "link_type": "nearest_perimeter",
                    "distance_m": 102120,
                    "distance_border_m": 102120,
                    "source_file": "capas/ramsar.geojson",
                    "feature": {"type": "Feature", "properties": {}, "geometry": {}}
                }
            ],
            "links": [
                {
                    "layer_id": "ramsar",
                    "layer_name": "Sitios Ramsar",
                    "link_type": "nearest_perimeter",
                    "distance_km": 102.12,
                    "distance_m": 102120,
                    "distance_border_m": 102120,
                    "source_file": "capas/ramsar.geojson",
                    "feature": {}
                }
            ]
        }
        
        print(json.dumps(example_payload, indent=2, ensure_ascii=False))
        print()
        
        self.add_info("Para debuggear en la web, ejecuta en la consola del navegador:")
        print(f"  {Colors.BOLD}JSON.parse(localStorage.getItem('geonemo_out_v2')){Colors.ENDC}")

    def generate_debug_script(self):
        """Genera un script JavaScript para debug en el navegador"""
        print_header("6. GENERANDO SCRIPT DE DEBUG PARA NAVEGADOR")
        
        debug_script = """
// ====================
// SCRIPT DE DEBUG GEONEMO
// Copia y pega en la consola del navegador (versión WEB)
// ====================

console.clear();
console.log('%c🔍 INICIANDO DIAGNÓSTICO GEONEMO', 'font-size:16px; font-weight:bold; color:#4CAF50');

// 1. Verificar localStorage
console.log('\\n📦 1. VERIFICANDO LOCALSTORAGE');
const payload = localStorage.getItem('geonemo_out_v2');
if (payload) {
    try {
        const data = JSON.parse(payload);
        console.log('✓ Payload encontrado:', data);
        console.log('  - Grupos:', data.groups?.length || 0);
        console.log('  - Links:', data.links?.length || 0);
        
        // Mostrar cada grupo
        if (data.groups) {
            data.groups.forEach((g, i) => {
                console.log(`  Grupo ${i+1}: ${g.group_name}`);
                console.log(`    - Link type: ${g.link_type}`);
                console.log(`    - Distance: ${g.distance_m} m`);
                console.log(`    - Has feature: ${!!g.feature}`);
                console.log(`    - Source file: ${g.source_file}`);
            });
        }
    } catch(e) {
        console.error('✗ Error parseando payload:', e);
    }
} else {
    console.warn('⚠ No hay payload en localStorage');
}

// 2. Verificar si Turf está cargado
console.log('\\n🌍 2. VERIFICANDO TURF.JS');
if (typeof turf !== 'undefined') {
    console.log('✓ Turf.js está cargado');
    console.log('  - turf.bbox:', typeof turf.bbox);
    console.log('  - turf.area:', typeof turf.area);
    console.log('  - turf.booleanPointInPolygon:', typeof turf.booleanPointInPolygon);
} else {
    console.error('✗ Turf.js NO está cargado');
}

// 3. Verificar Leaflet
console.log('\\n🗺️ 3. VERIFICANDO LEAFLET');
if (typeof L !== 'undefined') {
    console.log('✓ Leaflet está cargado');
} else {
    console.error('✗ Leaflet NO está cargado');
}

// 4. Interceptar fetch para monitorear cargas de archivos
console.log('\\n📡 4. MONITOREANDO PETICIONES FETCH');
console.log('(Los siguientes logs mostrarán las peticiones a archivos GeoJSON)');

const originalFetch = window.fetch;
window.fetch = function(...args) {
    const url = args[0];
    if (typeof url === 'string' && (url.includes('.geojson') || url.includes('.json'))) {
        console.log(`🔄 Fetching: ${url}`);
        return originalFetch(...args)
            .then(response => {
                if (response.ok) {
                    console.log(`✓ Fetch exitoso: ${url} (${response.status})`);
                } else {
                    console.error(`✗ Fetch falló: ${url} (${response.status})`);
                }
                return response;
            })
            .catch(err => {
                console.error(`✗ Fetch error: ${url}`, err);
                throw err;
            });
    }
    return originalFetch(...args);
};

console.log('\\n✅ SCRIPT DE DEBUG INSTALADO');
console.log('Ahora haz clic en el mapa para ver los logs de carga de archivos');
"""
        
        # Guardar script
        script_path = self.project_root / "debug_browser.js"
        with open(script_path, 'w', encoding='utf-8') as f:
            f.write(debug_script)
            
        self.add_success(f"Script de debug guardado en: {script_path}")
        print()
        print_info("Instrucciones:")
        print(f"  1. Abre tu sitio WEB en el navegador")
        print(f"  2. Abre DevTools (F12)")
        print(f"  3. Copia y pega el contenido de {script_path} en la consola")
        print(f"  4. Haz clic en el mapa")
        print(f"  5. Revisa los logs para ver qué archivos fallan")

    def print_summary(self):
        """Imprime resumen final"""
        print_header("RESUMEN DEL DIAGNÓSTICO")
        
        total = len(self.issues) + len(self.warnings) + len(self.successes)
        
        if self.successes:
            print(f"{Colors.OKGREEN}✓ Éxitos: {len(self.successes)}{Colors.ENDC}")
            
        if self.warnings:
            print(f"{Colors.WARNING}⚠ Advertencias: {len(self.warnings)}{Colors.ENDC}")
            
        if self.issues:
            print(f"{Colors.FAIL}✗ Problemas Críticos: {len(self.issues)}{Colors.ENDC}")
            print()
            print(f"{Colors.FAIL}{Colors.BOLD}PROBLEMAS ENCONTRADOS:{Colors.ENDC}")
            for issue in self.issues:
                print(f"  • {issue}")
        
        print()
        if not self.issues:
            print_success("No se encontraron problemas críticos en los archivos locales.")
            print_info("Si el problema persiste en WEB, revisa:")
            print("  1. Configuración CORS del servidor")
            print("  2. Permisos de archivos en el servidor")
            print("  3. Caché del navegador (Ctrl+Shift+R)")
            print("  4. Ejecuta el script de debug en el navegador")
        else:
            print_error("Se encontraron problemas que deben corregirse.")
            print_info("Soluciona los problemas listados arriba y vuelve a ejecutar este script.")

    def run(self):
        """Ejecuta todos los diagnósticos"""
        print(f"{Colors.BOLD}{Colors.OKCYAN}")
        print("""
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║           🔍 DIAGNÓSTICO GEONEMO                              ║
║           Análisis de problemas en carga de archivos          ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
        """)
        print(f"{Colors.ENDC}")
        
        print_info(f"Directorio del proyecto: {self.project_root.absolute()}")
        print()
        
        # 1. Verificar grupos.json
        grupos_data = self.check_grupos_json()
        
        if grupos_data:
            # 2. Verificar archivos de cada grupo
            self.check_group_files(grupos_data)
            
            # 3. Verificar consistencia de rutas
            self.check_file_paths_consistency(grupos_data)
        
        # 4. Info CORS
        self.check_cors_headers()
        
        # 5. Estructura localStorage
        self.check_localStorage_structure()
        
        # 6. Generar script de debug
        self.generate_debug_script()
        
        # 7. Resumen
        self.print_summary()


def main():
    """Función principal"""
    
    # Determinar directorio del proyecto
    if len(sys.argv) > 1:
        project_root = sys.argv[1]
    else:
        project_root = "."
    
    # Ejecutar diagnóstico
    diagnostic = GeoNEMODiagnostic(project_root)
    diagnostic.run()
    
    # Exit code basado en problemas encontrados
    sys.exit(1 if diagnostic.issues else 0)


if __name__ == "__main__":
    main()