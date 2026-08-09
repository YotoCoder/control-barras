/* Control de barras — asignación de identidad por peso.
   Todo corre en el teléfono. Nada sale de aquí salvo lo que exportes a mano. */

// ---------- Tolerancias (en gramos) ----------
const TOL_OK    = 0.50;  // desviación normal balanza/lista -> verde
const TOL_MAX   = 2.00;  // por encima de esto -> alerta roja
const TOL_AMBIG = 3.00;  // margen mínimo que debe sacar el 1er candidato al 2º

// ---------- Estado ----------
let embarque = null;   // { nombre, cargadoEn, barras:[{item,bruto,ley,puro}] }
let registros = {};    // asignaciones  { item: {item, medido, delta, ts} }
let historial = [];    // items asignados en orden, para poder deshacer el último
let edicion = null;    // item en corrección, o null
let candidato = null;  // barra candidata en vivo

// ---------- IndexedDB mínima ----------
const DB = 'barras-db';
let db;

function abrirDB() {
  return new Promise((ok, err) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      if (!d.objectStoreNames.contains('fotos')) d.createObjectStore('fotos');
    };
    req.onsuccess = () => { db = req.result; ok(db); };
    req.onerror = () => err(req.error);
  });
}

function guardar(store, clave, valor) {
  return new Promise((ok, err) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(valor, clave);
    tx.oncomplete = ok;
    tx.onerror = () => err(tx.error);
  });
}

function leer(store, clave) {
  return new Promise((ok, err) => {
    const req = db.transaction(store, 'readonly').objectStore(store).get(clave);
    req.onsuccess = () => ok(req.result);
    req.onerror = () => err(req.error);
  });
}

// ---------- Parseo del packing list ----------
function normaliza(s) {
  return String(s ?? '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

function parsearLibro(buffer) {
  const wb = XLSX.read(buffer, { type: 'array' });
  const hoja = wb.Sheets[wb.SheetNames[0]];
  const filas = XLSX.utils.sheet_to_json(hoja, { header: 1, blankrows: false });

  let iCab = -1;
  for (let i = 0; i < Math.min(filas.length, 15); i++) {
    if (filas[i].some(c => normaliza(c) === 'ITEM')) { iCab = i; break; }
  }
  if (iCab === -1) throw new Error('No encontré una columna llamada ITEM en las primeras filas.');

  const cab = filas[iCab].map(normaliza);
  const col = {
    item:  cab.findIndex(c => c === 'ITEM'),
    bruto: cab.findIndex(c => c.includes('BRUTO')),
    ley:   cab.findIndex(c => c.includes('LEY')),
    puro:  cab.findIndex(c => c.includes('PURO') || c.includes('FINO')),
  };
  const faltan = Object.entries(col).filter(([, v]) => v === -1).map(([k]) => k);
  if (faltan.length) throw new Error('Faltan columnas en la cabecera: ' + faltan.join(', ') + '.');

  const barras = [];
  for (let i = iCab + 1; i < filas.length; i++) {
    const f = filas[i];
    const item  = Number(f[col.item]);
    const bruto = Number(f[col.bruto]);
    if (!Number.isFinite(item) || !Number.isFinite(bruto) || bruto <= 0) continue;
    barras.push({ item, bruto, ley: Number(f[col.ley]), puro: Number(f[col.puro]) });
  }
  if (!barras.length) throw new Error('La cabecera está bien pero no leí ninguna fila de barras.');
  return barras;
}

// ---------- Matching ----------
function ordenarCandidatos(peso) {
  const pool = embarque.barras.filter(b => !registros[b.item]);
  return pool
    .map(b => ({ ...b, delta: peso - b.bruto }))
    .sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta));
}

// ---------- Render ----------
const $ = id => document.getElementById(id);
const fmt = (n, d = 2) => Number(n).toFixed(d);
const signo = d => (d >= 0 ? '+' : '−') + fmt(Math.abs(d));

function pintarDelta(el, delta) {
  el.textContent = signo(delta) + ' g';
  el.classList.remove('d-rojo', 'd-verde');
  el.classList.add(delta < 0 ? 'd-rojo' : 'd-verde');
}

