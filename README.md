# Gantt Viewer — Programa de Obra

Visualizador web estático del programa de obra exportado desde MS Project.
Página HTML/JS Vanilla, sin frameworks ni backend, lista para servirse en GitHub Pages.

## Requisitos

- Cualquier browser moderno (Chrome, Edge, Firefox, Safari).
- Para desarrollo local: un servidor estático (ver más abajo). Abrir `index.html` directo (`file://`) funciona, pero el fetch automático del XML cae por CORS — la app muestra un dropzone de fallback.

## Cómo actualizar el programa semanalmente

1. Abrir el `.mpp` en MS Project.
2. **File → Save As → XML (*.xml)**.
3. Guardar el archivo como `programa.xml`.
4. Reemplazar `gantt-viewer/data/programa.xml` con ese archivo.
5. Commit + push a `main`:
   ```bash
   git add data/programa.xml
   git commit -m "Actualización programa de obra YYYY-MM-DD"
   git push
   ```
6. En 30-60 s GitHub Pages publica la nueva versión.

## Deploy a GitHub Pages

1. Subir este repo a GitHub.
2. En el repo: **Settings → Pages**.
3. *Source:* `Deploy from a branch`.
4. *Branch:* `main` / carpeta `/root`.
5. Guardar. La URL pública aparece en la misma página de Settings.

## Desarrollo local

Para que el fetch automático del XML funcione necesitas servir los archivos por HTTP:

```bash
# Con Node (recomendado)
npx serve .

# O con Python 3
python -m http.server 8080
```

Luego abrir `http://localhost:3000` (o `:8080`).

## Estructura

```
gantt-viewer/
├── index.html          App principal
├── style.css           Estilos dark mode, paleta Metta
├── script.js           Parser XML + render Gantt
├── data/
│   ├── programa.xml    XML de MS Project (reemplazar semanalmente)
│   └── README.txt      Instrucciones para reemplazar el archivo
├── assets/
│   └── logo-metta.svg  Logo del header
└── README.md
```

## Funcionalidad

- Carga automática del XML por fetch; fallback con drag & drop si falla.
- Dos paneles con scroll vertical sincronizado: lista de tareas a la izquierda, Gantt a la derecha.
- Colores de barra por estado: completada, en progreso, atrasada, no iniciada, en riesgo.
- Hitos como diamantes; ruta crítica con borde rojo; tareas Summary doradas.
- Línea vertical de fecha de corte (configurable desde el header).
- Colapso / expansión por tarea, con persistencia en `sessionStorage`.
- Escala de timeline adaptativa: semanal / mensual / bimestral según duración del proyecto.

## Créditos

Jorge Enríquez — Metta Arquitectura y Construcción / EZ Project Management
Hermosillo, Sonora — 2026
