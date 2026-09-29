import { supabase } from './supabaseClient.js';
import { ESTABLECIMIENTOS, TIPOS_MOVIMIENTO, DESTINO_VENTA } from './config.js';
import { getEstado } from './auth.js';
import { exportarHistorial, exportarTrabajosManga } from './export.js';
import { cargarRodeos, obtenerRodeosCache } from './rodeos.js';
import { cargarTitulares } from './titulares.js';
import { cargarCatalogosSanidad, obtenerTrabajosConDetalle, esRectificado, puedeAnularManga, anularTrabajoManga, esc } from './trabajoMangaDetalle.js';

const VENTANA_ANULACION_HORAS = 48;

function el(id) {
  return document.getElementById(id);
}

function poblarFiltros() {
  const selEst = el('hist-filtro-establecimiento');
  if (!selEst.options.length) {
    selEst.innerHTML = '<option value="">Todos los establecimientos</option>';
    for (const e of ESTABLECIMIENTOS) {
      const opt = document.createElement('option');
      opt.value = e.id;
      opt.textContent = e.nombre;
      selEst.appendChild(opt);
    }
  }

  const selTipo = el('hist-filtro-tipo');
  if (!selTipo.options.length) {
    selTipo.innerHTML = '<option value="">Todos los tipos</option>';
    for (const [id, cfg] of Object.entries(TIPOS_MOVIMIENTO)) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = cfg.nombre;
      selTipo.appendChild(opt);
    }
  }

  const selEstado = el('hist-filtro-estado');
  if (!selEstado.options.length) {
    selEstado.innerHTML = `
      <option value="activos" selected>Sin anular</option>
      <option value="anulados">Anulados / editados</option>
      <option value="">Todos</option>
    `;
  }
}

// Comparte la misma lista (nombre + user_id) entre el filtro de
// movimientos y el de Trabajo de Manga — sirve para buscar más fácil lo
// que cargó cada uno ("lo que hice yo" vs. "lo que cargó otro").
async function cargarUsuariosFiltro() {
  const { data, error } = await supabase.from('perfiles').select('user_id, nombre_completo').order('nombre_completo');
  if (error || !data) return;
  for (const idSelect of ['hist-filtro-usuario', 'hist-manga-filtro-usuario']) {
    const select = el(idSelect);
    if (!select) continue;
    select.innerHTML = '<option value="">Todos los usuarios</option>';
    for (const u of data) {
      const opt = document.createElement('option');
      opt.value = u.user_id;
      opt.textContent = u.nombre_completo;
      select.appendChild(opt);
    }
  }
}

// Mismas reglas para anular y editar: administrativo/owner sin límite de
// tiempo, o el propio usuario dentro de la ventana — y en ningún caso si
// ya está anulado o ya fue reemplazado por una corrección (no tiene
// sentido volver a tocar un movimiento que "ya no rige").
function puedeModificar(fila) {
  const { perfil, session } = getEstado();
  if (!perfil || fila.anulado || fila.reemplazado_por) return false;
  if (perfil.rol === 'administrativo' || perfil.rol === 'owner') return true;
  if (fila.usuario_id !== session.user.id) return false;
  const horas = (Date.now() - new Date(fila.created_at).getTime()) / 36e5;
  return horas <= VENTANA_ANULACION_HORAS;
}

function describirMovimiento(fila) {
  const origen = fila.establecimiento_origen_nombre
    ? `${fila.establecimiento_origen_nombre} (${fila.categoria_origen_nombre})`
    : '—';
  // En una Venta no hay establecimiento_destino (el animal sale del
  // sistema) — el "destino" real es el comprador.
  const destino = fila.tipo_movimiento === 'venta' && fila.comprador_nombre
    ? fila.comprador_nombre
    : fila.establecimiento_destino_nombre
    ? `${fila.establecimiento_destino_nombre} (${fila.categoria_destino_nombre})`
    : '—';
  return { origen, destino };
}

function describirTitular(fila) {
  if (fila.titular_origen_nombre && fila.titular_destino_nombre && fila.titular_origen !== fila.titular_destino) {
    return `${fila.titular_origen_nombre} → ${fila.titular_destino_nombre}`;
  }
  return fila.titular_origen_nombre || fila.titular_destino_nombre || '—';
}

// Destino de venta (Faena/Invernada/Conserva) no tiene columna propia en
// la tabla — se muestra junto a Observaciones, solo para 'venta'. El
// comprador ya se muestra en la columna Destino (ver describirMovimiento).
function describirVenta(fila) {
  if (!fila.destino_venta) return '';
  return DESTINO_VENTA.find((d) => d.id === fila.destino_venta)?.nombre || fila.destino_venta;
}