function vaciarLcd(txt) {
  candidato = null;
  $('lcdVacio').textContent = txt;
  $('lcdVacio').classList.remove('oculto');
  $('lcdDatos').classList.add('oculto');
  $('rotuloPintar').classList.add('oculto');
  $('btnConfirmar').disabled = true;
}

function pintarLcdEdicion() {
  const barra = embarque.barras.find(b => b.item === edicion);
  const peso = parseFloat($('peso').value.replace(',', '.'));
  $('rotuloPintar').classList.add('oculto');
  $('bannerEdicion').classList.remove('oculto');
  $('txtEdicion').textContent =
    `Item ${barra.item}. Peso registrado: ${fmt(registros[barra.item].medido)} g. Vuelve a pesar y confirma para corregir.`;

  if (!Number.isFinite(peso) || peso <= 0) {
    candidato = null;
    $('lcdVacio').textContent = 'esperando peso';
    $('lcdVacio').classList.remove('oculto');
    $('lcdDatos').classList.add('oculto');
    $('btnConfirmar').disabled = true;
    $('estado').innerHTML = '';
    return;
  }

  candidato = { ...barra, delta: peso - barra.bruto };
  const abs = Math.abs(candidato.delta);

  $('lcdVacio').classList.add('oculto');
  $('lcdDatos').classList.remove('oculto');
  $('lcdItem').textContent = candidato.item;
  pintarDelta($('lcdDelta'), candidato.delta);
  $('lcdBruto').textContent = fmt(candidato.bruto);
  $('lcdLey').textContent = fmt(candidato.ley);
  $('lcdPuro').textContent = fmt(candidato.puro);

  $('btnConfirmar').disabled = false;
  $('btnConfirmar').textContent = `Guardar corrección item ${candidato.item}`;

  $('estado').innerHTML = abs > TOL_MAX
    ? `<div class="est est-mal"><b>Fuera de tolerancia</b>${fmt(abs)} g de diferencia contra la lista.</div>`
    : `<div class="est est-ok"><b>Dentro de tolerancia</b>Diferencia de ${fmt(abs)} g contra la lista.</div>`;
}

function pintarLcd() {
  if (edicion != null) { pintarLcdEdicion(); return; }

  const peso = parseFloat($('peso').value.replace(',', '.'));
  $('bannerEdicion').classList.add('oculto');

  if (!Number.isFinite(peso) || peso <= 0) {
    vaciarLcd('esperando peso');
    $('estado').innerHTML = '';
    return;
  }

  const orden = ordenarCandidatos(peso);
  if (!orden.length) {
    vaciarLcd('todas las barras asignadas');
    $('estado').innerHTML =
      '<div class="est est-ok"><b>Embarque completo</b>Toca una barra ya asignada si necesitas corregirla.</div>';
    return;
  }

  candidato = orden[0];
  const abs = Math.abs(candidato.delta);
  const pendientes = embarque.barras.filter(b => !registros[b.item]).length;

  $('lcdVacio').classList.add('oculto');
  $('lcdDatos').classList.remove('oculto');
  $('lcdItem').textContent = candidato.item;
  pintarDelta($('lcdDelta'), candidato.delta);
  $('lcdBruto').textContent = fmt(candidato.bruto);
  $('lcdLey').textContent = fmt(candidato.ley);
  $('lcdPuro').textContent = fmt(candidato.puro);

  const avisos = [];

  // --- margen contra el segundo candidato: lo único que sostiene la asignación ---
  let margen = Infinity;
  if (orden.length > 1) margen = Math.abs(orden[1].delta) - abs;

  if (abs > TOL_MAX) {
    avisos.push(['mal', 'Fuera de tolerancia',
      `${fmt(abs)} g de diferencia contra la lista, y lo esperable es menos de ${fmt(TOL_OK)} g. ` +
      `Comprueba el cero de la balanza y que no haya nada más en el plato.`]);
  }

  if (margen < TOL_AMBIG) {
    avisos.push(['mal', 'Asignación insegura',
      `El item ${orden[1].item} está a ${signo(orden[1].delta)} g, casi tan cerca como el ${candidato.item}. ` +
      `Con esta diferencia el peso no basta para decidir. Vuelve a pesar antes de pintar nada.`]);
  }

  if (pendientes === 1) {
    avisos.push(['warn', 'Última barra',
      `Es la única sin asignar, así que le toca el item ${candidato.item} por descarte. ` +
      `Aun así el peso debería cuadrar: comprueba la diferencia antes de pintar.`]);
  } else if (!avisos.length) {
    avisos.push(['ok', 'Asignación clara',
      `Diferencia de ${fmt(abs)} g contra la lista, y el siguiente candidato está a ${fmt(margen)} g más.`]);
  }

  $('txtPintar').textContent =
    `Pinta el número ${candidato.item} en esta barra. Luego confirma para pasar a la siguiente.`;
  $('rotuloPintar').classList.remove('oculto');
  $('btnConfirmar').disabled = false;
  $('btnConfirmar').textContent = `Pintada — confirmar item ${candidato.item}`;

  $('estado').innerHTML = avisos
    .map(([t, tit, txt]) => `<div class="est est-${t}"><b>${tit}</b>${txt}</div>`)
    .join('');
}

