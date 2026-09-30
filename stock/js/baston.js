// Bastón: lecturas individuales por caravana electrónica.
//
// Es otra capa que el resto de la app. Todo lo demás mide hacienda
// AGREGADA (cuántas cabezas hay en cada bolsillo); acá el animal es de a
// uno. Las dos conviven y no se tocan: esto NUNCA mueve stock — el stock
// se sigue moviendo solo con movimientos.
//
// El bastón exporta un CSV por sesión de trabajo, con columnas fijas
// (caravana visual y electrónica, fecha, hora, peso, ganancias) más las
// que se hayan configurado para esa jornada. Esas últimas no son columnas
// de la base: van a un jsonb, y lo único que se pregunta de ellas es qué
// significa cada código (ver migración 046).
//
// Por ahora esto es una PLANILLA, no un tablero: la idea es mirar los
// datos crudos, filtrarlos y ordenarlos hasta entender qué índices vale la
// pena sacar. Los promedios y porcentajes vienen después, cuando estén
// definidos.
import { supabase } from './supabaseClient.js';
import { ESTABLECIMIENTOS } from './config.js';
import { cargarRodeos, obtenerRodeosCache } from './rodeos.js';

function el(id) {
  return document.getElementById(id);
}

// Los nombres de sesión, las observaciones y los significados los escribe
// el usuario, y varias de estas pantallas se arman con innerHTML.
function esc(texto) {
  const d = document.createElement('div');
  d.textContent = texto ?? '';
  return d.innerHTML;
}

// ─── Lo que el bastón trae de fábrica ───────────────────────────────────
// Estas columnas la app ya sabe qué son, así que nunca las pregunta ni las
// manda al diccionario. El resto de lo que venga en el CSV es "variable".
const COLUMNAS_FIJAS = ['VID', 'EID', 'Date', 'Time',
  'Live Weight (kg)', 'Average Daily Gain (kg/d)', 'Overall Daily Gain (kg/d)'];
// El bastón las exporta siempre pero son notas internas del equipo, no
// datos del animal.
const COLUMNAS_IGNORADAS = ['Draft', 'Notes', 'Status'];

// El bastón exporta la electrónica como "032 010012348838". Podría
// exportarla sin el espacio, o con guiones, y sería el mismo animal: se
// normaliza para que nunca entre dos veces por un separador de diferencia.
function normalizarEid(eid) {
  return (eid || '').replace(/[^0-9]/g, '');
}

// ─── Parseo del CSV ─────────────────────────────────────────────────────
// Hecho a mano y no con una librería: el formato del bastón es plano (sin
// comillas ni comas dentro de los campos), y sumar una dependencia nueva
// al app-shell para esto no se justifica. Si algún día aparecen campos
// entrecomillados, este es el lugar a cambiar.
function parsearCsv(texto) {
  const lineas = texto.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (!lineas.length) throw new Error('El archivo está vacío.');
  const encabezados = lineas[0].split(',').map((h) => h.trim().replace(/^﻿/, ''));
  return lineas.slice(1).map((linea) => {
    const celdas = linea.split(',');
    const fila = {};
    encabezados.forEach((h, i) => { fila[h] = (celdas[i] ?? '').trim(); });
    return fila;
  });
}

