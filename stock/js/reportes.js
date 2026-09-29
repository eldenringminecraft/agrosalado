// Reportes: pestaña con 4 sub-secciones (Trabajo de Manga / Feed Lot /
// Historia de Rodeo / Índices). M4 armó el esqueleto; M5 completa
// Trabajo de Manga: listado filtrable con el detalle de qué se hizo
// (Sanidad/Reproducción/Manejo), exportable a PDF vía impresión del
// navegador (contenedor .imprimible, ver estilo.css) — sin librería
// nueva, mismo criterio minimalista que el resto de la app.
import { supabase } from './supabaseClient.js';
import { ESTABLECIMIENTOS, CATEGORIAS } from './config.js';
import { cargarRodeos, obtenerRodeosCache } from './rodeos.js';
import { cargarTitulares, obtenerTitularesCache } from './titulares.js';
import {
  cargarCatalogosSanidad, obtenerTrabajosConDetalle, esRectificado,
  puedeAnularManga, puedeEditarManga, anularTrabajoManga, esc,
} from './trabajoMangaDetalle.js';
import { INDICES, ordenIndices, fechaGatilloDelAnio, ventanaDestete, hoyArtISO } from './indicesConfig.js';
import { revisarRecordatorioIndices } from './indices.js';

function el(id) {
  return document.getElementById(id);
}

const SUBSECCIONES = ['manga', 'feedlot', 'rodeo', 'indices'];

function mostrarSubseccion(nombre) {
  for (const s of SUBSECCIONES) {
    el(`reportes-${s}`).classList.toggle('oculto', s !== nombre);
  }
  document.querySelectorAll('.reportes-tab').forEach((boton) => {
    boton.classList.toggle('activo', boton.dataset.subseccion === nombre);
  });
  if (nombre === 'manga') cargarTrabajosManga();
  if (nombre === 'feedlot') cargarFeedLot();
  if (nombre === 'rodeo') cargarHistoriaRodeo();
  if (nombre === 'indices') cargarIndices();
}

function hoyISO() {
  return new Date().toISOString().slice(0, 10);
}

// Diferencia en días entre dos fechas ISO (hasta - desde); positivo si
// "hasta" es posterior.
function diasEntre(desdeIso, hastaIso) {
  const desde = new Date(desdeIso + 'T00:00:00');
  const hasta = new Date(hastaIso + 'T00:00:00');
  return Math.round((hasta - desde) / 86400000);
}

// ─── Trabajo de Manga ───────────────────────────────────────────────────

function poblarSelect(idSelect, opciones, textoTodos) {
  const select = el(idSelect);
  const valorPrevio = select.value;
  select.innerHTML = '';
  const vacia = document.createElement('option');
  vacia.value = '';
  vacia.textContent = textoTodos;
  select.appendChild(vacia);
  for (const o of opciones) {
    const opt = document.createElement('option');
    opt.value = o.id;
    opt.textContent = o.nombre;
    select.appendChild(opt);
  }
  if (valorPrevio && [...select.options].some((x) => x.value === valorPrevio)) select.value = valorPrevio;
}

// Los rodeos se acotan al establecimiento elegido: la lista completa mezcla
// los de los cuatro campos y es incómoda de recorrer.
function poblarSelectRodeoReportes() {
  const establecimientoId = el('rep-manga-establecimiento')?.value || '';
  const rodeos = obtenerRodeosCache()
    .filter((r) => !establecimientoId || r.establecimiento_id === establecimientoId)
    .map((r) => ({ id: r.id, nombre: r.codigo }));
  poblarSelect('rep-manga-rodeo', rodeos, 'Todos los rodeos');
}

function poblarFiltrosManga() {
  poblarSelect('rep-manga-establecimiento', ESTABLECIMIENTOS, 'Todos los establecimientos');
  poblarSelectRodeoReportes();
  poblarSelect('rep-manga-categoria', CATEGORIAS, 'Todas las categorías');
  poblarSelect('rep-manga-propietario', obtenerTitularesCache(), 'Todos los propietarios');
}

async function poblarSelectUsuariosManga() {
  const { data, error } = await supabase.from('perfiles').select('user_id, nombre_completo').order('nombre_completo');
  if (error || !data) return;
  poblarSelect('rep-manga-usuario', data.map((u) => ({ id: u.user_id, nombre: u.nombre_completo })), 'Todos los usuarios');
}

let ultimosTrabajos = [];

function renderTrabajosManga(trabajos) {
  const tbody = el('rep-manga-tabla').querySelector('tbody');
  tbody.innerHTML = '';
  if (!trabajos.length) {
    tbody.innerHTML = '<tr><td colspan="11">Sin trabajos de manga con esos filtros.</td></tr>';
    return;
  }
  for (const t of trabajos) {
    const tr = document.createElement('tr');
    if (t.anulado) tr.classList.add('anulado');
    else if (esRectificado(t)) tr.classList.add('rectificado');
    tr.innerHTML = `
      <td>${t.codigo}</td>
      <td>${t.fecha}</td>
      <td>${esc(t.rodeo || '')}</td>
      <td>${t.categoriasTexto}</td>
      <td>${t.cantidad_encerrada ?? t.cantidad_trabajada}</td>
      <td>${t.cantidad_trabajada}${esRectificado(t) ? ' ✏️' : ''}</td>
      <td>${esc(t.propietariosTexto)}</td>
      <td>${esc(t.detalleTexto)}</td>
      <td class="celda-observaciones">${esc(t.observaciones || '')}</td>
      <td>${esc(t.usuario_nombre || '')}</td>
      <td>${t.anulado ? `Anulado (${esc(t.anulado_motivo || 'sin motivo')})` : ''}</td>
      <td class="no-imprimir"></td>
    `;
    const acciones = tr.lastElementChild;
    if (puedeEditarManga(t)) {
      const btnEditar = document.createElement('button');
      btnEditar.type = 'button';
      btnEditar.textContent = 'Editar';
      btnEditar.className = 'boton-secundario';
      btnEditar.addEventListener('click', () => pedirEdicionManga(t));
      acciones.appendChild(btnEditar);
    }
    if (puedeAnularManga(t)) {
      const btnAnular = document.createElement('button');
      btnAnular.type = 'button';
      btnAnular.textContent = 'Anular';
      btnAnular.className = 'boton-anular';
      btnAnular.addEventListener('click', async () => {
        if (await anularTrabajoManga(t.id)) await cargarTrabajosManga();
      });
      acciones.appendChild(btnAnular);
    }
    tbody.appendChild(tr);
  }
}