function pintarProgreso() {
  const total = embarque.barras.length;
  const hechas = Object.keys(registros).length;
  $('progBarra').style.width = (hechas / total * 100) + '%';
  $('resumenProgreso').textContent = `${hechas} / ${total} barras asignadas`;
  $('btnDeshacer').classList.toggle('oculto', !historial.length);

  $('gridItems').innerHTML = embarque.barras.map(b => {
    const r = registros[b.item];
    let clase = '', pie = `<span class="chip-peso">${fmt(b.bruto)}</span>`;
    if (r) {
      clase = Math.abs(r.delta) > TOL_MAX ? 'alerta' : 'hecho';
      if (edicion === b.item) clase += ' editando';
      pie += `<span class="chip-delta ${r.delta < 0 ? 'd-rojo' : 'd-verde'}">${signo(r.delta)}</span>`;
    }
    pie += `<span class="chip-ley">${fmt(b.ley)}</span>`;
    return `<div class="chip ${clase}" data-item="${b.item}"><b>${b.item}</b>${pie}</div>`;
  }).join('');
}

function pintarTodo() {
  if (!embarque) {
    $('vistaCarga').classList.remove('oculto');
    $('vistaPesaje').classList.add('oculto');
    $('nombreEmbarque').textContent = 'sin embarque';
    return;
  }
  $('vistaCarga').classList.add('oculto');
  $('vistaPesaje').classList.remove('oculto');
  $('nombreEmbarque').textContent = embarque.nombre;
  pintarProgreso();
  pintarLcd();
}

// ---------- Exportación ----------
function exportarExcel() {
  const filas = embarque.barras.map(b => {
    const r = registros[b.item];
    return {
      ITEM: b.item,
      BRUTO: Number(fmt(b.bruto)),
      LEY: Number(fmt(b.ley)),
      PURO: Number(fmt(b.puro)),
      'DIFERENCIA BRUTO (g)': r ? Number(fmt(r.delta)) : '',
    };
  });
  const ws = XLSX.utils.json_to_sheet(filas);

  // Fuerza 2 decimales visibles en Excel: sin esto, un valor como 1000
  // se ve "1000" en la celda en vez de "1000.00" (el número de fondo no cambia).
  const rango = XLSX.utils.decode_range(ws['!ref']);
  for (let fila = rango.s.r + 1; fila <= rango.e.r; fila++) {
    for (let col = 1; col <= 4; col++) {
      const celda = ws[XLSX.utils.encode_cell({ r: fila, c: col })];
      if (celda && typeof celda.v === 'number') celda.z = '0.00';
    }
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Asignacion');
  XLSX.writeFile(wb, `${embarque.nombre}-asignacion.xlsx`);
}

// ---------- Edición de asignaciones ----------
function empezarEdicion(item) {
  if (!registros[item]) return;
  edicion = item;
  $('peso').value = fmt(registros[item].medido);
  pintarTodo();
  $('peso').focus();
  $('peso').select();
}

function cancelarEdicion() {
  edicion = null;
  $('peso').value = '';
  $('bannerEdicion').classList.add('oculto');
  pintarTodo();
}

async function borrarAnotacion() {
  if (edicion == null) return;
  const item = edicion;
  if (!confirm(`¿Borrar la asignación del item ${item}? Vuelve al pool sin peso registrado.`)) return;
  delete registros[item];
  historial = historial.filter(i => i !== item);
  await guardar('kv', 'registros', registros);
  await guardar('kv', 'historial', historial);
  cancelarEdicion();
}

async function deshacerUltima() {
  if (!historial.length) return;
  const item = historial.pop();
  delete registros[item];
  await guardar('kv', 'registros', registros);
  await guardar('kv', 'historial', historial);
  if (edicion === item) cancelarEdicion(); else pintarTodo();
  mostrarToast(`Deshecho: item ${item} vuelve al pool.`, 'deshacer');
}

// ---------- Toast ----------
function mostrarToast(texto, tipo) {
  const toast = $('toast');
  toast.textContent = texto;
  toast.classList.toggle('deshacer', tipo === 'deshacer');
  toast.classList.add('visible');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('visible'), 4000);
}