function numeroOnull(texto) {
  if (texto === '' || texto === undefined || texto === null) return null;
  const n = Number(String(texto).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

let sesionEnPreparacion = null;
let diccionario = { columnas: [], codigos: [] };

// ─── Interpretar el archivo ─────────────────────────────────────────────

function interpretarArchivo(nombreArchivo, texto) {
  const filas = parsearCsv(texto);
  if (!filas.length) throw new Error('El archivo no tiene ninguna fila de datos.');

  const encabezados = Object.keys(filas[0]);
  // Una columna variable es la que no es fija ni ignorada. Se saltean las
  // que vienen 100% vacías: el bastón exporta siempre todas sus columnas,
  // y guardar vacíos para siempre no le sirve a nadie.
  const columnasVariables = encabezados.filter((h) => (
    h && !COLUMNAS_FIJAS.includes(h) && !COLUMNAS_IGNORADAS.includes(h)
    && filas.some((f) => (f[h] || '').trim() !== '')
  ));

  const avisos = [];
  const porEid = new Map();
  let sinVid = 0;
  let repetidos = 0;

  for (const fila of filas) {
    const eid = normalizarEid(fila.EID);
    if (!eid) continue; // una fila sin electrónica no identifica a nadie
    const vid = (fila.VID || '').trim() || null;
    if (!vid) sinVid += 1;

    const datos = {};
    for (const columna of columnasVariables) {
      const valor = (fila[columna] || '').trim();
      if (valor !== '') datos[columna] = valor;
    }

    const lectura = {
      eid,
      eidOriginal: (fila.EID || '').trim(),
      vid,
      fecha: fila.Date || '',
      hora: fila.Time || '00:00:00',
      peso_kg: numeroOnull(fila['Live Weight (kg)']),
      ganancia_diaria: numeroOnull(fila['Average Daily Gain (kg/d)']),
      ganancia_total_diaria: numeroOnull(fila['Overall Daily Gain (kg/d)']),
      datos,
    };
    // Un animal una sola vez por sesión: si el archivo lo trae dos veces
    // (se lo pasó dos veces por la manga), vale la última lectura.
    if (porEid.has(eid)) repetidos += 1;
    porEid.set(eid, lectura);
  }

  const lecturas = [...porEid.values()];
  if (!lecturas.length) throw new Error('No encontré ninguna caravana electrónica en el archivo.');

  const fechas = [...new Set(lecturas.map((l) => l.fecha).filter(Boolean))].sort();
  if (fechas.length > 1) {
    avisos.push(`El archivo tiene ${fechas.length} fechas distintas (${fechas[0]} a ${fechas[fechas.length - 1]}). Se toma la primera como fecha de la sesión.`);
  }
  if (sinVid) avisos.push(`${sinVid} animal(es) sin caravana visual. Entran igual, la electrónica alcanza.`);
  if (repetidos) avisos.push(`${repetidos} animal(es) venían repetidos. Se guarda la última lectura de cada uno.`);

  return {
    lecturas,
    columnasVariables,
    avisos,
    fecha: fechas[0] || new Date().toISOString().slice(0, 10),
    nombre: nombreArchivo.replace(/\.csv$/i, '').trim(),
    archivo: nombreArchivo,
  };
}

// ─── Diccionario ────────────────────────────────────────────────────────

async function cargarDiccionario() {
  const [columnas, codigos] = await Promise.all([
    supabase.from('columnas_baston').select('*'),
    supabase.from('codigos_baston').select('*'),
  ]);
  diccionario = { columnas: columnas.data || [], codigos: codigos.data || [] };
  return diccionario;
}

function columnaConocida(columna) {
  return diccionario.columnas.find((c) => c.columna === columna) || null;
}

function codigoConocido(columna, codigo) {
  return diccionario.codigos.find((c) => c.columna === columna && c.codigo === codigo) || null;
}

function significadoDe(columna, codigo) {
  return codigoConocido(columna, codigo)?.significado || codigo;
}

// Una columna cuyos valores son TODOS números es una medida (peso,
// condición corporal): no hay nada que traducir. Se detecta sola en vez de
// preguntarlo — preguntar "¿qué significa 3.5?" por cada valor distinto no
// tiene ningún sentido, y preguntar de más al cargar molesta.
function esMedida(valores) {
  return valores.length > 0 && valores.every((v) => numeroOnull(v) !== null);
}

// Lo ÚNICO que se pregunta: qué significa un código que no se conoce.
function codigosSinTraducir(previo) {
  const faltan = [];
  for (const columna of previo.columnasVariables) {
    const valores = [...new Set(previo.lecturas.map((l) => l.datos[columna]).filter(Boolean))];
    if (esMedida(valores)) continue;
    for (const codigo of valores) {
      if (!codigoConocido(columna, codigo)) faltan.push({ columna, codigo });
    }
  }
  return faltan;
}

// Las columnas se registran solas, sin preguntar nada: el nombre que trae
// el bastón ya alcanza para mostrarlas, y el tipo se deduce de los datos.
function columnasParaRegistrar(previo) {
  return previo.columnasVariables
    .filter((columna) => !columnaConocida(columna))
    .map((columna) => {
      const valores = [...new Set(previo.lecturas.map((l) => l.datos[columna]).filter(Boolean))];
      return { columna, descripcion: columna, tipo: esMedida(valores) ? 'medida' : 'codigo' };
    });
}

// ─── Pantalla 1: subir ──────────────────────────────────────────────────

function mensajeLectura(texto, tipo) {
  const contenedor = el('baston-lectura-mensaje');
  contenedor.textContent = texto;
  contenedor.className = `mensaje ${tipo || ''}`;
}

async function alElegirArchivo(evento) {
  const archivo = evento.target.files?.[0];
  el('baston-previo').classList.add('oculto');
  el('baston-guardar-mensaje').textContent = '';
  if (!archivo) return;

  mensajeLectura('Leyendo el archivo...', '');
  try {
    const texto = await archivo.text();
    sesionEnPreparacion = interpretarArchivo(archivo.name, texto);
  } catch (error) {
    sesionEnPreparacion = null;
    mensajeLectura('No pude leer el archivo: ' + error.message, 'error');
    return;
  }

  try {
    await cargarDiccionario();
  } catch (error) {
    mensajeLectura('No pude consultar el diccionario de códigos (¿sin conexión?): ' + error.message, 'error');
    return;
  }

  mensajeLectura('', '');
  renderPrevio();
}

function renderPrevio() {
  const previo = sesionEnPreparacion;
  if (!previo) return;
  el('baston-previo').classList.remove('oculto');

  const conVid = previo.lecturas.filter((l) => l.vid).length;
  const conPeso = previo.lecturas.filter((l) => l.peso_kg !== null).length;
  const partes = [`<strong>${previo.lecturas.length}</strong> animales`, `${conVid} con caravana visual`];
  if (conPeso) partes.push(`${conPeso} con peso`);
  if (previo.columnasVariables.length) partes.push(previo.columnasVariables.map(esc).join(', '));
  el('baston-previo-resumen').innerHTML = `<div class="ayuda">${partes.join(' · ')}</div>`;

  el('baston-previo-avisos').innerHTML = previo.avisos.length
    ? previo.avisos.map((a) => `<div class="mensaje advertencia">${esc(a)}</div>`).join('')
    : '';

  el('baston-sesion-nombre').value = previo.nombre;
  el('baston-sesion-fecha').value = previo.fecha;
  renderCodigosNuevos();
}

function renderCodigosNuevos() {
  const bloque = el('baston-desconocidos');
  const lista = el('baston-desconocidos-lista');
  lista.innerHTML = '';
  const faltan = codigosSinTraducir(sesionEnPreparacion);
  bloque.classList.toggle('oculto', !faltan.length);
  if (!faltan.length) return;

  for (const { columna, codigo } of faltan) {
    const cuantos = sesionEnPreparacion.lecturas.filter((l) => l.datos[columna] === codigo).length;
    const div = document.createElement('div');
    div.className = 'baston-falta';
    div.innerHTML = `
      <label><span class="baston-falta-titulo">${esc(columna)} · <strong>${esc(codigo)}</strong>
        <span class="ayuda">(${cuantos} animales)</span></span>
        <input type="text" data-columna="${esc(columna)}" data-codigo="${esc(codigo)}"
               placeholder="¿Qué significa?">
      </label>`;
    lista.appendChild(div);
  }
}

// Se pueden dejar en blanco: un código sin traducir se muestra tal cual
// vino, que es mejor que trabar la carga de la sesión entera.
function leerTraducciones() {
  return [...el('baston-desconocidos-lista').querySelectorAll('input[data-codigo]')]
    .map((input) => ({
      columna: input.dataset.columna,
      codigo: input.dataset.codigo,
      significado: input.value.trim(),
    }))
    .filter((c) => c.significado);
}

function mensajeGuardar(texto, tipo) {
  const contenedor = el('baston-guardar-mensaje');
  contenedor.textContent = texto;
  contenedor.className = `mensaje ${tipo || ''}`;
}

async function guardarSesion() {
  const previo = sesionEnPreparacion;
  if (!previo) return;
  if (!navigator.onLine) { mensajeGuardar('Necesitás conexión para subir una sesión.', 'error'); return; }

  const nombre = el('baston-sesion-nombre').value.trim();
  const fecha = el('baston-sesion-fecha').value;
  if (!nombre) { mensajeGuardar('Poné un nombre para la sesión.', 'error'); return; }
  if (!fecha) { mensajeGuardar('Falta la fecha del trabajo.', 'error'); return; }

  mensajeGuardar('Guardando...', '');
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) { mensajeGuardar('No hay sesión activa.', 'error'); return; }

  // 1) El diccionario primero: si algo falla después, al menos las
  //    traducciones quedaron y no hay que volver a escribirlas.
  const columnasNuevas = columnasParaRegistrar(previo);
  if (columnasNuevas.length) {
    const { error } = await supabase.from('columnas_baston').upsert(columnasNuevas, { onConflict: 'columna' });
    if (error) { mensajeGuardar('No pude registrar las columnas: ' + error.message, 'error'); return; }
  }
  const traducciones = leerTraducciones();
  if (traducciones.length) {
    const { error } = await supabase.from('codigos_baston').upsert(traducciones, { onConflict: 'columna,codigo' });
    if (error) { mensajeGuardar('No pude guardar las traducciones: ' + error.message, 'error'); return; }
  }

  // 2) La sesión. El unique (nombre, fecha) frena una subida repetida.
  const { data: sesion, error: errorSesion } = await supabase.from('sesiones_baston').insert({
    nombre,
    archivo: previo.archivo,
    fecha,
    establecimiento_id: el('baston-sesion-establecimiento').value || null,
    rodeo_id: el('baston-sesion-rodeo').value || null,
    observaciones: el('baston-sesion-observaciones').value.trim() || null,
    cantidad_lecturas: previo.lecturas.length,
    subido_por: session.user.id,
  }).select().single();
  if (errorSesion) {
    mensajeGuardar(errorSesion.code === '23505'
      ? `Ya hay una sesión llamada "${nombre}" con fecha ${fecha}. ¿La subiste dos veces?`
      : 'No pude crear la sesión: ' + errorSesion.message, 'error');
    return;
  }

  // 3) Los animales: los que ya existen se actualizan (la visual puede
  //    haber cambiado), los nuevos se crean.
  const eids = previo.lecturas.map((l) => l.eid);
  const { data: existentes, error: errorBuscar } = await supabase
    .from('animales').select('id, eid').in('eid', eids);
  if (errorBuscar) { mensajeGuardar('No pude consultar los animales: ' + errorBuscar.message, 'error'); return; }
  const idPorEid = new Map((existentes || []).map((a) => [a.eid, a.id]));

  const nuevos = previo.lecturas.filter((l) => !idPorEid.has(l.eid)).map((l) => ({
    eid: l.eid,
    eid_original: l.eidOriginal,
    vid: l.vid,
    primera_lectura_at: `${l.fecha}T${l.hora}`,
    ultima_lectura_at: `${l.fecha}T${l.hora}`,
  }));
  if (nuevos.length) {
    const { data, error } = await supabase.from('animales').insert(nuevos).select('id, eid');
    if (error) { mensajeGuardar('No pude dar de alta los animales nuevos: ' + error.message, 'error'); return; }
    for (const a of data) idPorEid.set(a.eid, a.id);
  }

  // 4) Las lecturas.
  const lecturas = previo.lecturas.map((l) => ({
    sesion_id: sesion.id,
    animal_id: idPorEid.get(l.eid),
    vid: l.vid,
    leido_at: `${l.fecha}T${l.hora}`,
    peso_kg: l.peso_kg,
    ganancia_diaria: l.ganancia_diaria,
    ganancia_total_diaria: l.ganancia_total_diaria,
    datos: l.datos,
  }));
  const { error: errorLecturas } = await supabase.from('lecturas_baston').insert(lecturas);
  if (errorLecturas) {
    mensajeGuardar(`Se creó la sesión pero no pude guardar las lecturas: ${errorLecturas.message}. Borrá la sesión y volvé a subirla.`, 'error');
    return;
  }

  // 5) Los que ya existían: al día con la visual y la última lectura.
  for (const l of previo.lecturas) {
    if (nuevos.some((n) => n.eid === l.eid)) continue;
    await supabase.from('animales')
      .update({ vid: l.vid, ultima_lectura_at: `${l.fecha}T${l.hora}` })
      .eq('eid', l.eid);
  }

  mensajeGuardar(`✅ Sesión "${nombre}" guardada: ${lecturas.length} animales (${nuevos.length} nuevos).`, 'ok');
  sesionEnPreparacion = null;
  el('baston-archivo').value = '';
  el('baston-previo').classList.add('oculto');
  await cargarDatos();
}

// ─── Pantalla 2: los datos, como planilla ───────────────────────────────
// Una fila por lectura, todas las sesiones juntas o una sola. Se puede
// ordenar por cualquier columna y filtrar escribiendo. Es a propósito una
// planilla y no un tablero: primero hay que poder mirar los datos crudos.

let lecturasCache = [];
let columnasVariablesCache = [];
let orden = { campo: 'fecha', ascendente: false };

const COLUMNAS_TABLA = [
  { campo: 'fecha', titulo: 'Fecha' },
  { campo: 'sesion', titulo: 'Sesión' },
  { campo: 'hora', titulo: 'Hora' },
  { campo: 'vid', titulo: 'Caravana', clickeable: true },
  { campo: 'eid', titulo: 'Electrónica', clickeable: true },
  { campo: 'peso_kg', titulo: 'Peso', numerica: true },
  { campo: 'ganancia_diaria', titulo: 'Gan. diaria', numerica: true },
];

async function cargarDatos() {
  const [{ data: sesiones }, { data: lecturas, error }] = await Promise.all([
    supabase.from('sesiones_baston').select('*').order('fecha', { ascending: false }),
    supabase.from('historial_lecturas_baston').select('*'),
    cargarDiccionario(),
  ]);
  if (error) {
    el('baston-datos-tabla').innerHTML = `<div class="mensaje error">No pude cargar los datos: ${esc(error.message)}</div>`;
    return;
  }

  lecturasCache = (lecturas || []).map((l) => ({
    ...l,
    hora: (l.leido_at || '').slice(11, 19),
    // Las columnas propias se aplanan como campos más, así ordenar y
    // filtrar funciona igual para todas.
    ...Object.fromEntries(Object.entries(l.datos || {})
      .map(([columna, valor]) => [`dato_${columna}`, significadoDe(columna, valor)])),
  }));
  columnasVariablesCache = [...new Set((lecturas || []).flatMap((l) => Object.keys(l.datos || {})))];

  const select = el('baston-datos-sesion');
  const previo = select.value;
  select.innerHTML = '<option value="">Todas las sesiones</option>';
  for (const s of sesiones || []) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = `${s.fecha} — ${s.nombre} (${s.cantidad_lecturas})`;
    select.appendChild(opt);
  }
  select.value = previo;
  renderTablaDatos();
}

