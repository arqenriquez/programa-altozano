/* ================================================================
   PROGRAMA DE OBRA — Gantt Viewer
   Visualizador de archivos XML de MS Project en HTML/JS Vanilla.

   Secciones:
     1) Constantes y estado global
     2) Parser XML       (xmlToTasks)
     3) Builder de árbol (buildTree)
     4) Cálculo de escala de timeline
     5) Render DOM       (renderApp, renderLeftPanel, renderGantt, renderTimeline)
     6) Lógica de estados y colores
     7) Event handlers   (toggle, scroll sync, status date, expand/collapse)
     8) Bootstrap        (fetch + dropzone)
   ================================================================ */


/* ----------------------------------------------------------------
   1) CONSTANTES Y ESTADO GLOBAL
   ---------------------------------------------------------------- */
const XML_PATH = 'data/programa.xml';
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const HOURS_PER_WORKDAY = 8;
const COLLAPSE_STORAGE_KEY = 'ganttCollapseState';

// Estado global de la aplicación.
const state = {
  project: {
    name: '',
    start: null,      // Date
    finish: null,     // Date
    statusDate: null  // Date — del XML o fecha actual
  },
  tasksFlat: [],      // lista plana en orden del XML
  tasksTree: [],      // raíces del árbol
  scale: null,        // resultado de computeScale()
  collapsed: new Set(),// set de UIDs colapsadas
  // ---- Look Ahead (Lean Construction) ----
  // Cuando está activo, sólo se muestran las tareas cuya FECHA DE
  // INICIO cae dentro de la ventana de 5 semanas a partir del lunes
  // de la fecha de corte (semanas S01..S05 relativas), junto con
  // sus tareas padre/agrupador para conservar la jerarquía.
  lookAheadActive: false,
  lookAheadWindow: null,
  lookAheadWeeks: 5
};

// DOM refs (se setean en init)
const $ = (id) => document.getElementById(id);
const dom = {};


/* ----------------------------------------------------------------
   2) PARSER XML
   Convierte el documento XML de MS Project a una lista plana de
   objetos `task`. No construye el árbol todavía.
   ---------------------------------------------------------------- */

/**
 * Parsea texto XML a un Document. Lanza Error si está mal formado.
 */
function parseXmlText(text) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, 'application/xml');
  const errNode = doc.querySelector('parsererror');
  if (errNode) {
    throw new Error('El archivo XML está mal formado: ' + errNode.textContent.slice(0, 200));
  }
  return doc;
}

/**
 * Obtiene el texto de un hijo directo por tag (ignorando namespace).
 * MS Project a veces exporta con namespace por default — los selectores
 * con `localName` evitan tener que registrar prefijos.
 */
function getChildText(node, tagName) {
  for (const c of node.children) {
    if (c.localName === tagName) return c.textContent;
  }
  return null;
}

/**
 * Parsea duración ISO 8601 (PnYnMnDTnHnMnS) a días laborales (8h = 1 día).
 * MS Project usa formato como `PT120H0M0S` o `P1D`.
 */
function parseDurationDays(iso) {
  if (!iso) return 0;
  // Capturamos días, horas y minutos.
  const reD = /P(?:(\d+)D)?/;
  const reT = /T(?:(\d+)H)?(?:(\d+)M)?/;
  const mD = iso.match(reD);
  const mT = iso.match(reT);
  const days = mD && mD[1] ? parseInt(mD[1], 10) : 0;
  const hours = mT && mT[1] ? parseInt(mT[1], 10) : 0;
  const mins  = mT && mT[2] ? parseInt(mT[2], 10) : 0;
  const totalHours = days * HOURS_PER_WORKDAY + hours + mins / 60;
  return Math.max(0, Math.round(totalHours / HOURS_PER_WORKDAY));
}

/**
 * Parsea una fecha tipo "2025-01-01T08:00:00" a Date.
 * Devuelve null si la cadena es vacía o inválida.
 */