// ---------- Panel de pares cercanos ----------
function calcularPares() {
  const orden = [...embarque.barras].sort((a, b) => a.bruto - b.bruto);
  let gapMin = Infinity, par = null;
  const riesgo = [];
  for (let i = 1; i < orden.length; i++) {
    const gap = orden[i].bruto - orden[i - 1].bruto;
    if (gap < gapMin) { gapMin = gap; par = `${orden[i - 1].item}/${orden[i].item}`; }
    if (gap < TOL_AMBIG) riesgo.push(`${orden[i - 1].item}/${orden[i].item} (${fmt(gap)} g)`);
  }
  return { gapMin, par, riesgo };
}

function mensajePares(barrasLen) {
  const { gapMin, par, riesgo } = calcularPares();
  const prefijo = barrasLen ? `${barrasLen} barras. ` : '';
  return riesgo.length
    ? `<div class="est est-mal"><b>Pares en riesgo</b>${prefijo}Estos pares no se pueden separar solo por peso: ` +
      `${riesgo.join(', ')}. Vas a necesitar otra pista para esas barras.</div>`
    : `<div class="est est-ok"><b>Sin pares en riesgo</b>${prefijo}El par más cercano es el ${par}, separado por ` +
      `${fmt(gapMin)} g. Cada peso identifica una sola barra sin ambigüedad.</div>`;
}

function abrirPanel() {
  if (!embarque) return;
  $('panelParesBody').innerHTML = mensajePares();
  $('panelPares').classList.add('abierto');
  $('overlayPanel').classList.add('abierto');
}

function cerrarPanel() {
  $('panelPares').classList.remove('abierto');
  $('overlayPanel').classList.remove('abierto');
}

// ---------- Actualización ----------
async function vaciarCache() {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const r of regs) await r.unregister();
    }
    if ('caches' in window) {
      const keys = await caches.keys();
      for (const k of keys) await caches.delete(k);
    }
  } finally {
    // URL con parámetro único: nunca pudo haber quedado en ninguna caché,
    // ni la del service worker ni la HTTP normal del navegador.
    location.href = location.pathname + '?actualizado=' + Date.now();
  }
}

// ---------- Tema ----------
const TEMAS = ['auto', 'light', 'dark'];
const ETIQUETAS_TEMA = { auto: 'AUTO', light: 'CLARO', dark: 'OSCURO' };

function colorDeFondoActual() {
  return getComputedStyle(document.documentElement).getPropertyValue('--acero').trim();
}

function pintarBotonTema(tema) {
  $('btnTema').textContent = ETIQUETAS_TEMA[tema];
  $('btnTema').title = `Tema: ${ETIQUETAS_TEMA[tema]} — tocar para cambiar`;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = colorDeFondoActual();
}

function aplicarTema(tema) {
  document.documentElement.dataset.theme = tema;
  localStorage.setItem('tema', tema);
  pintarBotonTema(tema);
}

if (window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (document.documentElement.dataset.theme === 'auto') pintarBotonTema('auto');
  });
}

// ---------- Eventos ----------
$('btnTema').addEventListener('click', () => {
  const actual = document.documentElement.dataset.theme || 'auto';
  const siguiente = TEMAS[(TEMAS.indexOf(actual) + 1) % TEMAS.length];
  aplicarTema(siguiente);
});