function columnasDeLaTabla() {
  return [
    ...COLUMNAS_TABLA,
    ...columnasVariablesCache.map((c) => ({ campo: `dato_${c}`, titulo: c })),
  ];
}

function filasFiltradas() {
  const sesionId = el('baston-datos-sesion').value;
  const texto = el('baston-datos-filtro').value.trim().toLowerCase();
  let filas = lecturasCache;
  if (sesionId) filas = filas.filter((f) => f.sesion_id === sesionId);
  if (texto) {
    const columnas = columnasDeLaTabla().map((c) => c.campo);
    filas = filas.filter((f) => columnas.some((c) => String(f[c] ?? '').toLowerCase().includes(texto)));
  }
  const columna = columnasDeLaTabla().find((c) => c.campo === orden.campo);
  return [...filas].sort((a, b) => {
    const av = a[orden.campo], bv = b[orden.campo];
    if (av === null || av === undefined || av === '') return 1;  // los vacíos, al final
    if (bv === null || bv === undefined || bv === '') return -1;
    const cmp = columna?.numerica ? Number(av) - Number(bv) : String(av).localeCompare(String(bv), 'es');
    return orden.ascendente ? cmp : -cmp;
  });
}

function renderTablaDatos() {
  const contenedor = el('baston-datos-tabla');
  const columnas = columnasDeLaTabla();
  const filas = filasFiltradas();

  el('baston-datos-cuenta').textContent = filas.length === lecturasCache.length
    ? `${filas.length} lecturas`
    : `${filas.length} de ${lecturasCache.length} lecturas`;

  if (!lecturasCache.length) {
    contenedor.innerHTML = '<div class="ayuda">Todavía no subiste ninguna sesión.</div>';
    return;
  }

  const thead = columnas.map((c) => {
    const flecha = orden.campo === c.campo ? (orden.ascendente ? ' ▲' : ' ▼') : '';
    return `<th class="baston-th" data-campo="${esc(c.campo)}">${esc(c.titulo)}${flecha}</th>`;
  }).join('');

  const tbody = filas.map((f) => columnas.map((c) => {
    const valor = f[c.campo];
    const texto = valor === null || valor === undefined || valor === '' ? '—' : esc(String(valor));
    return c.clickeable && valor
      ? `<td><button type="button" class="baston-link" data-animal="${esc(f.animal_id)}">${texto}</button></td>`
      : `<td>${texto}</td>`;
  }).join('')).map((celdas) => `<tr>${celdas}</tr>`).join('');

  contenedor.innerHTML = `<table class="tabla"><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table>`;

  contenedor.querySelectorAll('.baston-th').forEach((th) => {
    th.addEventListener('click', () => {
      const campo = th.dataset.campo;
      orden = { campo, ascendente: orden.campo === campo ? !orden.ascendente : true };
      renderTablaDatos();
    });
  });
  contenedor.querySelectorAll('.baston-link').forEach((boton) => {
    boton.addEventListener('click', () => verAnimal(boton.dataset.animal));
  });
}