// Manda a editar a la pantalla Trabajo de Manga (que ya tiene el formulario
// entero) en vez de duplicarlo acá — vía evento, para no armar un import
// circular entre reportes.js y trabajoManga.js.
function pedirEdicionManga(trabajo) {
  document.dispatchEvent(new CustomEvent('hacienda:editar-trabajo-manga', { detail: trabajo }));
}

export async function cargarTrabajosManga() {
  const mensaje = el('rep-manga-mensaje');
  mensaje.textContent = '';

  const desde = el('rep-manga-desde').value;
  const hasta = el('rep-manga-hasta').value;
  const rodeoId = el('rep-manga-rodeo').value;
  const usuarioId = el('rep-manga-usuario').value;
  const establecimientoId = el('rep-manga-establecimiento').value;
  const categoriaId = el('rep-manga-categoria').value;
  const propietarioId = el('rep-manga-propietario').value;

  try {
    let trabajos = await obtenerTrabajosConDetalle({ desde, hasta, rodeoId, usuarioId });
    // Establecimiento, categoría y propietario se filtran acá: el primero
    // sale del rodeo (no es una columna del trabajo) y el último vive en
    // una tabla hija, así que no se pueden pedir a la base sin complicar
    // la consulta compartida con Historial.
    if (establecimientoId) {
      const deEse = new Set(obtenerRodeosCache().filter((r) => r.establecimiento_id === establecimientoId).map((r) => r.id));
      trabajos = trabajos.filter((t) => deEse.has(t.rodeo_id));
    }
    // La categoría ya no es una columna del trabajo: un trabajo puede
    // tener varias (ver migración 045), normalizadas en t.categorias.
    if (categoriaId) trabajos = trabajos.filter((t) => (t.categorias || []).some((c) => c.categoria_id === categoriaId));
    if (propietarioId) trabajos = trabajos.filter((t) => (t.propietariosIds || []).includes(propietarioId));
    ultimosTrabajos = trabajos;
    renderTrabajosManga(trabajos);
  } catch (error) {
    mensaje.textContent = `No se pudo cargar (¿sin conexión?): ${error.message}`;
    mensaje.className = 'error';
  }
}

// ─── Feed Lot ───────────────────────────────────────────────────────────
// "Kilos ganados" mientras el ciclo sigue abierto solo se puede estimar
// si hubo una Pesada de control (Trabajo de Manga > Manejo de rodeo)
// después del ingreso — el ingreso a feed lot no actualiza el peso del
// rodeo por sí solo. Sin esa pesada, se muestra el objetivo pero no un
// "ganado hasta ahora" (no hay con qué calcularlo). Una vez cerrado el
// ciclo (kilos_salida_real cargado), el ganado ya es un dato exacto.

function renderCorralVacio(corral) {
  return `<div class="corral-card vacio"><h4>Corral ${corral}</h4><div>Vacío</div></div>`;
}

function renderCorralOcupado(corral, rodeo, ciclo, cabezas, pesada) {
  const hoy = hoyISO();
  const partes = [`<h4>Corral ${corral}</h4>`, `<div class="corral-linea"><strong>${rodeo.codigo}</strong></div>`];
  if (cabezas != null) partes.push(`<div class="corral-linea">${cabezas} cabezas</div>`);

  if (ciclo?.fecha_estimada_salida) {
    const dias = diasEntre(hoy, ciclo.fecha_estimada_salida);
    const claseDias = dias < 0 ? 'vencido' : 'ok';
    const textoDias = dias < 0 ? `vencido hace ${Math.abs(dias)} día(s)` : dias === 0 ? 'hoy' : `en ${dias} día(s)`;
    partes.push(`<div class="corral-linea corral-dias ${claseDias}">Salida estimada: ${ciclo.fecha_estimada_salida} (${textoDias})</div>`);
  } else {
    partes.push('<div class="corral-linea">Sin fecha estimada de salida cargada.</div>');
  }

  if (ciclo?.kilos_ingreso != null) partes.push(`<div class="corral-linea">Kilos de ingreso: ${ciclo.kilos_ingreso} kg</div>`);
  if (ciclo?.kilos_salida_objetivo != null) partes.push(`<div class="corral-linea">Kilos objetivo: ${ciclo.kilos_salida_objetivo} kg</div>`);

  if (pesada && ciclo?.kilos_ingreso != null) {
    const ganado = +(pesada.kilos_promedio - ciclo.kilos_ingreso).toFixed(1);
    const dias = ciclo.fecha_ingreso ? diasEntre(ciclo.fecha_ingreso, pesada.fecha) : 0;
    const gdpTexto = dias > 0 ? ` (${(ganado / dias) >= 0 ? '+' : ''}${(ganado / dias).toFixed(2)} kg/día)` : '';
    partes.push(`<div class="corral-linea">Última pesada: ${pesada.kilos_promedio} kg (${pesada.fecha}) — <strong>${ganado >= 0 ? '+' : ''}${ganado} kg</strong> desde el ingreso${gdpTexto}</div>`);
  } else {
    partes.push('<div class="corral-linea ayuda">Sin pesada de control registrada todavía.</div>');
  }

  return `<div class="corral-card">${partes.join('')}</div>`;
}

