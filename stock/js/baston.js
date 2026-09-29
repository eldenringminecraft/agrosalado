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
// de la base: van a un jsonb, y su significado vive en un diccionario que
// se pregunta una sola vez (ver migración 046).
import { supabase } from './supabaseClient.js';
import { ESTABLECIMIENTOS } from './config.js';
import { getEstado } from './auth.js';
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
const COLUMNAS_FIJAS = {
  VID: 'vid',
  EID: 'eid',
  Date: 'fecha',
  Time: 'hora',
  'Live Weight (kg)': 'peso_kg',
  'Average Daily Gain (kg/d)': 'ganancia_diaria',
  'Overall Daily Gain (kg/d)': 'ganancia_total_diaria',
};
// Columnas que el bastón exporta siempre pero que no guardamos: son notas
// internas del equipo, no datos del animal.
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
  const n = Number(texto);
  return Number.isFinite(n) ? n : null;
}

// Lo que se leyó del archivo, ya interpretado, esperando confirmación. No
// se guarda nada hasta que se toca "Guardar sesión".
let sesionEnPreparacion = null;
let diccionario = { columnas: [], codigos: [] };

// ─── Interpretar el archivo ─────────────────────────────────────────────

// Devuelve { lecturas, columnasVariables, avisos, fecha, nombre }.
function interpretarArchivo(nombreArchivo, texto) {
  const filas = parsearCsv(texto);
  if (!filas.length) throw new Error('El archivo no tiene ninguna fila de datos.');

  const encabezados = Object.keys(filas[0]);
  // Una columna variable es la que no es fija ni ignorada. Además se saltean
  // las que vienen 100% vacías: el bastón exporta siempre todas sus
  // columnas, y guardar vacíos para siempre no sirve a nadie.
  const columnasVariables = encabezados.filter((h) => (
    h && !COLUMNAS_FIJAS[h] && !COLUMNAS_IGNORADAS.includes(h)
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
  if (sinVid) {
    avisos.push(`${sinVid} animal(es) sin caravana visual. Entran igual —la electrónica alcanza— pero convendría ponerles una.`);
  }
  if (repetidos) {
    avisos.push(`${repetidos} animal(es) venían repetidos en el archivo. Se guarda la última lectura de cada uno.`);
  }
  if (filas.length !== lecturas.length + repetidos) {
    avisos.push(`${filas.length - lecturas.length - repetidos} fila(s) sin caravana electrónica quedaron afuera.`);
  }

  return {
    lecturas,
    columnasVariables,
    avisos,
    fecha: fechas[0] || new Date().toISOString().slice(0, 10),
    nombre: nombreArchivo.replace(/\.csv$/i, '').trim(),
    archivo: nombreArchivo,
  };
}

// ─── Diccionario: qué falta traducir ────────────────────────────────────

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

// Qué hay que preguntar antes de poder guardar: las columnas que no están
// en el diccionario, y —solo para las de tipo 'codigo'— sus valores nuevos.
// Una columna de tipo 'medida' (ej. condición corporal) no pregunta por
// cada valor: sería interrogar por cada número distinto.
function loQueFalta(previo) {
  const faltan = [];
  for (const columna of previo.columnasVariables) {
    const conocida = columnaConocida(columna);
    if (!conocida) faltan.push({ clase: 'columna', columna });
    // Una columna nueva se pregunta JUNTO con sus códigos, en la misma
    // pasada: si solo se preguntara la columna, la primera sesión —la que
    // más importa— entraría con los códigos sin traducir y habría que
    // esperar a la segunda para que los pida. Si al final se marca como
    // "es una medida", esas preguntas se esconden solas.
    const esDeCodigos = !conocida || conocida.tipo === 'codigo';
    if (!esDeCodigos) continue;
    const valores = [...new Set(previo.lecturas.map((l) => l.datos[columna]).filter(Boolean))];
    for (const codigo of valores) {
      if (!codigoConocido(columna, codigo)) faltan.push({ clase: 'codigo', columna, codigo });
    }
  }
  return faltan;
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
  const partes = [
    `<strong>${previo.lecturas.length}</strong> animales leídos`,
    `${conVid} con caravana visual`,
  ];
  if (conPeso) partes.push(`<strong>${conPeso}</strong> con peso`);
  if (previo.columnasVariables.length) {
    partes.push(`columnas propias de esta sesión: ${previo.columnasVariables.map(esc).join(', ')}`);
  }
  el('baston-previo-resumen').innerHTML = `<div class="ayuda">${partes.join(' · ')}</div>`;

  el('baston-previo-avisos').innerHTML = previo.avisos.length
    ? previo.avisos.map((a) => `<div class="mensaje advertencia">${esc(a)}</div>`).join('')
    : '';

  el('baston-sesion-nombre').value = previo.nombre;
  el('baston-sesion-fecha').value = previo.fecha;
  renderDesconocidos();
}

// Una tarjeta por cosa que falta definir. Nada se guarda suelto: se manda
// todo junto al confirmar la sesión, así una subida cancelada no deja el
// diccionario a medio llenar.
function renderDesconocidos() {
  const bloque = el('baston-desconocidos');
  const lista = el('baston-desconocidos-lista');
  lista.innerHTML = '';
  const faltan = loQueFalta(sesionEnPreparacion);
  bloque.classList.toggle('oculto', !faltan.length);
  if (!faltan.length) return;

  for (const falta of faltan) {
    const div = document.createElement('div');
    div.className = 'baston-falta';
    div.dataset.columna = falta.columna;
    div.dataset.clase = falta.clase;
    if (falta.clase === 'columna') {
      const cuantos = sesionEnPreparacion.lecturas.filter((l) => l.datos[falta.columna]).length;
      div.innerHTML = `
        <div class="baston-falta-titulo">Columna nueva: <strong>${esc(falta.columna)}</strong>
          <span class="ayuda">(${cuantos} animales la traen)</span></div>
        <label>¿Qué es?
          <input type="text" data-clase="columna" data-columna="${esc(falta.columna)}"
                 placeholder="Ej: Diagnóstico de gestación">
        </label>
        <label>¿Cómo se lee?
          <select data-tipo-de="${esc(falta.columna)}">
            <option value="codigo">Son códigos a traducir (P IATF, V/RE SINCRO...)</option>
            <option value="medida">Es una medida (un número)</option>
          </select>
        </label>`;
    } else {
      const cuantos = sesionEnPreparacion.lecturas.filter((l) => l.datos[falta.columna] === falta.codigo).length;
      div.innerHTML = `
        <div class="baston-falta-titulo">${esc(falta.columna)} · código <strong>${esc(falta.codigo)}</strong>
          <span class="ayuda">(${cuantos} animales)</span></div>
        <label>¿Qué significa?
          <input type="text" data-clase="codigo" data-columna="${esc(falta.columna)}" data-codigo="${esc(falta.codigo)}"
                 placeholder="Ej: Preñada por IATF">
        </label>
        <label>Para los reportes
          <select data-cuenta-de="${esc(falta.columna)}|${esc(falta.codigo)}">
            <option value="">No cuenta para el % de preñez</option>
            <option value="prenada">Cuenta como PREÑADA</option>
            <option value="vacia">Cuenta como VACÍA</option>
          </select>
        </label>`;
    }
    lista.appendChild(div);
  }

  // Marcar una columna como "medida" esconde las preguntas por cada uno de
  // sus valores: interrogar por cada número distinto no tiene sentido.
  const aplicarTipo = (select) => {
    const columna = select.dataset.tipoDe;
    const esMedida = select.value === 'medida';
    lista.querySelectorAll(`.baston-falta[data-clase="codigo"]`).forEach((tarjeta) => {
      if (tarjeta.dataset.columna === columna) tarjeta.classList.toggle('oculto', esMedida);
    });
  };
  lista.querySelectorAll('select[data-tipo-de]').forEach((select) => {
    select.addEventListener('change', () => aplicarTipo(select));
    aplicarTipo(select);
  });
}

// Lee las tarjetas y devuelve lo que hay que insertar en el diccionario,
// o un error si quedó algo sin responder.
function leerDefiniciones() {
  const columnas = [];
  const codigos = [];
  for (const input of el('baston-desconocidos-lista').querySelectorAll('input[data-clase]')) {
    // Las de una columna marcada como medida están escondidas: no se piden
    // ni se guardan.
    if (input.closest('.baston-falta').classList.contains('oculto')) continue;
    const texto = input.value.trim();
    if (!texto) {
      return { error: input.dataset.clase === 'columna'
        ? `Falta decir qué es la columna "${input.dataset.columna}".`
        : `Falta decir qué significa el código "${input.dataset.codigo}".` };
    }
    if (input.dataset.clase === 'columna') {
      const tipo = el('baston-desconocidos-lista')
        .querySelector(`select[data-tipo-de="${CSS.escape(input.dataset.columna)}"]`)?.value || 'codigo';
      columnas.push({ columna: input.dataset.columna, descripcion: texto, tipo });
    } else {
      const cuenta = el('baston-desconocidos-lista')
        .querySelector(`select[data-cuenta-de="${CSS.escape(input.dataset.columna + '|' + input.dataset.codigo)}"]`)?.value || '';
      codigos.push({
        columna: input.dataset.columna,
        codigo: input.dataset.codigo,
        significado: texto,
        cuenta_como: cuenta || null,
      });
    }
  }
  return { columnas, codigos };
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

  const definiciones = leerDefiniciones();
  if (definiciones.error) { mensajeGuardar(definiciones.error, 'error'); return; }

  mensajeGuardar('Guardando...', '');
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) { mensajeGuardar('No hay sesión activa.', 'error'); return; }

  // 1) El diccionario primero: si algo falla después, al menos las
  //    traducciones quedaron y no hay que volver a escribirlas.
  if (definiciones.columnas.length) {
    const { error } = await supabase.from('columnas_baston').upsert(definiciones.columnas, { onConflict: 'columna' });
    if (error) { mensajeGuardar('No pude guardar las columnas nuevas: ' + error.message, 'error'); return; }
  }
  if (definiciones.codigos.length) {
    const { error } = await supabase.from('codigos_baston').upsert(definiciones.codigos, { onConflict: 'columna,codigo' });
    if (error) { mensajeGuardar('No pude guardar los códigos nuevos: ' + error.message, 'error'); return; }
  }

  // 2) La sesión. El unique (nombre, fecha) es el que frena una subida
  //    repetida del mismo archivo.
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
  await cargarSesiones();
}

// ─── Pantalla 2: sesiones y su análisis ─────────────────────────────────

let sesionesCache = [];

async function cargarSesiones() {
  const { data, error } = await supabase.from('sesiones_baston').select('*').order('fecha', { ascending: false });
  const contenedor = el('baston-sesiones-lista');
  if (error) {
    contenedor.innerHTML = `<div class="mensaje error">No pude cargar las sesiones: ${esc(error.message)}</div>`;
    return;
  }
  sesionesCache = data || [];
  if (!sesionesCache.length) {
    contenedor.innerHTML = '<div class="ayuda">Todavía no subiste ninguna sesión.</div>';
    return;
  }
  contenedor.innerHTML = '';
  for (const s of sesionesCache) {
    const fila = document.createElement('div');
    fila.className = 'fila-cliente';
    const texto = document.createElement('span');
    texto.textContent = `${s.fecha} — ${s.nombre} (${s.cantidad_lecturas} animales)`;
    fila.appendChild(texto);
    const boton = document.createElement('button');
    boton.type = 'button';
    boton.className = 'boton-secundario';
    boton.textContent = 'Ver análisis';
    boton.addEventListener('click', () => verAnalisisSesion(s));
    fila.appendChild(boton);
    contenedor.appendChild(fila);
  }
}

function significadoDe(columna, codigo) {
  return codigoConocido(columna, codigo)?.significado || codigo;
}

function promedio(numeros) {
  if (!numeros.length) return null;
  return numeros.reduce((a, b) => a + b, 0) / numeros.length;
}

function unDecimal(n) {
  return n === null ? '—' : n.toLocaleString('es-AR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

async function verAnalisisSesion(sesion) {
  const destino = el('baston-sesion-detalle');
  destino.classList.remove('oculto');
  destino.innerHTML = '<div class="ayuda">Cargando...</div>';

  const [{ data: lecturas, error }] = await Promise.all([
    supabase.from('lecturas_baston').select('*').eq('sesion_id', sesion.id),
    cargarDiccionario(),
  ]);
  if (error) {
    destino.innerHTML = `<div class="mensaje error">No pude cargar las lecturas: ${esc(error.message)}</div>`;
    return;
  }
  destino.innerHTML = htmlAnalisis(sesion, lecturas || []);
}

function htmlAnalisis(sesion, lecturas) {
  const total = lecturas.length;
  if (!total) return '<div class="ayuda">Esta sesión no tiene lecturas.</div>';

  const conVid = lecturas.filter((l) => l.vid).length;
  const pesos = lecturas.map((l) => (l.peso_kg === null ? null : Number(l.peso_kg))).filter((p) => p !== null);
  const horas = lecturas.map((l) => l.leido_at).sort();
  const desde = new Date(horas[0]);
  const hasta = new Date(horas[horas.length - 1]);
  const minutos = Math.round((hasta - desde) / 60000);

  const partes = [`<h3>${esc(sesion.nombre)} — ${sesion.fecha}</h3>`];

  const cabecera = [`<strong>${total}</strong> animales leídos`, `${conVid} con caravana visual`];
  if (conVid < total) cabecera.push(`<strong>${total - conVid} sin visual</strong> ⚠️`);
  partes.push(`<div class="ayuda">${cabecera.join(' · ')}</div>`);

  if (pesos.length) {
    partes.push(`<div class="baston-bloque"><strong>Peso</strong> — promedio ${unDecimal(promedio(pesos))} kg · `
      + `mínimo ${unDecimal(Math.min(...pesos))} · máximo ${unDecimal(Math.max(...pesos))} `
      + `<span class="ayuda">(${pesos.length} de ${total} pesados)</span></div>`);
  }

  // Una sección por columna propia de la sesión. Las de tipo 'medida' dan
  // promedio/mínimo/máximo; las de código, el reparto — y cruzado con el
  // peso cuando hay, que es lo que no se puede ver de ninguna otra forma.
  const columnas = [...new Set(lecturas.flatMap((l) => Object.keys(l.datos || {})))];
  for (const columna of columnas) {
    const definicion = columnaConocida(columna);
    const titulo = esc(definicion?.descripcion || columna);
    if (definicion?.tipo === 'medida') {
      const valores = lecturas.map((l) => Number(l.datos?.[columna])).filter((n) => Number.isFinite(n));
      partes.push(`<div class="baston-bloque"><strong>${titulo}</strong> — promedio ${unDecimal(promedio(valores))} · `
        + `mínimo ${unDecimal(Math.min(...valores))} · máximo ${unDecimal(Math.max(...valores))}</div>`);
      continue;
    }

    const conteo = new Map();
    for (const l of lecturas) {
      const valor = l.datos?.[columna];
      if (!valor) continue;
      if (!conteo.has(valor)) conteo.set(valor, []);
      conteo.get(valor).push(l);
    }
    const filas = [...conteo.entries()].sort((a, b) => b[1].length - a[1].length).map(([codigo, suyas]) => {
      const pct = (suyas.length / total * 100).toFixed(1).replace('.', ',');
      const susPesos = suyas.map((l) => (l.peso_kg === null ? null : Number(l.peso_kg))).filter((p) => p !== null);
      const peso = susPesos.length ? ` — peso promedio ${unDecimal(promedio(susPesos))} kg` : '';
      return `<li>${esc(significadoDe(columna, codigo))} — <strong>${suyas.length}</strong> (${pct}%)${peso}</li>`;
    });
    partes.push(`<div class="baston-bloque"><strong>${titulo}</strong><ul>${filas.join('')}</ul></div>`);

    // El % de preñez solo sale si alguien dijo qué códigos cuentan como
    // preñada y cuáles como vacía (ver cuenta_como en la migración 046).
    const prenadas = contarPor(lecturas, columna, 'prenada');
    const vacias = contarPor(lecturas, columna, 'vacia');
    if (prenadas + vacias > 0) {
      const pct = (prenadas / (prenadas + vacias) * 100).toFixed(1).replace('.', ',');
      partes.push(`<div class="baston-destacado">% de preñez: <strong>${pct}%</strong> `
        + `<span class="ayuda">(${prenadas} preñadas de ${prenadas + vacias} diagnosticadas)</span></div>`);
    }
  }

  if (minutos > 0) {
    const ritmo = (total / minutos).toFixed(1).replace('.', ',');
    partes.push(`<div class="ayuda">Trabajo: ${Math.floor(minutos / 60)}h ${minutos % 60}min `
      + `(${horas[0].slice(11, 16)} → ${horas[horas.length - 1].slice(11, 16)}) · ≈ ${ritmo} animales por minuto</div>`);
  }
  if (sesion.observaciones) partes.push(`<div class="ayuda">${esc(sesion.observaciones)}</div>`);

  return partes.join('');
}

function contarPor(lecturas, columna, cuentaComo) {
  const codigos = diccionario.codigos
    .filter((c) => c.columna === columna && c.cuenta_como === cuentaComo)
    .map((c) => c.codigo);
  if (!codigos.length) return 0;
  return lecturas.filter((l) => codigos.includes(l.datos?.[columna])).length;
}

// ─── Pantalla 3: la historia de un animal ───────────────────────────────

async function buscarAnimal() {
  const texto = el('baston-animal-buscar').value.trim();
  const destino = el('baston-animal-resultado');
  if (!texto) { destino.innerHTML = ''; return; }
  destino.innerHTML = '<div class="ayuda">Buscando...</div>';

  // Se busca por las dos: se puede escribir la visual (lo que se lee en la
  // caravana) o la electrónica entera.
  const eid = normalizarEid(texto);
  const { data: animales, error } = await supabase.from('animales').select('*')
    .or(`vid.eq.${texto}${eid ? `,eid.eq.${eid}` : ''}`);
  if (error) {
    destino.innerHTML = `<div class="mensaje error">No pude buscar: ${esc(error.message)}</div>`;
    return;
  }
  if (!animales.length) {
    destino.innerHTML = '<div class="ayuda">No encontré ningún animal con esa caravana.</div>';
    return;
  }

  await cargarDiccionario();
  const partes = [];
  for (const animal of animales) {
    const { data: lecturas } = await supabase
      .from('historial_lecturas_baston').select('*').eq('animal_id', animal.id);
    partes.push(htmlHistoriaAnimal(animal, lecturas || []));
  }
  destino.innerHTML = partes.join('');
}

function htmlHistoriaAnimal(animal, lecturas) {
  const filas = lecturas.map((l) => {
    const detalle = Object.entries(l.datos || {})
      .map(([columna, valor]) => `${esc(columnaConocida(columna)?.descripcion || columna)}: ${esc(significadoDe(columna, valor))}`)
      .join(' · ');
    return `<tr>
      <td>${l.fecha}</td>
      <td>${esc(l.sesion)}</td>
      <td>${l.vid ? esc(l.vid) : '—'}</td>
      <td>${l.peso_kg ?? '—'}</td>
      <td>${detalle || '—'}</td>
    </tr>`;
  }).join('');

  return `
    <div class="baston-bloque">
      <h3>Caravana ${animal.vid ? esc(animal.vid) : '(sin visual)'}</h3>
      <div class="ayuda">Electrónica: ${esc(animal.eid_original || animal.eid)} · ${lecturas.length} paso(s) por la manga</div>
      <table class="tabla">
        <thead><tr><th>Fecha</th><th>Sesión</th><th>Visual</th><th>Peso</th><th>Qué se le hizo</th></tr></thead>
        <tbody>${filas || '<tr><td colspan="5">Sin lecturas.</td></tr>'}</tbody>
      </table>
    </div>`;
}

// ─── Armado de la pantalla ──────────────────────────────────────────────

function mostrarSubseccion(nombre) {
  for (const seccion of document.querySelectorAll('.baston-seccion')) {
    seccion.classList.toggle('oculto', seccion.id !== `baston-${nombre}`);
  }
  document.querySelectorAll('.baston-tab').forEach((boton) => {
    boton.classList.toggle('activo', boton.dataset.subseccion === nombre);
  });
  if (nombre === 'sesiones') cargarSesiones();
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
    boton.addEventListener('click', () => mostrarSubseccion(boton.dataset.subseccion));
  });
  el('baston-archivo').addEventListener('change', (evento) => {
    alElegirArchivo(evento).catch((error) => {
      console.error('Falló al leer el archivo del bastón:', error);
      mensajeLectura('No se pudo leer el archivo: ' + error.message, 'error');
    });
  });
  // Envuelto: guardarSesion encadena varias consultas, y si alguna
  // revienta de una forma no prevista el cartel se quedaba en "Guardando..."
  // para siempre, sin decir nada.
  el('baston-guardar').addEventListener('click', async () => {
    try {
      await guardarSesion();
    } catch (error) {
      console.error('Falló al guardar la sesión del bastón:', error);
      mensajeGuardar('No se pudo guardar: ' + error.message, 'error');
    }
  });
  el('baston-animal-boton').addEventListener('click', () => {
    buscarAnimal().catch((error) => {
      el('baston-animal-resultado').innerHTML = `<div class="mensaje error">No se pudo buscar: ${esc(error.message)}</div>`;
    });
  });
  el('baston-animal-buscar').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); buscarAnimal(); }
  });
  poblarSelectoresDeContexto();
}
