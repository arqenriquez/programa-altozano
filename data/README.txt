CARPETA DE DATOS — Gantt Viewer
================================

Esta carpeta contiene el archivo XML que la aplicación lee al cargar.

ARCHIVO: programa.xml
---------------------

Reemplaza este archivo cada vez que actualices el cronograma:

1. Abre el .mpp en Microsoft Project.
2. File -> Save As -> XML (*.xml)
3. Guarda como "programa.xml" (mismo nombre, sin sufijos ni fechas).
4. Sobrescribe el archivo aquí: gantt-viewer/data/programa.xml
5. Commit + push a la rama main.
6. GitHub Pages publica la nueva versión en menos de un minuto.

NOTAS
-----
- El nombre del archivo debe ser exactamente "programa.xml". Si lo cambias,
  hay que actualizar XML_PATH en script.js.
- No borres este README.txt — sirve como recordatorio para el siguiente
  reemplazo.
- No subas el .mpp al repo: solo el XML.

— Metta Arquitectura / EZ PM
