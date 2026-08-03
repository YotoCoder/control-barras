/* Control de barras — asignación de identidad por peso y verificación posterior.
   Todo corre en el teléfono. Nada sale de aquí salvo lo que exportes a mano. */

// ---------- Tolerancias (en gramos) ----------
const TOL_OK    = 0.50;  // desviación normal balanza/lista -> verde
const TOL_MAX   = 2.00;  // por encima de esto -> alerta roja
const TOL_AMBIG = 3.00;  // margen mínimo que debe sacar el 1er candidato al 2º

// ---------- Estado ----------
let embarque = null;      // { nombre, cargadoEn, barras:[{item,bruto,ley,puro}] }
let registros = {};       // asignaciones  { item: {item, medido, delta, ts} }
let verificaciones = {};  // 2ª pasada     { item: {pintado, medido, delta, ok, ts} }
let modo = 'asignar';     // 'asignar' | 'verificar'
let fotoActual = null;    // Blob
let candidato = null;     // barra candidata en vivo

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

function limpiar(store) {
  return new Promise((ok, err) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).clear();
    tx.oncomplete = ok;
    tx.onerror = () => err(tx.error);
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
function ordenarCandidatos(peso, todas = false) {
  const pool = todas ? embarque.barras : embarque.barras.filter(b => !registros[b.item]);
  return pool
    .map(b => ({ ...b, delta: peso - b.bruto }))
    .sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta));
}

// ---------- Render ----------
const $ = id => document.getElementById(id);
const fmt = (n, d = 2) => Number(n).toFixed(d);
const signo = d => (d >= 0 ? '+' : '−') + fmt(Math.abs(d));

function pintarLcd() {
  const peso = parseFloat($('peso').value.replace(',', '.'));
  const pintado = $('pintado').value.trim();
  const verificando = modo === 'verificar';

  const vaciar = txt => {
    candidato = null;
    $('lcdVacio').textContent = txt;
    $('lcdVacio').classList.remove('oculto');
    $('lcdDatos').classList.add('oculto');
    $('rotuloPintar').classList.add('oculto');
    $('btnConfirmar').disabled = true;
  };

  if (!Number.isFinite(peso) || peso <= 0) {
    vaciar('esperando peso');
    $('estado').innerHTML = '';
    return;
  }

  const orden = ordenarCandidatos(peso, verificando);
  if (!orden.length) {
    vaciar('todas las barras asignadas');
    $('estado').innerHTML =
      '<div class="est est-ok"><b>Embarque completo</b>Exporta el CSV y pasa a modo Verificar para repasar la pintura.</div>';
    return;
  }

  candidato = orden[0];
  const abs = Math.abs(candidato.delta);
  const pendientes = embarque.barras.filter(b => !registros[b.item]).length;

  $('lcdVacio').classList.add('oculto');
  $('lcdDatos').classList.remove('oculto');
  $('lcdItem').textContent = candidato.item;
  $('lcdDelta').textContent = signo(candidato.delta) + ' g';
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

  if (verificando) {
    if (!pintado) {
      avisos.push(['warn', 'Falta el número pintado',
        `Escribe lo que está pintado en la barra para contrastarlo con el peso.`]);
    } else if (Number(pintado) !== candidato.item) {
      avisos.push(['mal', 'La pintura no cuadra',
        `El peso dice item ${candidato.item}, la barra dice ${pintado}. Una de las dos está mal.`]);
    } else {
      avisos.push(['ok', 'Pintura correcta',
        `Item ${candidato.item}, diferencia de ${fmt(abs)} g contra la lista.`]);
    }
    $('rotuloPintar').classList.add('oculto');
    $('btnConfirmar').disabled = !pintado;
    $('btnConfirmar').textContent = 'Registrar verificación';
  } else {
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
  }

  $('estado').innerHTML = avisos
    .map(([t, tit, txt]) => `<div class="est est-${t}"><b>${tit}</b>${txt}</div>`)
    .join('');
}