// ─── Pantalla 3: un animal ──────────────────────────────────────────────

async function verAnimal(animalId) {
  mostrarSubseccion('animal');
  // El desplegable se llena solo al entrar a la solapa: hay que esperarlo
  // antes de marcarlo, o llegando desde la tabla queda en "Elegir animal".
  await cargarSelectAnimales();
  el('baston-animal-select').value = animalId;
  const destino = el('baston-animal-resultado');
  destino.innerHTML = '<div class="ayuda">Cargando...</div>';

  const [{ data: animales }, { data: lecturas }] = await Promise.all([
    supabase.from('animales').select('*').eq('id', animalId),
    supabase.from('historial_lecturas_baston').select('*').eq('animal_id', animalId),
  ]);
  const animal = (animales || [])[0];
  if (!animal) { destino.innerHTML = '<div class="ayuda">No encontré ese animal.</div>'; return; }
  destino.innerHTML = htmlHistoriaAnimal(animal, lecturas || []);
}

function htmlHistoriaAnimal(animal, lecturas) {
  const columnas = [...new Set(lecturas.flatMap((l) => Object.keys(l.datos || {})))];
  const encabezados = ['Fecha', 'Sesión', 'Visual', 'Peso', ...columnas];
  const filas = [...lecturas]
    .sort((a, b) => String(a.leido_at).localeCompare(String(b.leido_at)))
    .map((l) => {
      const celdas = [
        l.fecha, esc(l.sesion || ''), l.vid ? esc(l.vid) : '—', l.peso_kg ?? '—',
        ...columnas.map((c) => (l.datos?.[c] ? esc(significadoDe(c, l.datos[c])) : '—')),
      ];
      return `<tr>${celdas.map((c) => `<td>${c}</td>`).join('')}</tr>`;
    }).join('');

  return `
    <div class="baston-bloque">
      <h3>Caravana ${animal.vid ? esc(animal.vid) : '(sin visual)'}</h3>
      <div class="ayuda">Electrónica: ${esc(animal.eid_original || animal.eid)} · ${lecturas.length} paso(s) por la manga</div>
      <table class="tabla">
        <thead><tr>${encabezados.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
        <tbody>${filas || `<tr><td colspan="${encabezados.length}">Sin lecturas.</td></tr>`}</tbody>
      </table>
    </div>`;
}