function parseDate(str) {
  if (!str) return null;
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Extrae el metadato del proyecto: nombre, fechas, StatusDate.
 */
function extractProjectMeta(doc) {
  const root = doc.documentElement;
  const name = getChildText(root, 'Name')
            || getChildText(root, 'Title')
            || 'Proyecto sin nombre';
  const start  = parseDate(getChildText(root, 'StartDate'));
  const finish = parseDate(getChildText(root, 'FinishDate'));
  const statusDate = parseDate(getChildText(root, 'StatusDate')) || new Date();
  return { name, start, finish, statusDate };
}

/**
 * Convierte el XML a la lista plana de tareas.
 * Excluye UID=0 (raíz del proyecto) y tareas sin nombre.
 */
function xmlToTasks(doc) {
  const taskNodes = doc.getElementsByTagName('Task');
  const tasks = [];

  for (const node of taskNodes) {
    const uid = parseInt(getChildText(node, 'UID'), 10);
    if (Number.isNaN(uid) || uid === 0) continue;

    const name = getChildText(node, 'Name');
    if (!name) continue;

    const outlineLevel = parseInt(getChildText(node, 'OutlineLevel'), 10) || 1;
    const isSummary    = getChildText(node, 'Summary') === '1';
    const isMilestone  = getChildText(node, 'Milestone') === '1';
    const isCritical   = getChildText(node, 'Critical') === '1';
    const wbs          = getChildText(node, 'WBS') || '';
    const start        = parseDate(getChildText(node, 'Start'));
    const finish       = parseDate(getChildText(node, 'Finish'));
    const pct          = parseInt(getChildText(node, 'PercentComplete'), 10) || 0;
    const dur          = parseDurationDays(getChildText(node, 'Duration'));

    tasks.push({
      uid,
      name,
      outlineLevel,
      isSummary,
      isMilestone,
      isCritical,
      wbs,
      start,
      finish,
      percentComplete: Math.max(0, Math.min(100, pct)),
      durationDays: dur,
      children: [],
      parent: null,
      isCollapsed: false,
      isHidden: false
    });
  }

  return tasks;
}


/* ----------------------------------------------------------------
   3) BUILDER DE ÁRBOL
   El XML viene en orden — el OutlineLevel indica profundidad.
   Usamos un stack de padres por nivel.
   ---------------------------------------------------------------- */
function buildTree(flatTasks) {
  const stack = [];
  flatTasks.forEach((task) => {
    task.parent = stack[task.outlineLevel - 1] || null;
    if (task.parent) task.parent.children.push(task);
    stack[task.outlineLevel] = task;
    // limpiar niveles más profundos (cuando "subimos" en la jerarquía)
    for (let i = task.outlineLevel + 1; i < stack.length; i++) {
      stack[i] = undefined;
    }
  });
  return flatTasks.filter((t) => t.outlineLevel === 1);
}


/* ----------------------------------------------------------------
   4) ESCALA DE TIMELINE
   Decide la granularidad (semana / mes / bimestre) según duración.
   ---------------------------------------------------------------- */
function computeScale(projectStart, projectFinish) {
  // Cada celda = 1 día. El header agrupa cada 7 días como "S01, S02..."
  // y la fila inferior muestra la letra del día (L M X J V S D).
  const mode = 'daily';
  const colWidth = 18; // px por día

  // Origen alineado al lunes de la semana donde comienza el proyecto.
  const origin = new Date(projectStart);
  const dow = origin.getDay(); // 0 = domingo, 1 = lunes ...
  const offsetToMonday = (dow === 0 ? -6 : 1 - dow);
  origin.setDate(origin.getDate() + offsetToMonday);
  origin.setHours(0, 0, 0, 0);

  // Una celda por día hasta cubrir projectFinish.
  const cells = [];
  let cursor = new Date(origin);
  while (cursor <= projectFinish) {
    const next = new Date(cursor);
    next.setDate(next.getDate() + 1);
    cells.push({ start: new Date(cursor), end: new Date(next) });
    cursor = next;
  }
  // Completar hasta el domingo para que la última semana esté entera.
  while (cells.length % 7 !== 0) {
    const last = cells[cells.length - 1];
    const next = new Date(last.end);
    next.setDate(next.getDate() + 1);
    cells.push({ start: new Date(last.end), end: next });
  }

  const totalProjectDays = cells.length;
  const pxPerDay = colWidth;
  const totalWidth = cells.length * colWidth;

  return { mode, colWidth, origin, cells, pxPerDay, totalWidth, totalProjectDays };
}


/* ----------------------------------------------------------------
   5) RENDER DOM
   ---------------------------------------------------------------- */

/**
 * Aplica el árbol de tareas al DOM. Punto de entrada después de parsear.
 */
function renderApp() {
  if (!state.tasksFlat.length) {
    dom.viewer.hidden = true;
    dom.emptyState.hidden = false;
    return;
  }

  // Header — el nombre del proyecto está fijado en el HTML;
  // las fechas sí se actualizan desde el XML.
  dom.projectStart.textContent  = formatDate(state.project.start);
  dom.projectFinish.textContent = formatDate(state.project.finish);
  dom.statusDateInput.valueAsDate = state.project.statusDate;
  dom.lastUpdate.textContent = formatDate(new Date(document.lastModified || Date.now()));

  applyCollapseState();
  recomputeHiddenFlags();

  state.scale = computeScale(state.project.start, state.project.finish);
  renderLeftPanel();
  renderTimeline();
  renderGantt();
  renderStatusLine();

  dom.viewer.hidden = false;
  dom.emptyState.hidden = true;
  dom.dropzone.hidden = true;
  dom.errorPanel.hidden = true;
}

/**
 * Render del panel izquierdo (lista de tareas).
 * Columnas: toggle | nombre | duración | comienzo | fin
 */
function renderLeftPanel() {
  const frag = document.createDocumentFragment();
  state.tasksFlat.forEach((task) => {
    const row = document.createElement('div');
    row.className = `task-row level-${Math.min(task.outlineLevel, 6)}`;
    if (task.isSummary) row.classList.add('summary');
    if (task.isHidden) row.classList.add('is-hidden');
    row.dataset.uid = task.uid;

    // Indent por nivel jerárquico
    const indent = (task.outlineLevel - 1) * 14;

    const hasChildren = task.children.length > 0;
    const toggleSym = hasChildren ? (task.isCollapsed ? '▶' : '▼') : '';
    row.innerHTML = `
      <div class="task-toggle ${hasChildren ? '' : 'empty'}">${toggleSym}</div>
      <div class="task-name" title="${escapeHtml(task.name)}">
        <span class="task-name-text" style="padding-left:${indent}px">
          ${task.isMilestone ? '<span class="task-milestone-icon">◆</span>' : ''}${escapeHtml(task.name)}
        </span>
      </div>
      <div class="task-dur">${formatDuration(task.durationDays)}</div>
      <div class="task-start">${formatDateShort(task.start)}</div>
      <div class="task-finish">${formatDateShort(task.finish)}</div>
    `;

    frag.appendChild(row);
  });
  dom.taskList.replaceChildren(frag);
}

/**
 * Render del header del timeline (dos filas).
 *  - Mayor: semana del proyecto → S01, S02, S03...
 *  - Menor: una celda por día con la letra (L M X J V S D).
 */
function renderTimeline() {
  const sc = state.scale;
  const major = document.createElement('div');
  const minor = document.createElement('div');
  major.className = 'timeline-row';
  minor.className = 'timeline-row';

  // Fila mayor: cada semana = 7 celdas diarias.
  const weekCount = Math.ceil(sc.cells.length / 7);
  for (let w = 0; w < weekCount; w++) {
    const cell = document.createElement('div');
    cell.className = 'timeline-cell major';
    cell.style.width = `${7 * sc.colWidth}px`;
    cell.textContent = `S${String(w + 1).padStart(2, '0')}`;
    major.appendChild(cell);
  }

  // Fila menor: una celda por día.
  // Día de la semana en español: D L M X J V S (indexado por getDay() 0-6).
  const DAY_LETTERS = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];
  sc.cells.forEach((cell) => {
    const c = document.createElement('div');
    c.className = 'timeline-cell day';
    c.style.width = `${sc.colWidth}px`;
    const dow = cell.start.getDay();
    c.textContent = DAY_LETTERS[dow];
    if (dow === 0 || dow === 6) c.classList.add('weekend');
    minor.appendChild(c);
  });

  dom.timelineHeader.replaceChildren(major, minor);
  // Sincronizamos el ancho del gantt body con el del timeline.
  dom.timelineHeader.style.width = `${sc.totalWidth}px`;
}

