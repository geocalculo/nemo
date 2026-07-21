# geonemo/capas_tosearch

Índice liviano de búsqueda para GeoNEMO.

Archivos generados:
- geonemo_tosearch_areas.geojson: SNASPE + Ramsar en un solo índice.
- geonemo_tosearch_snaspe.geojson: solo SNASPE.
- geonemo_tosearch_ramsar.geojson: solo Sitios Ramsar.

Regla:
- La geometría del índice es Point, calculada desde el centro del bbox del área.
- Cada feature trae `bbox` en propiedades y en el feature GeoJSON para permitir zoom extent.
- Para SNASPE XL vectorizado, los fragmentos se agrupan por `ID_CATASTR`; si falta, por `NOMBRE_TOT`.
- Para búsqueda textual usar `nombre_busq`, con fallback a `nombre_area`, `nombre_unidad`, `region`, `comuna`, `tipo_area`.

Campos principales:
- familia: SNASPE / Ramsar
- tipo_area
- nombre_area
- nombre_unidad
- region
- comuna
- provincia
- territorio
- superficie
- bbox
- lat
- lon
- source_files
- source_parts

Uso esperado:
- El buscador carga `geonemo_tosearch_areas.geojson`.
- La lista desplegable muestra: nombre_area · tipo_area · región.
- Al seleccionar, usar `bbox` para fitBounds; si no existe, usar lat/lon.
