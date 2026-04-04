# Diagnóstico: por qué HOME_VIEW no se respeta siempre

Se documenta el flujo real de inicialización en `js/index.js`:

1. `init()` llama `parseIncomingViewport()`.
2. `init()` pasa ese resultado a `crearMapa(incomingViewport)`.
3. `crearMapa()` crea el mapa con `center/zoom` de `HOME_VIEW`, pero inmediatamente después aplica prioridad:
   - `fitBounds` si `type === "bbox"`.
   - `setView(lat,lon,zoom)` si `type === "coords"`.
   - recién en caso contrario usa `HOME_VIEW`.
4. Al final de `init()`, si NO llegó viewport entrante, se ejecuta `tryAutoCenterOnUser()` y vuelve a hacer `setView`.

Conclusión: `HOME_VIEW` es solo fallback. No es “vista forzada”.

## Causa raíz principal observada

La causa técnica más fuerte es el orden de precedencia en `crearMapa()`: `bbox/coords` pisan a `HOME_VIEW` por diseño.

Además, existe una inconsistencia de formato del `bbox` entre quien escribe y quien lee:

- `parseIncomingViewport()` documenta y parsea `bbox` como `north,east,south,west`.
- `buildCrossSiteUrl()` escribe `bbox` en orden `south,west,north,east`.

Eso provoca que el `bbox` se ignore en algunos casos (por inválido), y el comportamiento final dependa de qué parámetros vengan realmente en la URL.

## Sobre el “zoom globo completo”

En Leaflet, `fitBounds()` calcula automáticamente el zoom mínimo para encajar completamente el rectángulo indicado dentro del tamaño del contenedor.
Si el `bbox` recibido es muy grande (o cercano a mundial), el resultado natural es un zoom muy bajo (0–2), que visualmente es “globo completo”.

Por eso puede verse global aun con `HOME_VIEW.zoom = 7`: no gana `HOME_VIEW`, gana el `fitBounds` posterior cuando hay `bbox` entrante válido.