/**
 * Render de las barras del Gantt + líneas guía.
 */
function renderGantt() {
  const sc = state.scale;
  const frag = document.createDocumentFragment();

  // Líneas verticales guía (una por día, más fuerte en frontera semanal).
  // También bandas suaves para sábado/domingo.
  sc.cells.forEach((cell, i) => {
    const line = document.createElement('div');
    line.className = 'gantt-grid-line';
    if (i > 0 && i % 7 === 0) line.classList.add('week-boundary');
    line.style.left = `${i * sc.colWidth}px`;
    frag.appendChild(line);

    const dow = cell.start.getDay();
    if (dow === 0 || dow === 6) {
      const band = document.createElement('div');
      band.className = 'gantt-weekend-band';
      band.style.left = `${i * sc.colWidth}px`;
      band.style.width = `${sc.colWidth}px`;
      frag.appendChild(band);
    }
  });

  // Filas + barras
  state.tasksFlat.forEach((task) => {
    const row = document.createElement('div');
    row.className = 'gantt-row';
    if (task.isHidden) row.classList.add('is-hidden');
    row.dataset.uid = task.uid;

    if (task.start && task.finish) {
      const bar = buildBar(task, sc);
      row.appendChild(bar);
    }
    frag.appendChild(row);
  });

  // Línea de fecha de corte (se reinserta como hijo independiente del gantt body)
  const ganttBody = dom.ganttBody;
  ganttBody.replaceChildren(frag);
  ganttBody.style.width = `${sc.totalWidth}px`;

  // status line se renderiza por separado para poder moverla sin re-render completo
  const statusLine = document.createElement('div');
  statusLine.className = 'status-line';
  statusLine.id = 'statusLine';
  ganttBody.appendChild(statusLine);
  dom.statusLine = statusLine;
}