async function cargarSelectAnimales() {
  const { data, error } = await supabase.from('animales').select('id, vid, eid, eid_original').order('vid');
  const select = el('baston-animal-select');
  select.innerHTML = '<option value="">Elegir animal...</option>';
  if (error) return;
  for (const a of data || []) {
    const opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = a.vid ? `${a.vid} — ${a.eid_original || a.eid}` : `(sin visual) — ${a.eid_original || a.eid}`;
    select.appendChild(opt);
  }
}

async function buscarAnimalEscrito() {
  const texto = el('baston-animal-buscar').value.trim();
  const destino = el('baston-animal-resultado');
  if (!texto) { destino.innerHTML = ''; return; }
  destino.innerHTML = '<div class="ayuda">Buscando...</div>';

  // Se busca por las dos: se puede escribir la visual (lo que se lee en la
  // caravana) o la electrónica entera, con separadores o sin ellos.
  const eid = normalizarEid(texto);
  const { data, error } = await supabase.from('animales').select('id')
    .or(`vid.eq.${texto}${eid ? `,eid.eq.${eid}` : ''}`);
  if (error) {
    destino.innerHTML = `<div class="mensaje error">No pude buscar: ${esc(error.message)}</div>`;
    return;
  }
  if (!data.length) {
    destino.innerHTML = '<div class="ayuda">No encontré ningún animal con esa caravana.</div>';
    return;
  }
  await verAnimal(data[0].id);
}