async function anularMovimiento(id) {
  if (!navigator.onLine) {
    alert('Necesitás conexión a internet para anular un movimiento.');
    return;
  }
  const motivo = prompt('Motivo de la anulación:');
  if (motivo === null) return;
  const { perfil } = getEstado();
  const { error } = await supabase
    .from('movimientos')
    .update({
      anulado: true,
      anulado_por: getEstado().session.user.id,
      anulado_at: new Date().toISOString(),
      anulado_motivo: motivo || null,
    })
    .eq('id', id);
  if (error) {
    alert(`No se pudo anular: ${error.message}`);
    return;
  }
  await cargarHistorial();
}

// Marcar el original como reemplazado ya no se hace acá: viaja junto con la
// corrección en el mismo ítem de la cola de sincronización (ver
// guardarMovimiento en sync.js), para que no puedan entrar por separado.

// Pide precargar el formulario de "Cargar movimiento" con esta fila — vía
// evento en vez de importar movimientos.js directo, para no armar un
// import circular entre los dos módulos.
function pedirEdicion(fila) {
  document.dispatchEvent(new CustomEvent('hacienda:editar-movimiento', { detail: fila }));
}

function renderFilas(filas) {
  const tbody = el('hist-tabla').querySelector('tbody');
  tbody.innerHTML = '';
  for (const fila of filas) {
    const { origen, destino } = describirMovimiento(fila);
    const tr = document.createElement('tr');
    if (fila.anulado) tr.classList.add('anulado');
    if (fila.reemplazado_por) tr.classList.add('editado');
    let estado = '';
    if (fila.anulado) estado = `Anulado (${fila.anulado_motivo || 'sin motivo'})`;
    else if (fila.reemplazado_por) estado = `✏️ Editado → ${fila.reemplazado_por_codigo || '?'}`;
    else if (fila.editado_de) estado = `✏️ Corrección de ${fila.editado_de_codigo || '?'}`;
    tr.innerHTML = `
      <td>${fila.codigo || ''}</td>
      <td>${fila.fecha}</td>
      <td>${new Date(fila.created_at).toLocaleString('es-AR')}</td>
      <td>${fila.tipo_movimiento_nombre}</td>
      <td>${origen}</td>
      <td>${destino}</td>
      <td>${describirTitular(fila)}</td>
      <td>${fila.cantidad_cabezas}</td>
      <td>${fila.kilos_promedio}</td>
      <td>${fila.rodeo || ''}</td>
      <td>${fila.usuario_nombre || '—'}</td>
      <td>${[describirVenta(fila), fila.observaciones].filter(Boolean).join(' — ')}</td>
      <td>${estado}</td>
      <td></td>
    `;
    if (puedeModificar(fila)) {
      const btnEditar = document.createElement('button');
      btnEditar.textContent = 'Editar';
      btnEditar.className = 'boton-secundario';
      btnEditar.style.cssText = 'width:auto;padding:4px 10px;margin-right:6px;';
      btnEditar.addEventListener('click', () => pedirEdicion(fila));
      tr.lastElementChild.appendChild(btnEditar);

      const btnAnular = document.createElement('button');
      btnAnular.textContent = 'Anular';
      btnAnular.className = 'boton-anular';
      btnAnular.addEventListener('click', () => anularMovimiento(fila.id));
      tr.lastElementChild.appendChild(btnAnular);
    }
    tbody.appendChild(tr);
  }
}

let ultimasFilas = [];