/**
 * Construye una barra individual (DIV absoluto).
 */
function buildBar(task, sc) {
  const bar = document.createElement('div');
  bar.className = 'bar';

  const startOffsetDays = (task.start - sc.origin) / MS_PER_DAY;
  const durDays = Math.max(0, (task.finish - task.start) / MS_PER_DAY);

  const left  = startOffsetDays * sc.pxPerDay;
  const width = Math.max(4, durDays * sc.pxPerDay);

  bar.style.left  = `${left}px`;
  bar.style.width = `${width}px`;

  // Clase de estado / forma
  const status = computeStatus(task, state.project.statusDate);
  bar.classList.add(status);
  if (task.isSummary)   bar.classList.add('summary');
  if (task.isMilestone) bar.classList.add('milestone');
  if (task.isCritical)  bar.classList.add('critical');

  // Barra interna de avance
  if (!task.isSummary && !task.isMilestone) {
    const progress = document.createElement('div');
    progress.className = 'bar-progress';
    progress.style.width = `${task.percentComplete}%`;
    bar.appendChild(progress);
  }

  // Tooltip
  bar.dataset.tooltip =
    `${task.name}\n` +
    `Inicio: ${formatDate(task.start)}\n` +
    `Fin:    ${formatDate(task.finish)}\n` +
    `Avance: ${task.percentComplete}%  •  ${task.durationDays}d` +
    (task.isCritical ? '\n(Ruta crítica)' : '');

  return bar;
}

/**
 * Coloca la línea de fecha de corte en la posición correcta y la etiqueta.
 */