// ─── Armado de la pantalla ──────────────────────────────────────────────

function mostrarSubseccion(nombre) {
  for (const seccion of document.querySelectorAll('.baston-seccion')) {
    seccion.classList.toggle('oculto', seccion.id !== `baston-${nombre}`);
  }
  document.querySelectorAll('.baston-tab').forEach((boton) => {
    boton.classList.toggle('activo', boton.dataset.subseccion === nombre);
  });
  if (nombre === 'datos') cargarDatos();
}

function poblarSelectoresDeContexto() {
  const establecimientos = el('baston-sesion-establecimiento');
  establecimientos.innerHTML = '<option value="">Sin establecimiento</option>';
  for (const e of ESTABLECIMIENTOS) {
    const opt = document.createElement('option');
    opt.value = e.id;
    opt.textContent = e.nombre;
    establecimientos.appendChild(opt);
  }

  const rodeos = el('baston-sesion-rodeo');
  rodeos.innerHTML = '<option value="">Sin rodeo</option>';
  for (const r of obtenerRodeosCache()) {
    const opt = document.createElement('option');
    opt.value = r.id;
    opt.textContent = r.codigo;
    rodeos.appendChild(opt);
  }
}

export async function refrescarBaston() {
  await cargarRodeos();
  poblarSelectoresDeContexto();
}

