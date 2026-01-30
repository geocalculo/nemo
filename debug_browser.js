
// ====================
// SCRIPT DE DEBUG GEONEMO
// Copia y pega en la consola del navegador (versión WEB)
// ====================

console.clear();
console.log('%c🔍 INICIANDO DIAGNÓSTICO GEONEMO', 'font-size:16px; font-weight:bold; color:#4CAF50');

// 1. Verificar localStorage
console.log('\n📦 1. VERIFICANDO LOCALSTORAGE');
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
console.log('\n🌍 2. VERIFICANDO TURF.JS');
if (typeof turf !== 'undefined') {
    console.log('✓ Turf.js está cargado');
    console.log('  - turf.bbox:', typeof turf.bbox);
    console.log('  - turf.area:', typeof turf.area);
    console.log('  - turf.booleanPointInPolygon:', typeof turf.booleanPointInPolygon);
} else {
    console.error('✗ Turf.js NO está cargado');
}

// 3. Verificar Leaflet
console.log('\n🗺️ 3. VERIFICANDO LEAFLET');
if (typeof L !== 'undefined') {
    console.log('✓ Leaflet está cargado');
} else {
    console.error('✗ Leaflet NO está cargado');
}

// 4. Interceptar fetch para monitorear cargas de archivos
console.log('\n📡 4. MONITOREANDO PETICIONES FETCH');
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

console.log('\n✅ SCRIPT DE DEBUG INSTALADO');
console.log('Ahora haz clic en el mapa para ver los logs de carga de archivos');