$('nombreEmbarque').addEventListener('click', () => {
  const hechas = embarque ? Object.keys(registros).length : 0;
  if (hechas && !confirm(
    `Cargar otro packing list borra el embarque actual y sus ${hechas} asignaciones. ¿Continuar?`
  )) return;
  $('archivoXlsx').click();
});

$('archivoXlsx').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    if (typeof XLSX === 'undefined') throw new Error('La librería de Excel no cargó. Necesitas conexión la primera vez.');
    const barras = parsearLibro(await file.arrayBuffer());
    embarque = { nombre: file.name.replace(/\.xlsx?$/i, ''), cargadoEn: Date.now(), barras };
    registros = {}; historial = []; edicion = null;
    await guardar('kv', 'embarque', embarque);
    await guardar('kv', 'registros', registros);
    await guardar('kv', 'historial', historial);

    pintarTodo();
    $('estado').innerHTML = mensajePares(barras.length) +
      '<p class="nota" style="margin:8px 0 0">Desliza a la izquierda para volver a ver este aviso.</p>';
  } catch (err) {
    $('errorCarga').innerHTML =
      `<div class="est est-mal" style="margin-top:14px"><b>No pude leer el archivo</b>${err.message}</div>`;
  }
  e.target.value = '';
});

$('peso').addEventListener('input', pintarLcd);

$('gridItems').addEventListener('click', e => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  const item = Number(chip.dataset.item);
  if (registros[item]) empezarEdicion(item);
});

$('btnCancelarEdicion').addEventListener('click', cancelarEdicion);
$('btnBorrarAnotacion').addEventListener('click', borrarAnotacion);

$('btnConfirmar').addEventListener('click', async () => {
  if (!candidato) return;
  const medido = parseFloat($('peso').value.replace(',', '.'));
  const esNueva = edicion == null;
  const itemConfirmado = candidato.item; // pintarTodo() más abajo pone candidato en null

  registros[candidato.item] = { item: candidato.item, medido, delta: candidato.delta, ts: Date.now() };
  if (esNueva) historial.push(candidato.item);
  await guardar('kv', 'registros', registros);
  if (esNueva) await guardar('kv', 'historial', historial);

  const volverAEditar = edicion != null;
  edicion = null;
  $('peso').value = '';
  $('bannerEdicion').classList.add('oculto');
  pintarTodo();

  if (esNueva) mostrarToast(`Item ${itemConfirmado} asignado — ${fmt(medido)} g`);

  if (!volverAEditar) $('peso').focus();
});

$('btnExcel').addEventListener('click', exportarExcel);
$('btnDeshacer').addEventListener('click', deshacerUltima);

$('btnVaciarCache').addEventListener('click', () => {
  if (!confirm(
    'Esto borra los archivos guardados para uso sin señal y recarga la app. ' +
    'Vas a necesitar conexión para que vuelva a funcionar offline. ¿Continuar?'
  )) return;
  vaciarCache();
});

$('overlayPanel').addEventListener('click', cerrarPanel);
$('btnCerrarPanel').addEventListener('click', cerrarPanel);

let touchX = null, touchY = null;
document.addEventListener('touchstart', e => {
  touchX = e.touches[0].clientX;
  touchY = e.touches[0].clientY;
}, { passive: true });
document.addEventListener('touchend', e => {
  if (touchX == null) return;
  const dx = e.changedTouches[0].clientX - touchX;
  const dy = e.changedTouches[0].clientY - touchY;
  touchX = null;
  if (Math.abs(dx) < 60 || Math.abs(dy) > 60) return;
  if (dx < 0) abrirPanel(); else cerrarPanel();
}, { passive: true });

// ---------- Arranque ----------
pintarBotonTema(document.documentElement.dataset.theme || 'auto');

(async () => {
  await abrirDB();
  embarque = (await leer('kv', 'embarque')) || null;
  registros = (await leer('kv', 'registros')) || {};
  historial = (await leer('kv', 'historial')) || [];
  pintarTodo();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js')
      .then(reg => reg.update().catch(() => {}))
      .catch(() => {});

    let recargando = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (recargando) return;
      recargando = true;
      location.reload();
    });
  }
})();