function renderStatusLine() {
  const sc = state.scale;
  if (!sc || !state.project.statusDate) return;
  const statusLine = dom.statusLine;
  if (!statusLine) return;

  const offsetDays = (state.project.statusDate - sc.origin) / MS_PER_DAY;
  if (offsetDays < 0 || offsetDays > sc.totalProjectDays) {
    statusLine.hidden = true;
    return;
  }
  statusLine.hidden = false;
  statusLine.style.left = `${offsetDays * sc.pxPerDay}px`;
  statusLine.innerHTML = `<span class="status-line-label">${formatDate(state.project.statusDate)}</span>`;
}


/* ----------------------------------------------------------------
   6) LÓGICA DE ESTADOS Y COLORES
   ---------------------------------------------------------------- */
function computeStatus(task, statusDate) {
  if (task.isSummary) return 'summary';

  const pct = task.percentComplete;
  const finish = task.finish;
  const start  = task.start;

  if (pct >= 100) return 'completed';

  // Atrasada: no completada y ya pasó su fecha de fin.
  if (finish && finish < statusDate && pct < 100) return 'delayed';

  // En progreso: comenzó pero no termina.
  if (start && start <= statusDate && finish && finish >= statusDate) {
    // ¿en riesgo? — pct esperado vs real.
    const totalSpanDays = Math.max(1, (finish - start) / MS_PER_DAY);
    const elapsed = Math.max(0, (statusDate - start) / MS_PER_DAY);
    const pctExpected = (elapsed / totalSpanDays) * 100;
    if (pct < pctExpected - 10) return 'delayed';
    return 'in-progress';
  }

  // No iniciada y ya debería haber empezado → overdue (naranja).
  if (start && start < statusDate && pct === 0) return 'overdue';

  // No iniciada y aún a tiempo.
  return 'not-started';
}


/* ----------------------------------------------------------------
   7) EVENT HANDLERS
   ---------------------------------------------------------------- */

/**
 * Toggle de colapso de una tarea Summary.
 */
function toggleCollapse(uid) {
  const task = state.tasksFlat.find((t) => t.uid === uid);
  if (!task || !task.children.length) return;
  task.isCollapsed = !task.isCollapsed;
  if (task.isCollapsed) state.collapsed.add(uid);
  else state.collapsed.delete(uid);
  persistCollapseState();
  recomputeHiddenFlags();
  applyHiddenToDom();
  // Actualiza el ícono ▼/▶
  const toggleEl = dom.taskList.querySelector(`.task-row[data-uid="${uid}"] .task-toggle`);
  if (toggleEl) toggleEl.textContent = task.isCollapsed ? '▶' : '▼';
}

/**
 * Recalcula isHidden de cada tarea según el modo de visualización.
 *  - Look Ahead activo: visible solo si solapa la ventana de N semanas
 *    o si es ancestro de alguna tarea visible.
 *  - Modo normal: visible salvo que algún ancestro esté colapsado.
 */
function recomputeHiddenFlags() {
  if (state.lookAheadActive && state.lookAheadWindow) {
    const { start: ws, end: we } = state.lookAheadWindow;
    const visible = new Set();
    state.tasksFlat.forEach((t) => {
      if (!t.start) return;
      // Criterio: la FECHA DE INICIO cae dentro de la ventana
      // [ws, we). Las Summary se incluyen indirectamente como
      // ancestros, aunque su start sea anterior.
      if (t.start >= ws && t.start < we) {
        // Marcar la tarea y todos sus ancestros como visibles.
        let cur = t;
        while (cur) { visible.add(cur.uid); cur = cur.parent; }
      }
    });
    state.tasksFlat.forEach((t) => { t.isHidden = !visible.has(t.uid); });
    return;
  }

  state.tasksFlat.forEach((t) => {
    let p = t.parent;
    let hidden = false;
    while (p) {
      if (p.isCollapsed) { hidden = true; break; }
      p = p.parent;
    }
    t.isHidden = hidden;
  });
}