function pintarProgreso() {
  const total = embarque.barras.length;
  const hechas = Object.keys(registros).length;
  $('progBarra').style.width = (hechas / total * 100) + '%';

  $('gridItems').innerHTML = embarque.barras.map(b => {
    const r = registros[b.item], v = verificaciones[b.item];
    let clase = '', pie = fmt(b.bruto, 1);
    if (r) {
      pie = signo(r.delta);
      clase = Math.abs(r.delta) > TOL_MAX ? 'alerta' : 'hecho';
      if (v) clase = v.ok ? 'verif' : 'alerta';
    }
    return `<div class="chip ${clase}"><b>${b.item}</b>${pie}</div>`;
  }).join('');

  const sumaLista = embarque.barras.reduce((s, b) => s + b.bruto, 0);
  const sumaFino  = embarque.barras.reduce((s, b) => s + b.puro, 0);
  const sumaMed   = Object.values(registros).reduce((s, r) => s + r.medido, 0);
  const finoHecho = Object.values(registros)
    .reduce((s, r) => s + (embarque.barras.find(b => b.item === r.item)?.puro || 0), 0);
  const nVerif = Object.keys(verificaciones).length;

  $('totales').innerHTML = `
    <div class="tot"><span>Barras asignadas</span><b>${hechas} / ${total}</b></div>
    <div class="tot"><span>Barras verificadas</span><b>${nVerif} / ${total}</b></div>
    <div class="tot"><span>Bruto lista (g)</span><b>${fmt(sumaLista)}</b></div>
    <div class="tot"><span>Bruto pesado (g)</span><b>${fmt(sumaMed)}</b></div>
    <div class="tot"><span>Fino asignado (g)</span><b>${fmt(finoHecho)} / ${fmt(sumaFino)}</b></div>`;
}

function pintarModo() {
  const verificando = modo === 'verificar';
  $('modoAsignar').setAttribute('aria-pressed', String(!verificando));
  $('modoVerificar').setAttribute('aria-pressed', String(verificando));
  $('campoPintado').classList.toggle('oculto', !verificando);
  if (!verificando) $('pintado').value = '';
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
  pintarModo();
  pintarProgreso();
  pintarLcd();
}

// ---------- Foto ----------
async function reducirImagen(file, max = 1600) {
  const bmp = await createImageBitmap(file);
  const escala = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * escala), h = Math.round(bmp.height * escala);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  return new Promise(ok => canvas.toBlob(ok, 'image/jpeg', 0.8));
}

// ---------- Exportación ----------
function descargar(blob, nombre) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = nombre;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function exportarCsv() {
  const cab = ['item', 'bruto_lista_g', 'peso_balanza_g', 'delta_g', 'ley', 'fino_lista_g',
               'asignada_en', 'verif_numero_pintado', 'verif_peso_g', 'verif_ok', 'verificada_en'];
  const filas = embarque.barras.map(b => {
    const r = registros[b.item], v = verificaciones[b.item];
    return [
      b.item, fmt(b.bruto), r ? fmt(r.medido) : '', r ? fmt(r.delta) : '',
      fmt(b.ley), fmt(b.puro), r ? new Date(r.ts).toISOString() : '',
      v?.pintado ?? '', v ? fmt(v.medido) : '', v ? (v.ok ? 'si' : 'NO') : '',
      v ? new Date(v.ts).toISOString() : '',
    ].join(',');
  });
  const csv = '\ufeff' + [cab.join(','), ...filas].join('\r\n');
  descargar(new Blob([csv], { type: 'text/csv' }), `${embarque.nombre}-asignacion.csv`);
}

async function exportarFotos() {
  if (typeof JSZip === 'undefined') {
    alert('Las fotos se comprimen con una librería que se carga con conexión. Conéctate una vez y vuelve a intentarlo.');
    return;
  }
  const zip = new JSZip();
  let n = 0;
  for (const b of embarque.barras) {
    const foto = await leer('fotos', b.item);
    if (foto) { zip.file(`item-${String(b.item).padStart(2, '0')}.jpg`, foto); n++; }
  }
  if (!n) { alert('Todavía no hay fotos guardadas.'); return; }
  descargar(await zip.generateAsync({ type: 'blob' }), `${embarque.nombre}-fotos.zip`);
}