function renderCorrales(corrales) {
  const cont = el('rep-feedlot-corrales');
  cont.innerHTML = ['1', '2', '3', '4'].map((corral) => {
    const ocupante = corrales[corral];
    return ocupante ? renderCorralOcupado(corral, ocupante.rodeo, ocupante.ciclo, ocupante.cabezas, ocupante.pesada) : renderCorralVacio(corral);
  }).join('');
}

function renderHistorialFeedLot(ciclosCerrados) {
  const tbody = el('rep-feedlot-historial-tabla').querySelector('tbody');
  if (!ciclosCerrados.length) {
    tbody.innerHTML = '<tr><td colspan="7">Sin ciclos cerrados todavía.</td></tr>';
    return;
  }
  tbody.innerHTML = ciclosCerrados.map((c) => {
    const rodeo = obtenerRodeosCache().find((r) => r.id === c.rodeo_id);
    const dias = c.fecha_salida_real ? diasEntre(c.fecha_ingreso, c.fecha_salida_real) : '';
    const ganado = c.kilos_salida_real != null && c.kilos_ingreso != null ? +(c.kilos_salida_real - c.kilos_ingreso).toFixed(1) : null;
    return `<tr>
      <td>${rodeo?.codigo || c.rodeo_id}</td>
      <td>${c.fecha_ingreso}</td>
      <td>${c.fecha_salida_real || ''}</td>
      <td>${dias}</td>
      <td>${c.kilos_ingreso ?? ''}</td>
      <td>${c.kilos_salida_real ?? ''}</td>
      <td>${ganado != null ? (ganado >= 0 ? '+' : '') + ganado + ' kg' : ''}</td>
    </tr>`;
  }).join('');
}

export async function cargarFeedLot() {
  const mensaje = el('rep-feedlot-mensaje');
  mensaje.textContent = '';

  const [rodeosFeedLot, ciclosAbiertos, ciclosCerrados, stockActual] = await Promise.all([
    supabase.from('rodeos').select('id, codigo, corral').eq('establecimiento_id', 'feed_lot').eq('activo', true),
    supabase.from('feed_lot_ciclos').select('*').eq('activo', true),
    supabase.from('feed_lot_ciclos').select('*').eq('activo', false).order('fecha_salida_real', { ascending: false }).limit(10),
    supabase.from('stock_actual').select('rodeo_id, cabezas').eq('establecimiento', 'feed_lot'),
  ]);
  if (rodeosFeedLot.error || ciclosAbiertos.error || ciclosCerrados.error || stockActual.error) {
    const error = rodeosFeedLot.error || ciclosAbiertos.error || ciclosCerrados.error || stockActual.error;
    mensaje.textContent = `No se pudo cargar (¿sin conexión?): ${error.message}`;
    mensaje.className = 'error';
    return;
  }

  const rodeoIds = rodeosFeedLot.data.map((r) => r.id);
  let pesadas = [];
  if (rodeoIds.length) {
    const { data } = await supabase.from('rodeo_pesadas_historial').select('rodeo_id, fecha, kilos_promedio').in('rodeo_id', rodeoIds).order('fecha', { ascending: false });
    pesadas = data || [];
  }
  const pesadaMasRecientePorRodeo = {};
  for (const p of pesadas) {
    if (!pesadaMasRecientePorRodeo[p.rodeo_id]) pesadaMasRecientePorRodeo[p.rodeo_id] = p;
  }

  const cabezasPorRodeo = {};
  for (const r of stockActual.data) {
    cabezasPorRodeo[r.rodeo_id] = (cabezasPorRodeo[r.rodeo_id] || 0) + Number(r.cabezas);
  }

  const corrales = {};
  for (const rodeo of rodeosFeedLot.data) {
    if (!rodeo.corral) continue;
    corrales[rodeo.corral] = {
      rodeo,
      ciclo: ciclosAbiertos.data.find((c) => c.rodeo_id === rodeo.id) || null,
      cabezas: cabezasPorRodeo[rodeo.id] ?? 0,
      pesada: pesadaMasRecientePorRodeo[rodeo.id] || null,
    };
  }

  renderCorrales(corrales);
  renderHistorialFeedLot(ciclosCerrados.data);
}

// ─── Historia de Rodeo ──────────────────────────────────────────────────
// Una sola línea de tiempo con dos fuentes intercaladas cronológicamente:
// movimientos donde el rodeo es origen o destino (historial_movimientos)
// y pesadas de control (rodeo_pesadas_historial) — así se ve la
// evolución completa de un rodeo en un solo lugar, no dos tablas
// separadas que hay que cruzar a mano.

function poblarSelectRodeoHistoria() {
  const select = el('rep-rodeo-select');
  const valorPrevio = select.value;
  select.innerHTML = '<option value="">Elegir rodeo...</option>';
  for (const r of obtenerRodeosCache()) {
    const opt = document.createElement('option');
    opt.value = r.id;
    opt.textContent = r.codigo;
    select.appendChild(opt);
  }
  if (valorPrevio && [...select.options].some((o) => o.value === valorPrevio)) select.value = valorPrevio;
}