/**
 * Calcula la ventana del Look Ahead a partir de una fecha de referencia.
 * La ventana arranca el LUNES de la semana de la fecha y dura N semanas.
 */
function computeLookAheadWindow(fromDate, weeks) {
  const monday = new Date(fromDate);
  const dow = monday.getDay();
  const offsetToMonday = (dow === 0 ? -6 : 1 - dow);
  monday.setDate(monday.getDate() + offsetToMonday);
  monday.setHours(0, 0, 0, 0);
  const end = new Date(monday);
  end.setDate(end.getDate() + weeks * 7);
  return { start: monday, end };
}

/**
 * Activa / desactiva el filtro Look Ahead.
 */
function toggleLookAhead() {
  state.lookAheadActive = !state.lookAheadActive;
  state.lookAheadWindow = state.lookAheadActive
    ? computeLookAheadWindow(state.project.statusDate, state.lookAheadWeeks)
    : null;

  const btn = $('btnLookAhead');
  if (btn) btn.classList.toggle('active', state.lookAheadActive);

  recomputeHiddenFlags();
  applyHiddenToDom();

  // Al activar, desplazar el Gantt al inicio de la ventana para que
  // el usuario vea de inmediato el rango filtrado.
  if (state.lookAheadActive && state.scale && dom.panelRight) {
    const offsetDays = (state.lookAheadWindow.start - state.scale.origin) / MS_PER_DAY;
    const targetPx = Math.max(0, offsetDays * state.scale.pxPerDay - 20);
    dom.panelRight.scrollLeft = targetPx;
  }
}

/**
 * Aplica el flag isHidden a las filas ya renderizadas sin re-render completo.
 */
function applyHiddenToDom() {
  state.tasksFlat.forEach((t) => {
    const rowL = dom.taskList.querySelector(`.task-row[data-uid="${t.uid}"]`);
    const rowR = dom.ganttBody.querySelector(`.gantt-row[data-uid="${t.uid}"]`);
    if (rowL) rowL.classList.toggle('is-hidden', t.isHidden);
    if (rowR) rowR.classList.toggle('is-hidden', t.isHidden);
  });
}

/**
 * Aplica el estado persistido (sessionStorage) al árbol.
 */
function applyCollapseState() {
  try {
    const raw = sessionStorage.getItem(COLLAPSE_STORAGE_KEY);
    if (!raw) return;
    const uids = JSON.parse(raw);
    state.collapsed = new Set(uids);
    state.tasksFlat.forEach((t) => {
      if (state.collapsed.has(t.uid)) t.isCollapsed = true;
    });
  } catch (e) { /* ignorar */ }
}

function persistCollapseState() {
  try {
    sessionStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify([...state.collapsed]));
  } catch (e) { /* ignorar */ }
}

/**
 * Expandir / Colapsar todo.
 */
function expandAll() {
  state.tasksFlat.forEach((t) => { t.isCollapsed = false; });
  state.collapsed.clear();
  persistCollapseState();
  recomputeHiddenFlags();
  renderLeftPanel();
  applyHiddenToDom();
}
function collapseAll() {
  state.tasksFlat.forEach((t) => {
    if (t.isSummary && t.children.length) {
      t.isCollapsed = true;
      state.collapsed.add(t.uid);
    }
  });
  persistCollapseState();
  recomputeHiddenFlags();
  renderLeftPanel();
  applyHiddenToDom();
}

/**
 * Sincronización del scroll vertical entre los dos paneles.
 */
function setupScrollSync() {
  let isSyncing = false;
  const left = dom.panelLeftBody;
  const right = dom.panelRight;

  left.addEventListener('scroll', () => {
    if (isSyncing) return;
    isSyncing = true;
    right.scrollTop = left.scrollTop;
    requestAnimationFrame(() => { isSyncing = false; });
  });
  right.addEventListener('scroll', () => {
    if (isSyncing) return;
    isSyncing = true;
    left.scrollTop = right.scrollTop;
    requestAnimationFrame(() => { isSyncing = false; });
  });
}