export function initBaston() {
  document.querySelectorAll('.baston-tab').forEach((boton) => {
    boton.addEventListener('click', () => {
      mostrarSubseccion(boton.dataset.subseccion);
      if (boton.dataset.subseccion === 'animal') cargarSelectAnimales();
    });
  });
  el('baston-archivo').addEventListener('change', (evento) => {
    alElegirArchivo(evento).catch((error) => {
      console.error('Falló al leer el archivo del bastón:', error);
      mensajeLectura('No se pudo leer el archivo: ' + error.message, 'error');
    });
  });
  // Envuelto: guardarSesion encadena varias consultas, y si alguna revienta
  // de una forma no prevista el cartel se quedaba en "Guardando..." para
  // siempre, sin decir nada.
  el('baston-guardar').addEventListener('click', async () => {
    try {
      await guardarSesion();
    } catch (error) {
      console.error('Falló al guardar la sesión del bastón:', error);
      mensajeGuardar('No se pudo guardar: ' + error.message, 'error');
    }
  });

  el('baston-datos-sesion').addEventListener('change', renderTablaDatos);
  el('baston-datos-filtro').addEventListener('input', renderTablaDatos);

  el('baston-animal-select').addEventListener('change', (e) => {
    if (e.target.value) verAnimal(e.target.value);
  });
  el('baston-animal-boton').addEventListener('click', () => {
    buscarAnimalEscrito().catch((error) => {
      el('baston-animal-resultado').innerHTML = `<div class="mensaje error">No se pudo buscar: ${esc(error.message)}</div>`;
    });
  });
  el('baston-animal-buscar').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); buscarAnimalEscrito(); }
  });

  poblarSelectoresDeContexto();
}