export async function cargarHistorial() {
  let query = supabase.from('historial_movimientos').select('*').limit(200);

  const codigo = el('hist-filtro-codigo').value.trim();
  const establecimiento = el('hist-filtro-establecimiento').value;
  const tipo = el('hist-filtro-tipo').value;
  const usuario = el('hist-filtro-usuario').value;
  const estado = el('hist-filtro-estado').value;
  const desde = el('hist-filtro-desde').value;
  const hasta = el('hist-filtro-hasta').value;

  // Buscar por código: campo autónomo, pisa el resto de los filtros (si
  // sabés el código, querés ESE movimiento puntual, no una lista filtrada).
  if (codigo) {
    query = query.ilike('codigo', `%${codigo}%`);
  } else {
    if (establecimiento) {
      query = query.or(`establecimiento_origen.eq.${establecimiento},establecimiento_destino.eq.${establecimiento}`);
    }
    if (tipo) query = query.eq('tipo_movimiento', tipo);
    if (usuario) query = query.eq('usuario_id', usuario);
    // "Sin anular" también deja afuera al movimiento que quedó reemplazado
    // por una corrección (editar un movimiento) — ya no está vigente, así
    // que no tiene sentido verlo mezclado con los que sí cuentan para el
    // stock. Sigue pudiéndose ver desde "Anulados / editados" o "Todos".
    if (estado === 'activos') query = query.eq('anulado', false).is('reemplazado_por', null);
    else if (estado === 'anulados') query = query.or('anulado.eq.true,reemplazado_por.not.is.null');
    if (desde) query = query.gte('fecha', desde);
    if (hasta) query = query.lte('fecha', hasta);
  }

  const { data, error } = await query;
  if (error) {
    el('hist-mensaje').textContent = `No se pudo cargar el historial (¿sin conexión?): ${error.message}`;
    el('hist-mensaje').className = 'error';
    return;
  }
  el('hist-mensaje').textContent = '';
  ultimasFilas = data;
  renderFilas(data);
}

function exportar() {
  if (!ultimasFilas.length) return;
  exportarHistorial(ultimasFilas);
}

// ─── Historial de Trabajos de Manga (misma lógica que el de arriba:
// filtros, buscar por código, exportar; Anular es exclusivo de owner —
// más simple que en movimientos, no hay ventana de 48hs para el propio
// usuario, ni administrativo — a diferencia de movimientos, acá no hay
// "Editar" porque trabajos_manga no tiene ese concepto) ───

// puedeAnularManga y anularTrabajoManga viven en trabajoMangaDetalle.js:
// los comparte con Reportes > Trabajo de Manga, que ofrece las mismas
// acciones sobre el mismo listado.

function poblarSelectRodeoHistorialManga() {
  const select = el('hist-manga-filtro-rodeo');
  select.innerHTML = '<option value="">Todos los rodeos</option>';
  for (const r of obtenerRodeosCache()) {
    const opt = document.createElement('option');
    opt.value = r.id;
    opt.textContent = r.codigo;
    select.appendChild(opt);
  }
}

function renderFilasManga(trabajos) {
  const tbody = el('hist-manga-tabla').querySelector('tbody');
  tbody.innerHTML = '';
  if (!trabajos.length) {
    tbody.innerHTML = '<tr><td colspan="11">Sin trabajos de manga en el rango elegido.</td></tr>';
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
      <td></td>
    `;
    if (puedeAnularManga(t)) {
      const btnAnular = document.createElement('button');
      btnAnular.textContent = 'Anular';
      btnAnular.className = 'boton-anular';
      btnAnular.addEventListener('click', async () => {
        if (await anularTrabajoManga(t.id)) await cargarHistorialManga();
      });
      tr.lastElementChild.appendChild(btnAnular);
    }
    tbody.appendChild(tr);
  }
}

let ultimasFilasManga = [];

export async function cargarHistorialManga() {
  const mensaje = el('hist-manga-mensaje');
  mensaje.textContent = '';

  const codigo = el('hist-manga-filtro-codigo').value.trim();
  const rodeoId = el('hist-manga-filtro-rodeo').value;
  const usuarioId = el('hist-manga-filtro-usuario').value;
  const desde = el('hist-manga-filtro-desde').value;
  const hasta = el('hist-manga-filtro-hasta').value;

  try {
    ultimasFilasManga = await obtenerTrabajosConDetalle({ codigo, rodeoId, usuarioId, desde, hasta });
    renderFilasManga(ultimasFilasManga);
  } catch (error) {
    mensaje.textContent = `No se pudo cargar (¿sin conexión?): ${error.message}`;
    mensaje.className = 'error';
  }
}

function exportarManga() {
  if (!ultimasFilasManga.length) return;
  exportarTrabajosManga(ultimasFilasManga);
}

export function initHistorial() {
  poblarFiltros();
  cargarUsuariosFiltro();
  el('hist-filtrar').addEventListener('click', cargarHistorial);
  el('hist-exportar').addEventListener('click', exportar);
  cargarHistorial();

  el('hist-manga-filtrar').addEventListener('click', cargarHistorialManga);
  el('hist-manga-exportar').addEventListener('click', exportarManga);
  Promise.all([cargarRodeos(), cargarTitulares(), cargarCatalogosSanidad()]).then(() => {
    poblarSelectRodeoHistorialManga();
    cargarHistorialManga();
  });
}