/**
 * Sincronización del hover entre filas izquierda y derecha.
 */
function setupHoverSync() {
  const handler = (selector) => (e) => {
    const row = e.target.closest(selector);
    if (!row) return;
    const uid = row.dataset.uid;
    if (!uid) return;
    document.querySelectorAll(`.task-row[data-uid="${uid}"], .gantt-row[data-uid="${uid}"]`)
      .forEach((el) => el.classList.add('hover'));
  };
  const leave = (e) => {
    const row = e.target.closest('.task-row, .gantt-row');
    if (!row) return;
    const uid = row.dataset.uid;
    document.querySelectorAll(`.task-row[data-uid="${uid}"], .gantt-row[data-uid="${uid}"]`)
      .forEach((el) => el.classList.remove('hover'));
  };
  dom.taskList.addEventListener('mouseover', handler('.task-row'));
  dom.taskList.addEventListener('mouseout', leave);
  dom.ganttBody.addEventListener('mouseover', handler('.gantt-row'));
  dom.ganttBody.addEventListener('mouseout', leave);
}

/**
 * Click handler del toggle (delegado).
 */
function setupToggleHandler() {
  dom.taskList.addEventListener('click', (e) => {
    const tog = e.target.closest('.task-toggle');
    if (!tog || tog.classList.contains('empty')) return;
    const row = tog.closest('.task-row');
    if (!row) return;
    const uid = parseInt(row.dataset.uid, 10);
    toggleCollapse(uid);
  });
}

/**
 * Cambio en la fecha de corte → recalcular colores.
 */
function setupStatusDateHandler() {
  dom.statusDateInput.addEventListener('change', () => {
    const d = dom.statusDateInput.valueAsDate;
    if (!d) return;
    state.project.statusDate = d;

    // Si el Look Ahead está activo, deslizar la ventana al nuevo lunes.
    if (state.lookAheadActive) {
      state.lookAheadWindow = computeLookAheadWindow(
        state.project.statusDate, state.lookAheadWeeks
      );
      recomputeHiddenFlags();
      applyHiddenToDom();
    }

    // Re-render solo del gantt (más barato que renderApp).
    renderGantt();
    renderStatusLine();
  });
}


/* ----------------------------------------------------------------
   8) BOOTSTRAP — fetch + dropzone
   ---------------------------------------------------------------- */