// Ganancia diaria promedio (GDP) entre dos pesadas consecutivas del mismo
// rodeo: kilos ganados desde la pesada anterior, repartidos en los días
// que pasaron. null si no hay pesada anterior o si las fechas no avanzan
// (no tiene sentido dividir por 0 ni por días negativos).
function calcularGDP(anterior, actual) {
  if (!anterior) return null;
  const dias = diasEntre(anterior.fecha, actual.fecha);
  if (dias <= 0) return null;
  const ganancia = actual.kilos_promedio - anterior.kilos_promedio;
  return { dias, ganancia: ganancia.toFixed(1), gdp: (ganancia / dias).toFixed(2) };
}

// Suma a cada pesada el GDP contra la pesada inmediatamente anterior del
// mismo rodeo — requiere que "pesadas" venga ordenado por fecha ascendente
// (así se pide en cargarHistoriaRodeo).
function enriquecerPesadasConGDP(pesadas) {
  return pesadas.map((p, i) => ({ ...p, gdp: calcularGDP(i > 0 ? pesadas[i - 1] : null, p) }));
}

function describirMovimientoTimeline(m) {
  const origen = m.establecimiento_origen_nombre ? `${m.establecimiento_origen_nombre} (${m.categoria_origen_nombre})` : null;
  // En una Venta no hay establecimiento_destino (el animal sale del
  // sistema) — el "destino" real es el comprador.
  const destino = m.tipo_movimiento === 'venta' && m.comprador_nombre
    ? m.comprador_nombre
    : m.establecimiento_destino_nombre ? `${m.establecimiento_destino_nombre} (${m.categoria_destino_nombre})` : null;
  const recorrido = [origen, destino].filter(Boolean).join(' → ');
  const titular = m.titular_origen_nombre || m.titular_destino_nombre;
  return [
    recorrido,
    `${m.cantidad_cabezas} cab. (${m.kilos_promedio} kg prom.)`,
    titular ? `titular: ${titular}` : null,
    m.rodeo_destino ? `pasa al rodeo ${m.rodeo_destino}` : null,
  ].filter(Boolean).join(' — ');
}

// Arma la línea de tiempo ordenada: movimientos (fecha + created_at como
// desempate) y pesadas (fecha + creado_at) mezclados en un único array.
function construirLineaDeTiempo(movimientos, pesadas) {
  const eventos = [
    ...movimientos.map((m) => ({ fecha: m.fecha, orden: m.created_at, tipo: 'movimiento', datos: m })),
    ...pesadas.map((p) => ({ fecha: p.fecha, orden: p.creado_at, tipo: 'pesada', datos: p })),
  ];
  eventos.sort((a, b) => (a.fecha === b.fecha ? (a.orden || '').localeCompare(b.orden || '') : a.fecha.localeCompare(b.fecha)));
  return eventos;
}

function renderHistoriaRodeo(rodeo, eventos) {
  const info = el('rep-rodeo-info');
  if (!rodeo) {
    info.textContent = '';
    el('rep-rodeo-tabla').querySelector('tbody').innerHTML = '';
    return;
  }
  const categoriaNombre = CATEGORIAS.find((c) => c.id === rodeo.categoria_id)?.nombre || rodeo.categoria_id;
  const establecimientoNombre = ESTABLECIMIENTOS.find((e) => e.id === rodeo.establecimiento_id)?.nombre || rodeo.establecimiento_id;
  info.textContent = `${rodeo.codigo} — categoría actual: ${categoriaNombre} — establecimiento actual: ${establecimientoNombre}`;

  const tbody = el('rep-rodeo-tabla').querySelector('tbody');
  if (!eventos.length) {
    tbody.innerHTML = '<tr><td colspan="4">Sin movimientos ni pesadas registradas para este rodeo.</td></tr>';
    return;
  }
  tbody.innerHTML = eventos.map((e) => {
    if (e.tipo === 'pesada') {
      const gdp = e.datos.gdp;
      const detalle = gdp
        ? `${e.datos.kilos_promedio} kg — ${gdp.ganancia >= 0 ? '+' : ''}${gdp.ganancia} kg en ${gdp.dias} día(s) (${gdp.gdp >= 0 ? '+' : ''}${gdp.gdp} kg/día)`
        : `${e.datos.kilos_promedio} kg`;
      return `<tr><td>${e.fecha}</td><td>⚖️ Pesada de control</td><td>${detalle}</td><td></td></tr>`;
    }
    return `<tr><td>${e.fecha}</td><td>${e.datos.tipo_movimiento_nombre}</td><td>${describirMovimientoTimeline(e.datos)}</td><td>${e.datos.codigo || ''}</td></tr>`;
  }).join('');
}

export async function cargarHistoriaRodeo() {
  const mensaje = el('rep-rodeo-mensaje');
  mensaje.textContent = '';
  const rodeoId = el('rep-rodeo-select').value;
  if (!rodeoId) {
    renderHistoriaRodeo(null, []);
    return;
  }

  const [movimientos, pesadas] = await Promise.all([
    supabase.from('historial_movimientos').select('*').or(`rodeo_id.eq.${rodeoId},rodeo_destino_id.eq.${rodeoId}`).order('fecha', { ascending: true }),
    supabase.from('rodeo_pesadas_historial').select('*').eq('rodeo_id', rodeoId).order('fecha', { ascending: true }),
  ]);
  if (movimientos.error || pesadas.error) {
    const error = movimientos.error || pesadas.error;
    mensaje.textContent = `No se pudo cargar (¿sin conexión?): ${error.message}`;
    mensaje.className = 'error';
    return;
  }

  const rodeo = obtenerRodeosCache().find((r) => r.id === rodeoId);
  renderHistoriaRodeo(rodeo, construirLineaDeTiempo(movimientos.data, enriquecerPesadasConGDP(pesadas.data)));
}