// ---------- Eventos ----------
$('archivoXlsx').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    if (typeof XLSX === 'undefined') throw new Error('La librería de Excel no cargó. Necesitas conexión la primera vez.');
    const barras = parsearLibro(await file.arrayBuffer());
    embarque = { nombre: file.name.replace(/\.xlsx?$/i, ''), cargadoEn: Date.now(), barras };
    registros = {}; verificaciones = {};
    await limpiar('fotos');
    await guardar('kv', 'embarque', embarque);
    await guardar('kv', 'registros', registros);
    await guardar('kv', 'verificaciones', verificaciones);

    const orden = [...barras].sort((a, b) => a.bruto - b.bruto);
    let gapMin = Infinity, par = null;
    const riesgo = [];
    for (let i = 1; i < orden.length; i++) {
      const gap = orden[i].bruto - orden[i - 1].bruto;
      if (gap < gapMin) { gapMin = gap; par = `${orden[i - 1].item}/${orden[i].item}`; }
      if (gap < TOL_AMBIG) riesgo.push(`${orden[i - 1].item}/${orden[i].item} (${fmt(gap)} g)`);
    }
    pintarTodo();
    $('estado').innerHTML = riesgo.length
      ? `<div class="est est-mal"><b>Packing list cargado — con reservas</b>${barras.length} barras. ` +
        `Estos pares no se pueden separar solo por peso: ${riesgo.join(', ')}. ` +
        `Vas a necesitar otra pista para esas barras.</div>`
      : `<div class="est est-ok"><b>Packing list cargado</b>${barras.length} barras. ` +
        `El par más cercano es el ${par}, separado por ${fmt(gapMin)} g. ` +
        `Cada peso identifica una sola barra sin ambigüedad.</div>`;
  } catch (err) {
    $('errorCarga').innerHTML =
      `<div class="est est-mal" style="margin-top:14px"><b>No pude leer el archivo</b>${err.message}</div>`;
  }
  e.target.value = '';
});

$('archivoFoto').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  fotoActual = await reducirImagen(file);
  const img = $('fotoPrev');
  img.src = URL.createObjectURL(fotoActual);
  img.classList.remove('oculto');
  e.target.value = '';
});

$('peso').addEventListener('input', pintarLcd);
$('pintado').addEventListener('input', pintarLcd);

function cambiarModo(nuevo) {
  modo = nuevo;
  $('peso').value = ''; $('pintado').value = '';
  fotoActual = null;
  $('fotoPrev').classList.add('oculto');
  $('fotoPrev').removeAttribute('src');
  pintarTodo();
}
$('modoAsignar').addEventListener('click', () => cambiarModo('asignar'));
$('modoVerificar').addEventListener('click', () => cambiarModo('verificar'));

$('btnConfirmar').addEventListener('click', async () => {
  if (!candidato) return;
  const medido = parseFloat($('peso').value.replace(',', '.'));

  if (modo === 'verificar') {
    const pintado = $('pintado').value.trim();
    verificaciones[candidato.item] = {
      pintado, medido, delta: candidato.delta,
      ok: Number(pintado) === candidato.item && Math.abs(candidato.delta) <= TOL_MAX,
      ts: Date.now(),
    };
    await guardar('kv', 'verificaciones', verificaciones);
  } else {
    registros[candidato.item] = { item: candidato.item, medido, delta: candidato.delta, ts: Date.now() };
    if (fotoActual) await guardar('fotos', candidato.item, fotoActual);
    await guardar('kv', 'registros', registros);
  }

  fotoActual = null;
  $('peso').value = ''; $('pintado').value = '';
  $('fotoPrev').classList.add('oculto');
  $('fotoPrev').removeAttribute('src');
  pintarTodo();
  $('peso').focus();
});

$('btnCsv').addEventListener('click', exportarCsv);
$('btnZip').addEventListener('click', exportarFotos);

$('btnReiniciar').addEventListener('click', async () => {
  if (!confirm('Se borra el embarque, las asignaciones y las fotos de este teléfono. ¿Exportaste ya?')) return;
  embarque = null; registros = {}; verificaciones = {}; fotoActual = null;
  await limpiar('fotos');
  await guardar('kv', 'embarque', null);
  await guardar('kv', 'registros', {});
  await guardar('kv', 'verificaciones', {});
  pintarTodo();
});

// ---------- Arranque ----------
(async () => {
  await abrirDB();
  embarque = (await leer('kv', 'embarque')) || null;
  registros = (await leer('kv', 'registros')) || {};
  verificaciones = (await leer('kv', 'verificaciones')) || {};
  pintarTodo();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