async function init() {
  // Asignar refs del DOM
  dom.projectName     = $('projectName');
  dom.projectStart    = $('projectStart');
  dom.projectFinish   = $('projectFinish');
  dom.statusDateInput = $('statusDate');
  dom.lastUpdate      = $('lastUpdate');
  dom.btnExpandAll    = $('btnExpandAll');
  dom.btnCollapseAll  = $('btnCollapseAll');
  dom.viewer          = $('viewer');
  dom.dropzone        = $('dropzone');
  dom.errorPanel      = $('errorPanel');
  dom.errorMessage    = $('errorMessage');
  dom.emptyState      = $('emptyState');
  dom.taskList        = $('taskList');
  dom.timelineHeader  = $('timelineHeader');
  dom.ganttBody       = $('ganttBody');
  dom.panelLeftBody   = document.querySelector('.panel-left-body');
  dom.panelRight      = $('panelRight');
  dom.statusLine      = $('statusLine');
  dom.fileInput       = $('fileInput');
  dom.btnFilePicker   = $('btnFilePicker');

  // Event handlers que viven siempre
  dom.btnExpandAll.addEventListener('click', expandAll);
  dom.btnCollapseAll.addEventListener('click', collapseAll);
  const btnDetailsToggle = $('btnDetailsToggle');
  if (btnDetailsToggle) {
    btnDetailsToggle.addEventListener('click', () => {
      document.body.classList.toggle('details-mode');
    });
  }
  const btnLookAhead = $('btnLookAhead');
  if (btnLookAhead) {
    btnLookAhead.addEventListener('click', toggleLookAhead);
  }
  const btnHeaderCollapse = $('btnHeaderCollapse');
  if (btnHeaderCollapse) {
    btnHeaderCollapse.addEventListener('click', () => {
      document.body.classList.toggle('header-compact');
    });
  }
  const btnNameShrink = $('btnNameShrink');
  if (btnNameShrink) {
    btnNameShrink.addEventListener('click', () => {
      document.body.classList.toggle('left-compact');
    });
  }
  setupToggleHandler();
  setupScrollSync();
  setupHoverSync();
  setupStatusDateHandler();
  setupDropzone();

  // Intentar cargar el XML por fetch.
  // `cache: 'no-cache'` fuerza validación con el servidor en cada carga,
  // así el viewer siempre lee la versión más reciente de programa.xml
  // después de un push semanal a GitHub.
  try {
    const resp = await fetch(`${XML_PATH}?t=${Date.now()}`, { cache: 'no-cache' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    loadFromText(text);
  } catch (err) {
    console.warn('Fetch del XML falló, mostrando dropzone:', err);
    showDropzone();
  }
}

function loadFromText(xmlText) {
  try {
    const doc = parseXmlText(xmlText);
    const meta = extractProjectMeta(doc);
    const flat = xmlToTasks(doc);
    if (!flat.length) throw new Error('El XML no contiene tareas válidas.');

    buildTree(flat);

    // Si el XML no traía fechas de proyecto, las derivamos de las tareas.
    if (!meta.start)  meta.start  = flat.reduce((m, t) => t.start  && (!m || t.start  < m) ? t.start  : m, null);
    if (!meta.finish) meta.finish = flat.reduce((m, t) => t.finish && (!m || t.finish > m) ? t.finish : m, null);

    state.project = meta;
    state.tasksFlat = flat;
    state.tasksTree = flat.filter((t) => t.outlineLevel === 1);

    renderApp();
  } catch (err) {
    console.error(err);
    showError(err.message || String(err));
  }
}

function showDropzone() {
  dom.viewer.hidden = true;
  dom.errorPanel.hidden = true;
  dom.emptyState.hidden = true;
  dom.dropzone.hidden = false;
}

function showError(msg) {
  dom.viewer.hidden = true;
  dom.dropzone.hidden = true;
  dom.emptyState.hidden = true;
  dom.errorPanel.hidden = false;
  dom.errorMessage.textContent = msg;
}

function setupDropzone() {
  const dz = dom.dropzone;
  dom.btnFilePicker.addEventListener('click', () => dom.fileInput.click());
  dom.fileInput.addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) readFile(f);
  });
  ['dragenter', 'dragover'].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('dragover'); })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('dragover'); })
  );
  dz.addEventListener('drop', (e) => {
    const f = e.dataTransfer.files[0];
    if (f) readFile(f);
  });
}

function readFile(file) {
  const reader = new FileReader();
  reader.onload = () => loadFromText(reader.result);
  reader.onerror = () => showError('No se pudo leer el archivo seleccionado.');
  reader.readAsText(file);
}


/* ----------------------------------------------------------------
   HELPERS
   ---------------------------------------------------------------- */
const MONTH_NAMES = [
  'Enero','Febrero','Marzo','Abril','Mayo','Junio',
  'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'
];

function formatDate(d) {
  if (!d) return '—';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = d.getFullYear();
  return `${dd}/${mm}/${yy}`;
}

// "mié 13/5/26" — formato corto al estilo MS Project.
const SHORT_DOW = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
function formatDateShort(d) {
  if (!d) return '—';
  const dow = SHORT_DOW[d.getDay()];
  const day = d.getDate();
  const month = d.getMonth() + 1;
  const yy = String(d.getFullYear()).slice(-2);
  return `${dow} ${day}/${month}/${yy}`;
}

function formatDuration(days) {
  if (days === 0) return '0 días';
  if (days === 1) return '1 día';
  return `${days} días`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}


/* ----------------------------------------------------------------
   ARRANQUE
   ---------------------------------------------------------------- */
document.addEventListener('DOMContentLoaded', init);