// ─── Índices reproductivos ──────────────────────────────────────────────
// Carga manual de los índices definidos en indicesConfig.js. Guardar
// siempre resetea "corroborado" (aunque el índice ya estuviera cargado)
// porque cambió el dato — corroborar es una acción aparte que el usuario
// tiene que confirmar explícitamente, incluso si el valor no cambió (así
// funciona la reconfirmación obligatoria del día del gatillo, M10/M11).

async function usuarioActualId() {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.user?.id;
}

function formatearFechaHora(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function claveIndice(tipo, anio) {
  return `${tipo}_${anio}`;
}

function obtenerValor(valoresPorTipoAnio, tipo, anio) {
  return valoresPorTipoAnio[claveIndice(tipo, anio)] || null;
}

// Suma automática de Trabajo de Manga > Manejo > Destete en la ventana del
// año pedido (ver ventanaDestete() en indicesConfig.js) — sugiere un valor
// para el índice "destete" (M9); el usuario corrobora o corrige, nunca se
// guarda solo.
async function calcularDesteteAutomatico(anioDestete) {
  const { desde, hasta } = ventanaDestete(anioDestete);
  const { data: trabajos, error: errorTrabajos } = await supabase
    .from('trabajos_manga').select('id').gte('fecha', desde).lte('fecha', hasta);
  if (errorTrabajos) throw errorTrabajos;
  if (!trabajos.length) return { cabezas: 0, pesoPromedio: null };

  const ids = trabajos.map((t) => t.id);
  const { data: manejos, error: errorManejo } = await supabase
    .from('trabajo_manga_manejo')
    .select('destete_machos_cantidad, destete_hembras_cantidad, destete_kilos_ternero, destete_kilos_ternera')
    .eq('destete', true).in('trabajo_manga_id', ids);
  if (errorManejo) throw errorManejo;

  let cabezas = 0;
  let kilosTotales = 0;
  for (const m of manejos) {
    const machos = m.destete_machos_cantidad || 0;
    const hembras = m.destete_hembras_cantidad || 0;
    cabezas += machos + hembras;
    if (machos && m.destete_kilos_ternero) kilosTotales += machos * m.destete_kilos_ternero;
    if (hembras && m.destete_kilos_ternera) kilosTotales += hembras * m.destete_kilos_ternera;
  }
  return { cabezas, pesoPromedio: cabezas ? +(kilosTotales / cabezas).toFixed(1) : null };
}

function crearTarjetaIndice(tipo, anio, valor, sugerencia) {
  const def = INDICES[tipo];
  const card = document.createElement('div');
  card.className = 'indice-card';
  card.dataset.tipo = tipo;

  const estadoClase = valor?.corroborado ? 'corroborado' : valor ? 'pendiente' : '';
  const estadoTexto = valor?.corroborado
    ? `Corroborado el ${formatearFechaHora(valor.corroborado_at)}.`
    : valor
      ? `Cargado el ${formatearFechaHora(valor.cargado_at)} — falta corroborar.`
      : 'Sin cargar todavía.';

  const valorPrincipalInicial = valor ? valor.valor_principal : (sugerencia ? sugerencia.cabezas : '');
  const valorSecundarioInicial = valor ? valor.valor_secundario : (sugerencia ? sugerencia.pesoPromedio : '');

  const campoSecundario = def.labelSecundario ? `
    <label>${def.labelSecundario} (${def.unidadSecundario})
      <input type="number" class="indice-valor-secundario" min="0" step="0.1" value="${valorSecundarioInicial ?? ''}">
    </label>` : '';

  const avisoAuto = def.autoCalculable && !valor && sugerencia
    ? `<p class="ayuda indice-auto-sugerido">Cálculo automático (Trabajo de Manga): ${sugerencia.cabezas} cabezas${sugerencia.pesoPromedio != null ? `, ${sugerencia.pesoPromedio} kg promedio` : ''} — ya está precargado abajo, revisá y corroborá.</p>`
    : '';

  card.innerHTML = `
    <h4>${def.nombre} <button type="button" class="icono-ayuda" title="¿Cómo se calcula?">?</button></h4>
    <p class="indice-gatillo">Fecha gatillo ${anio}: ${fechaGatilloDelAnio(tipo, anio)}</p>
    <p class="ayuda indice-ayuda-texto oculto">${def.ayuda}</p>
    ${avisoAuto}
    <label>${def.labelPrincipal} (${def.unidadPrincipal})
      <input type="number" class="indice-valor-principal" min="0" step="1" value="${valorPrincipalInicial ?? ''}">
    </label>
    ${campoSecundario}
    <label>Observaciones
      <textarea class="indice-observaciones">${valor?.observaciones ?? ''}</textarea>
    </label>
    <span class="indice-estado ${estadoClase}">${estadoTexto}</span>
    <div class="indice-botones">
      <button type="button" class="boton-secundario indice-guardar">Guardar</button>
      <button type="button" class="boton-primario indice-corroborar${(!valor || valor.corroborado) ? ' oculto' : ''}">Corroborar</button>
    </div>
  `;
  return card;
}

async function renderIndices(anio, valoresPorTipoAnio) {
  const grid = el('rep-indices-grid');
  grid.innerHTML = '';
  for (const tipo of ordenIndices()) {
    const valor = obtenerValor(valoresPorTipoAnio, tipo, anio);
    let sugerencia = null;
    if (tipo === 'destete' && !valor) {
      try {
        sugerencia = await calcularDesteteAutomatico(anio);
      } catch (error) {
        console.error('No se pudo calcular el destete automático:', error);
      }
    }
    grid.appendChild(crearTarjetaIndice(tipo, anio, valor, sugerencia));
  }
}

// ─── Indicadores calculados (% preñez, % marcación, mortandad predestete,
// peso promedio al destete) ───────────────────────────────────────────────
// Solo lectura: no son filas propias de indices_valores, se calculan al
// vuelo cruzando los índices manuales de la temporada. La temporada
// mostrada es el "Año" elegido (mismo año que Preñadas/Parición); Vacas en
// servicio se busca un año antes y Destete un año después, porque el
// servicio de octubre arranca la temporada que pare y desteta recién en
// los dos años siguientes (ver indicesConfig.js).

// Fórmulas puras (sin DOM) de los 4 indicadores — únicas, las usan tanto
// las tarjetas de la temporada elegida como la tabla de evolución
// histórica, para que nunca puedan desalinearse entre sí.
function calcularPorcentajePrenez(servicio, prenadas) {
  if (!servicio || !prenadas) return null;
  return ((prenadas.valor_principal / servicio.valor_principal) * 100).toFixed(1);
}
function calcularPorcentajeMarcacion(servicio, destete) {
  if (!servicio || !destete) return null;
  return ((destete.valor_principal / servicio.valor_principal) * 100).toFixed(1);
}
function calcularMortandadPredestete(paridos, destete) {
  if (!paridos || !destete || !paridos.valor_principal) return null;
  return (((paridos.valor_principal - destete.valor_principal) / paridos.valor_principal) * 100).toFixed(1);
}
function pesoPromedioDestete(destete) {
  return destete && destete.valor_secundario != null ? destete.valor_secundario : null;
}

function crearTarjetaCalculada(titulo, ayudaTexto, texto, faltante) {
  const card = document.createElement('div');
  card.className = 'indice-card calculado';
  card.innerHTML = `
    <h4>${titulo} <button type="button" class="icono-ayuda" title="¿Cómo se calcula?">?</button></h4>
    <p class="ayuda indice-ayuda-texto oculto">${ayudaTexto}</p>
    ${faltante ? `<p class="ayuda">${faltante}</p>` : `<p class="indice-resultado">${texto}</p>`}
  `;
  return card;
}

function renderIndicadoresCalculados(anio, valoresPorTipoAnio) {
  const cont = el('rep-indices-calculados');
  cont.innerHTML = '';

  const servicio = obtenerValor(valoresPorTipoAnio, 'vacas_servicio', anio - 1);
  const prenadas = obtenerValor(valoresPorTipoAnio, 'vacas_prenadas', anio);
  const paridos = obtenerValor(valoresPorTipoAnio, 'paricion_control_3', anio);
  const destete = obtenerValor(valoresPorTipoAnio, 'destete', anio + 1);

  const prenez = calcularPorcentajePrenez(servicio, prenadas);
  cont.appendChild(crearTarjetaCalculada(`% Preñez (temporada ${anio})`,
    'Vacas preñadas ÷ vacas en servicio del año anterior (el servicio que generó estas preñeces), × 100.',
    prenez != null ? `${prenez}% — ${prenadas.valor_principal} preñadas de ${servicio.valor_principal} en servicio (${anio - 1}).` : null,
    prenez != null ? null : `Falta cargar "Vacas en servicio" ${anio - 1} y/o "Vacas preñadas" ${anio}.`));

  const marcacion = calcularPorcentajeMarcacion(servicio, destete);
  cont.appendChild(crearTarjetaCalculada(`% Marcación (temporada ${anio})`,
    'Terneros destetados ÷ vacas en servicio de la temporada, × 100 — cuántos terneros llegaron al destete por cada vaca puesta en servicio.',
    marcacion != null ? `${marcacion}% — ${destete.valor_principal} destetados de ${servicio.valor_principal} en servicio (${anio - 1}).` : null,
    marcacion != null ? null : `Falta cargar "Vacas en servicio" ${anio - 1} y/o "Destete" ${anio + 1}.`));

  const mortandad = calcularMortandadPredestete(paridos, destete);
  cont.appendChild(crearTarjetaCalculada(`Mortandad predestete (temporada ${anio})`,
    '(Terneros nacidos − terneros destetados) ÷ terneros nacidos, × 100 — mortandad entre el nacimiento y el destete.',
    mortandad != null ? `${mortandad}% — ${paridos.valor_principal - destete.valor_principal} de ${paridos.valor_principal} nacidos no llegaron al destete (${anio + 1}).` : null,
    mortandad != null ? null : `Falta cargar "Parición — cierre" ${anio} y/o "Destete" ${anio + 1}.`));

  const peso = pesoPromedioDestete(destete);
  cont.appendChild(crearTarjetaCalculada(`Peso promedio al destete (temporada ${anio})`,
    'Promedio ponderado de los kilos de destete cargados en Trabajo de Manga (machos y hembras) para esta temporada.',
    peso != null ? `${peso} kg promedio (Destete ${anio + 1}).` : null,
    peso != null ? null : `Falta cargar el peso promedio en "Destete" ${anio + 1}.`));
}

// ─── Evolución histórica ────────────────────────────────────────────────
// Dos tablas de solo lectura con TODOS los años cargados (sin importar el
// "Año" elegido arriba), para ver de un vistazo cómo vino evolucionando
// cada índice y cada indicador calculado.

function renderEvolucionManual(data) {
  const porAnio = {};
  for (const fila of data) {
    porAnio[fila.anio] = porAnio[fila.anio] || {};
    porAnio[fila.anio][fila.tipo_indice] = fila;
  }
  const anios = Object.keys(porAnio).map(Number).sort((a, b) => a - b);
  const tabla = el('rep-indices-evolucion-tabla');
  const tipos = ordenIndices();

  tabla.querySelector('thead tr').innerHTML = '<th>Año</th>' + tipos.map((tipo) => `<th>${INDICES[tipo].nombre}</th>`).join('');

  const tbody = tabla.querySelector('tbody');
  if (!anios.length) {
    tbody.innerHTML = `<tr><td colspan="${tipos.length + 1}">Todavía no hay índices cargados.</td></tr>`;
    return;
  }
  tbody.innerHTML = anios.map((anio) => {
    const celdas = tipos.map((tipo) => {
      const fila = porAnio[anio][tipo];
      if (!fila) return '<td>—</td>';
      const secundario = fila.valor_secundario != null ? ` (${fila.valor_secundario} ${fila.unidad_secundaria || ''})` : '';
      const pendiente = fila.corroborado ? '' : ' ⏳';
      return `<td>${fila.valor_principal}${secundario}${pendiente}</td>`;
    }).join('');
    return `<tr><td>${anio}</td>${celdas}</tr>`;
  }).join('');
}

function renderEvolucionCalculados(data) {
  const valoresPorTipoAnio = {};
  for (const fila of data) valoresPorTipoAnio[claveIndice(fila.tipo_indice, fila.anio)] = fila;

  // Temporadas: años donde hay Preñadas y/o Parición — cierre, que son los
  // que anclan una temporada (mismo criterio que la tarjeta de un solo año).
  const temporadas = [...new Set(
    data.filter((f) => f.tipo_indice === 'vacas_prenadas' || f.tipo_indice === 'paricion_control_3').map((f) => f.anio),
  )].sort((a, b) => a - b);

  const tbody = el('rep-indices-evolucion-calculados-tabla').querySelector('tbody');
  if (!temporadas.length) {
    tbody.innerHTML = '<tr><td colspan="5">Todavía no hay datos suficientes.</td></tr>';
    return;
  }
  tbody.innerHTML = temporadas.map((anio) => {
    const servicio = obtenerValor(valoresPorTipoAnio, 'vacas_servicio', anio - 1);
    const prenadas = obtenerValor(valoresPorTipoAnio, 'vacas_prenadas', anio);
    const paridos = obtenerValor(valoresPorTipoAnio, 'paricion_control_3', anio);
    const destete = obtenerValor(valoresPorTipoAnio, 'destete', anio + 1);

    const prenez = calcularPorcentajePrenez(servicio, prenadas);
    const marcacion = calcularPorcentajeMarcacion(servicio, destete);
    const mortandad = calcularMortandadPredestete(paridos, destete);
    const peso = pesoPromedioDestete(destete);

    return `<tr>
      <td>${anio}</td>
      <td>${prenez != null ? prenez + '%' : '—'}</td>
      <td>${marcacion != null ? marcacion + '%' : '—'}</td>
      <td>${mortandad != null ? mortandad + '%' : '—'}</td>
      <td>${peso != null ? peso + ' kg' : '—'}</td>
    </tr>`;
  }).join('');
}

async function cargarEvolucionIndices() {
  const { data, error } = await supabase.from('indices_valores').select('*').order('anio', { ascending: true });
  if (error) {
    console.error('No se pudo cargar la evolución histórica de índices:', error);
    return;
  }
  renderEvolucionManual(data);
  renderEvolucionCalculados(data);
}

export async function cargarIndices() {
  const mensaje = el('rep-indices-mensaje');
  mensaje.textContent = '';
  const inputAnio = el('rep-indices-anio');
  if (!inputAnio.value) inputAnio.value = Number(hoyArtISO().slice(0, 4));
  const anio = Number(inputAnio.value);

  // Rango de 3 años: los indicadores calculados cruzan "Vacas en servicio"
  // del año anterior y "Destete" del año siguiente contra la temporada
  // elegida (ver nota más arriba).
  const { data, error } = await supabase.from('indices_valores').select('*')
    .gte('anio', anio - 1).lte('anio', anio + 1);
  if (error) {
    mensaje.textContent = `No se pudo cargar (¿sin conexión?): ${error.message}`;
    mensaje.className = 'error';
    return;
  }
  const valoresPorTipoAnio = {};
  for (const fila of data) valoresPorTipoAnio[claveIndice(fila.tipo_indice, fila.anio)] = fila;

  await renderIndices(anio, valoresPorTipoAnio);
  renderIndicadoresCalculados(anio, valoresPorTipoAnio);
  revisarRecordatorioIndices();
  cargarEvolucionIndices();
}

async function guardarIndice(card) {
  const tipo = card.dataset.tipo;
  const anio = Number(el('rep-indices-anio').value);
  const mensaje = el('rep-indices-mensaje');
  mensaje.textContent = '';

  const valorPrincipal = card.querySelector('.indice-valor-principal').value;
  if (valorPrincipal === '') {
    mensaje.textContent = `Falta cargar ${INDICES[tipo].labelPrincipal.toLowerCase()}.`;
    mensaje.className = 'error';
    return;
  }
  const campoSecundario = card.querySelector('.indice-valor-secundario');
  const valorSecundario = campoSecundario && campoSecundario.value !== '' ? Number(campoSecundario.value) : null;
  const observaciones = card.querySelector('.indice-observaciones').value.trim() || null;

  const { data: existente } = await supabase.from('indices_valores').select('id')
    .eq('tipo_indice', tipo).eq('anio', anio).maybeSingle();

  let error;
  if (existente) {
    ({ error } = await supabase.from('indices_valores').update({
      valor_principal: Number(valorPrincipal),
      valor_secundario: valorSecundario,
      unidad_secundaria: INDICES[tipo].unidadSecundario || null,
      observaciones,
      corroborado: false,
      corroborado_por: null,
      corroborado_at: null,
    }).eq('id', existente.id));
  } else {
    const usuarioId = await usuarioActualId();
    ({ error } = await supabase.from('indices_valores').insert({
      tipo_indice: tipo,
      anio,
      fecha_gatillo: fechaGatilloDelAnio(tipo, anio),
      valor_principal: Number(valorPrincipal),
      valor_secundario: valorSecundario,
      unidad_secundaria: INDICES[tipo].unidadSecundario || null,
      observaciones,
      cargado_por: usuarioId,
    }));
  }

  if (error) {
    mensaje.textContent = `No se pudo guardar: ${error.message}`;
    mensaje.className = 'error';
    return;
  }
  await cargarIndices();
}

async function corroborarIndice(card) {
  const tipo = card.dataset.tipo;
  const anio = Number(el('rep-indices-anio').value);
  const mensaje = el('rep-indices-mensaje');
  mensaje.textContent = '';
  const usuarioId = await usuarioActualId();

  const { error } = await supabase.from('indices_valores').update({
    corroborado: true,
    corroborado_por: usuarioId,
    corroborado_at: new Date().toISOString(),
  }).eq('tipo_indice', tipo).eq('anio', anio);

  if (error) {
    mensaje.textContent = `No se pudo corroborar: ${error.message}`;
    mensaje.className = 'error';
    return;
  }
  await cargarIndices();
}

function imprimirReporte() {
  window.print();
}

// Acceso directo desde el clic en un rodeo dentro de "Por establecimiento"
// (Stock) — ver dashboard.js, que dispara este evento en vez de importar
// reportes.js directo (mismo criterio de siempre para no armar imports
// circulares entre pantallas).
function verHistoriaRodeo(rodeoId) {
  location.hash = 'reportes';
  el('rep-rodeo-select').value = rodeoId;
  mostrarSubseccion('rodeo');
}

export async function initReportes() {
  document.querySelectorAll('.reportes-tab').forEach((boton) => {
    boton.addEventListener('click', () => mostrarSubseccion(boton.dataset.subseccion));
  });
  el('rep-manga-filtrar').addEventListener('click', cargarTrabajosManga);
  el('rep-manga-imprimir').addEventListener('click', imprimirReporte);
  // Elegir establecimiento acota la lista de rodeos; si el rodeo que estaba
  // elegido no es de ese campo, poblarSelectRodeoReportes lo deja en
  // "Todos los rodeos" solo (no lo encuentra entre las opciones nuevas).
  el('rep-manga-establecimiento').addEventListener('change', poblarSelectRodeoReportes);
  el('rep-feedlot-actualizar').addEventListener('click', cargarFeedLot);
  el('rep-feedlot-imprimir').addEventListener('click', imprimirReporte);
  el('rep-rodeo-ver').addEventListener('click', cargarHistoriaRodeo);
  el('rep-rodeo-imprimir').addEventListener('click', imprimirReporte);
  el('rep-indices-actualizar').addEventListener('click', cargarIndices);
  el('rep-indices-grid').addEventListener('click', (evento) => {
    const card = evento.target.closest('.indice-card');
    if (!card) return;
    if (evento.target.classList.contains('icono-ayuda')) {
      card.querySelector('.indice-ayuda-texto').classList.toggle('oculto');
    } else if (evento.target.classList.contains('indice-guardar')) {
      guardarIndice(card);
    } else if (evento.target.classList.contains('indice-corroborar')) {
      corroborarIndice(card);
    }
  });
  el('rep-indices-calculados').addEventListener('click', (evento) => {
    if (!evento.target.classList.contains('icono-ayuda')) return;
    evento.target.closest('.indice-card')?.querySelector('.indice-ayuda-texto')?.classList.toggle('oculto');
  });
  document.addEventListener('hacienda:ver-historia-rodeo', (evento) => verHistoriaRodeo(evento.detail.rodeoId));
  document.addEventListener('hacienda:ver-indices', () => mostrarSubseccion('indices'));

  // Los caches (rodeos/titulares/catálogos) tienen que estar cargados
  // ANTES de mostrar la primera sub-sección — si no, la primera carga de
  // datos corre con nombres sin resolver.
  await Promise.all([cargarRodeos(), cargarTitulares(), cargarCatalogosSanidad()]);
  poblarFiltrosManga();
  poblarSelectUsuariosManga();
  poblarSelectRodeoHistoria();
  mostrarSubseccion('manga');
}

// Llamado por router.js al navegar a #reportes — recarga la sub-sección
// que esté activa en ese momento (no siempre "manga": el usuario puede
// haber quedado en otra al salir de la pestaña).
export async function refrescarReportes() {
  const activa = document.querySelector('.reportes-tab.activo')?.dataset.subseccion || 'manga';
  if (activa === 'manga') {
    // Los filtros se arman desde los caches de rodeos y titulares, que
    // pueden haber cambiado desde que se abrió la app (un rodeo nuevo, un
    // capitalizador recién creado). Se repueblan al entrar, igual que hace
    // Cargar movimiento con los rodeos.
    poblarFiltrosManga();
    await cargarTrabajosManga();
  }
  if (activa === 'feedlot') await cargarFeedLot();
  if (activa === 'rodeo') await cargarHistoriaRodeo();
  if (activa === 'indices') await cargarIndices();
}
