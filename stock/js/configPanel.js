// Panel de Configuración (CREAR USUARIO / ADMINISTRAR USUARIOS / Cerrar
// sesión) — portado del mismo panel que ya existía en Granos (index.html),
// para que quede accesible desde acá también sin tener que ir a Granos.
// A diferencia de Granos (scripts clásicos, onclick inline funciona porque
// las funciones cuelgan de window), acá todo se cablea con addEventListener
// porque este archivo es un módulo ES.
import { supabase } from './supabaseClient.js';
import { CATEGORIAS } from './config.js';
import { getEstado, cerrarSesion } from './auth.js';
import { cargarRodeos, obtenerRodeosCache, renombrarRodeo, darDeBajaRodeo, stockDelRodeo,
  cargarComposicionRodeos, composicionDelRodeo, hayComposicionCargada } from './rodeos.js';

function el(id) {
  return document.getElementById(id);
}

const ICONO_ENGRANAJE = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
const ICONO_FLECHA_IZQUIERDA = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>';
const ICONO_OJO = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z"/><circle cx="12" cy="12" r="3"/></svg>';
const ICONO_OJO_TACHADO = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 11 7 11 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.53 13.53 0 0 0 1 12s4 7 11 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/></svg>';

function wireMostrarClave(idInput, idBoton) {
  const input = el(idInput);
  const boton = el(idBoton);
  boton.innerHTML = ICONO_OJO;
  boton.addEventListener('click', () => {
    const mostrar = input.type === 'password';
    input.type = mostrar ? 'text' : 'password';
    boton.innerHTML = mostrar ? ICONO_OJO_TACHADO : ICONO_OJO;
  });
}

function abrirPanelConfig() {
  el('panelConfigFondo').classList.add('abierto');
  el('panelConfig').classList.add('abierto');
  fetch('/version.json').then((r) => r.json()).then((d) => {
    el('version-footer-panel').textContent = `v.${d.version}`;
  }).catch(() => {});
  // Dar (o quitar) acceso a las áreas del sistema es una operación que
  // solo puede hacer un owner (ya validado server-side en admin-*.js) —
  // acá además se ocultan esas secciones para el resto.
  const esOwnerActual = getEstado().perfil?.rol === 'owner';
  for (const seccion of ['usuarios', 'destinatarios', 'peligro']) {
    document.querySelector(`.panel-menu-item[data-seccion="${seccion}"]`).classList.toggle('oculto-panel', !esOwnerActual);
  }
  el('seccionUsuarios').classList.toggle('oculto-panel', !esOwnerActual);
  el('seccionDestinatarios').classList.toggle('oculto-panel', !esOwnerActual);
  el('seccionPeligro').classList.toggle('oculto-panel', !esOwnerActual);
}

function cerrarPanelConfig() {
  el('panelConfigFondo').classList.remove('abierto');
  el('panelConfig').classList.remove('abierto');
}

// Menú tipo acordeón: un click abre esa sección y cierra las demás; un
// segundo click sobre la misma la cierra.
function toggleSeccionConfig(nombre) {
  const secciones = { usuarios: 'seccionUsuarios', destinatarios: 'seccionDestinatarios', rodeos: 'seccionRodeos', peligro: 'seccionPeligro' };
  const yaAbierta = el(secciones[nombre]).classList.contains('abierta');
  for (const [clave, id] of Object.entries(secciones)) {
    el(id).classList.remove('abierta');
    document.querySelector(`.panel-menu-item[data-seccion="${clave}"]`).classList.remove('activo');
  }
  if (!yaAbierta) {
    el(secciones[nombre]).classList.add('abierta');
    document.querySelector(`.panel-menu-item[data-seccion="${nombre}"]`).classList.add('activo');
    if (nombre === 'usuarios') cargarUsuariosPanel();
    if (nombre === 'destinatarios') cargarPantallaDestinatarios();
    if (nombre === 'rodeos') cargarRodeosPanel();
  }
}

async function cerrarSesionDesdePanel() {
  if (!confirm('¿Cerrar sesión?')) return;
  cerrarPanelConfig();
  await cerrarSesion();
}

let usuariosCache = [];
let destinatariosNegocioCache = [];

async function cargarDestinatariosNegocio() {
  const { data, error } = await supabase.from('destinatarios_negocio').select('*').order('nombre');
  if (!error && data) destinatariosNegocioCache = data;
  return destinatariosNegocioCache;
}

function buscarDestinatarioPorEmail(email) {
  const buscado = (email || '').trim().toLowerCase();
  if (!buscado) return null;
  return destinatariosNegocioCache.find((d) => d.email.trim().toLowerCase() === buscado) || null;
}

async function cargarUsuariosPanel() {
  const { data, error } = await supabase.from('perfiles').select('*').order('nombre_completo');
  if (!error && data) usuariosCache = data;
  await cargarDestinatariosNegocio();
  renderListaUsuariosPanel();
}

function renderListaUsuariosPanel() {
  const select = el('cfgListaUsuarios');
  const seleccionPrevia = select.value;
  select.innerHTML = '<option value="">— Nuevo usuario —</option>';
  for (const u of usuariosCache) {
    const opt = document.createElement('option');
    opt.value = u.user_id;
    opt.textContent = `${u.nombre_completo} (${u.rol})`;
    select.appendChild(opt);
  }
  select.value = seleccionPrevia;
}

function limpiarFormularioUsuario() {
  el('cfgUsuarioNombre').value = '';
  el('cfgUsuarioEmail').value = '';
  el('cfgUsuarioTelefono').value = '';
  el('cfgUsuarioPassword').value = '';
  el('cfgUsuarioRol').value = 'encargado';
  el('cfgUsuarioAccesoHacienda').checked = true;
  el('cfgUsuarioAccesoHacienda').disabled = false;
  el('cfgUsuarioAccesoGranos').checked = false;
  el('cfgUsuarioAccesoGranos').disabled = false;
  el('cfgUsuarioAccesoRel').checked = false;
  el('cfgUsuarioAccesoRel').disabled = false;
  el('cfgUsuarioAccesoLogistica').checked = false;
  el('cfgUsuarioAccesoLogistica').disabled = false;
  el('cfgUsuarioRecibeLiq').checked = true;
  el('cfgUsuarioRecibeHacienda').checked = false;
  el('cfgUsuarioRecibeWhatsapp').checked = false;
  el('cfgUsuarioRecibeAlertasPrecios').checked = false;
}

// Un mismo formulario sirve para crear y editar — "— Nuevo usuario —"
// (value vacío) lo deja en blanco, listo para completar; elegir uno
// existente lo precarga. guardarUsuario() decide sola a qué endpoint
// pegarle según haya o no un user_id seleccionado.
function onSeleccionUsuarioLista() {
  const userId = el('cfgListaUsuarios').value;
  const esNuevo = !userId;
  el('cfgUsuarioMensaje').textContent = '';
  el('cfgUsuarioPasswordWrap').classList.toggle('oculto', !esNuevo);
  el('cfgCambiarClaveBloque').classList.toggle('oculto', esNuevo);
  el('cfgClaveNueva').value = '';
  el('botonGuardarUsuario').textContent = esNuevo ? 'Crear usuario' : 'Guardar cambios';

  if (esNuevo) {
    limpiarFormularioUsuario();
    return;
  }
  const usuario = usuariosCache.find((u) => u.user_id === userId);
  if (!usuario) return;
  const destinatario = buscarDestinatarioPorEmail(usuario.email);

  el('cfgUsuarioNombre').value = usuario.nombre_completo || '';
  el('cfgUsuarioEmail').value = usuario.email || '';
  el('cfgUsuarioTelefono').value = (destinatario && destinatario.telefono) || '';
  el('cfgUsuarioRol').value = usuario.rol;
  // Un owner siempre tiene acceso total, más allá de lo que digan las
  // casillas — se muestran tildadas y bloqueadas para reflejar eso.
  const esOwner = usuario.rol === 'owner';
  el('cfgUsuarioAccesoHacienda').checked = esOwner || !!usuario.acceso_hacienda;
  el('cfgUsuarioAccesoHacienda').disabled = esOwner;
  el('cfgUsuarioAccesoGranos').checked = esOwner || !!usuario.acceso_granos;
  el('cfgUsuarioAccesoGranos').disabled = esOwner;
  el('cfgUsuarioAccesoRel').checked = esOwner || !!usuario.acceso_precios_relativos;
  el('cfgUsuarioAccesoRel').disabled = esOwner;
  el('cfgUsuarioAccesoLogistica').checked = esOwner || !!usuario.acceso_logistica;
  el('cfgUsuarioAccesoLogistica').disabled = esOwner;
  el('cfgUsuarioRecibeLiq').checked = !!(destinatario && destinatario.recibe_liquidaciones);
  el('cfgUsuarioRecibeHacienda').checked = !!(destinatario && destinatario.recibe_hacienda);
  el('cfgUsuarioRecibeWhatsapp').checked = !!(destinatario && destinatario.recibe_whatsapp);
  el('cfgUsuarioRecibeAlertasPrecios').checked = !!(destinatario && destinatario.recibe_alertas_precios);
}

async function guardarUsuario() {
  const userId = el('cfgListaUsuarios').value;
  const esNuevo = !userId;
  const msj = el('cfgUsuarioMensaje');
  msj.textContent = '';

  const nombre_completo = el('cfgUsuarioNombre').value.trim();
  const email = el('cfgUsuarioEmail').value.trim();
  const telefono = el('cfgUsuarioTelefono').value.trim();
  const password = el('cfgUsuarioPassword').value;
  const rol = el('cfgUsuarioRol').value;
  const acceso_hacienda = el('cfgUsuarioAccesoHacienda').checked;
  const acceso_granos = el('cfgUsuarioAccesoGranos').checked;
  const acceso_precios_relativos = el('cfgUsuarioAccesoRel').checked;
  const acceso_logistica = el('cfgUsuarioAccesoLogistica').checked;
  const recibe_liquidaciones = el('cfgUsuarioRecibeLiq').checked;
  const recibe_hacienda = el('cfgUsuarioRecibeHacienda').checked;
  const recibe_whatsapp = el('cfgUsuarioRecibeWhatsapp').checked;
  const recibe_alertas_precios = el('cfgUsuarioRecibeAlertasPrecios').checked;

  if (!nombre_completo || !email || (esNuevo && !password)) {
    msj.textContent = esNuevo ? 'Completá nombre, email y contraseña.' : 'Faltan nombre y email.';
    msj.className = 'mensaje-panel error';
    return;
  }
  if (recibe_whatsapp && !telefono) {
    msj.textContent = 'Para recibir WhatsApp hace falta cargar el teléfono.';
    msj.className = 'mensaje-panel error';
    return;
  }

  const { data: { session } } = await supabase.auth.getSession();
  if (!session) { msj.textContent = 'No hay sesión activa.'; msj.className = 'mensaje-panel error'; return; }

  const endpoint = esNuevo ? 'admin-crear-usuario' : 'admin-actualizar-usuario';
  const payload = esNuevo
    ? { email, password, nombre_completo, telefono, rol, acceso_hacienda, acceso_granos, acceso_precios_relativos, acceso_logistica, recibe_liquidaciones, recibe_hacienda, recibe_whatsapp, recibe_alertas_precios }
    : { user_id: userId, nombre_completo, email, telefono, rol, acceso_hacienda, acceso_granos, acceso_precios_relativos, acceso_logistica, recibe_liquidaciones, recibe_hacienda, recibe_whatsapp, recibe_alertas_precios };

  try {
    const res = await fetch(`/.netlify/functions/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify(payload),
    });
    const datos = await res.json();
    if (!res.ok) {
      msj.textContent = datos.error || 'No se pudo guardar.';
      msj.className = 'mensaje-panel error';
      return;
    }
    await cargarUsuariosPanel();
    if (esNuevo) {
      el('cfgListaUsuarios').value = datos.user_id || '';
      onSeleccionUsuarioLista();
      msj.textContent = `Usuario "${nombre_completo}" creado.`;
    } else {
      el('cfgListaUsuarios').value = userId;
      msj.textContent = 'Usuario actualizado.';
    }
    msj.className = 'mensaje-panel ok';
  } catch (error) {
    msj.textContent = 'Error de red: ' + error.message;
    msj.className = 'mensaje-panel error';
  }
}

function renderDestinatarios() {
  const cont = el('cfgDestinatariosLista');
  if (!destinatariosNegocioCache.length) {
    cont.innerHTML = '<p style="font-size:0.85em;color:#666;">Sin destinatarios cargados.</p>';
    return;
  }
  cont.innerHTML = '';
  for (const d of destinatariosNegocioCache) {
    const avisos = [
      d.recibe_liquidaciones && 'Liq/Anul',
      d.recibe_hacienda && 'Resumen Hacienda',
      d.recibe_whatsapp && 'WhatsApp',
      d.recibe_alertas_precios && '$Rel',
    ].filter(Boolean).join(', ') || 'Ninguno';
    const fila = document.createElement('div');
    fila.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid #eee;';
    fila.innerHTML = `
      <div style="font-size:0.85em;">
        <strong>${d.nombre || d.email}</strong><br>
        <span style="color:#666;">${d.email} — ${avisos}</span>
      </div>
    `;
    const boton = document.createElement('button');
    boton.type = 'button';
    boton.className = 'boton-anular';
    boton.textContent = 'Quitar';
    boton.style.cssText = 'flex-shrink:0;width:auto;margin:0;padding:8px 12px;';
    boton.addEventListener('click', () => quitarDestinatario(d));
    fila.appendChild(boton);
    cont.appendChild(fila);
  }
}

async function cargarPantallaDestinatarios() {
  await cargarDestinatariosNegocio();
  renderDestinatarios();
}

async function quitarDestinatario(d) {
  const msj = el('cfgDestinatariosMensaje');
  msj.textContent = '';
  if (!confirm(`¿Quitar a "${d.nombre || d.email}" (${d.email}) de los destinatarios de avisos? Deja de recibir cualquier aviso — esto no borra ninguna cuenta de usuario, son cosas separadas.`)) return;
  const { error } = await supabase.from('destinatarios_negocio').delete().eq('id', d.id);
  if (error) {
    msj.textContent = 'No se pudo quitar: ' + error.message;
    msj.className = 'mensaje-panel error';
    return;
  }
  await cargarDestinatariosNegocio();
  renderDestinatarios();
  msj.textContent = `"${d.nombre || d.email}" quitado.`;
  msj.className = 'mensaje-panel ok';
}

async function cambiarClaveUsuario() {
  const user_id = el('cfgListaUsuarios').value;
  const password = el('cfgClaveNueva').value;
  const msj = el('cfgUsuarioMensaje');
  msj.textContent = '';

  if (!user_id || !password) {
    msj.textContent = 'Elegí un usuario de la lista y escribí la contraseña nueva.';
    msj.className = 'mensaje-panel error';
    return;
  }

  const { data: { session } } = await supabase.auth.getSession();
  if (!session) { msj.textContent = 'No hay sesión activa.'; msj.className = 'mensaje-panel error'; return; }

  try {
    const res = await fetch('/.netlify/functions/admin-cambiar-clave', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ user_id, password }),
    });
    const datos = await res.json();
    if (!res.ok) {
      msj.textContent = datos.error || 'No se pudo cambiar la contraseña.';
      msj.className = 'mensaje-panel error';
      return;
    }
    msj.textContent = 'Contraseña actualizada.';
    msj.className = 'mensaje-panel ok';
    el('cfgClaveNueva').value = '';
  } catch (error) {
    msj.textContent = 'Error de red: ' + error.message;
    msj.className = 'mensaje-panel error';
  }
}

// ─── Renombrar rodeo ───

async function cargarRodeosPanel() {
  // La composición dice de una cuánto tiene cada rodeo: sin eso habría que
  // consultar el stock de a uno para saber cuáles quedaron vacíos.
  await Promise.all([cargarRodeos(), cargarComposicionRodeos()]);
  renderListaRodeosPanel();
}

function textoStockDelRodeo(rodeoId) {
  if (!hayComposicionCargada()) return '';
  const composicion = composicionDelRodeo(rodeoId);
  if (!composicion.length) return 'sin stock';
  return composicion.map((c) => `${nombreCategoria(c.categoriaId)} ${c.cabezas}`).join(' · ');
}

function nombreCategoria(categoriaId) {
  return CATEGORIAS.find((c) => c.id === categoriaId)?.nombre || categoriaId;
}

// Los rodeos que ya no sirven: sin una sola cabeza adentro. Los 4 corrales
// de Feed Lot quedan afuera de esta lista aunque estén vacíos — tienen que
// existir siempre (ver darDeBajaRodeo en rodeos.js).
function rodeosSinStock() {
  if (!hayComposicionCargada()) return [];
  return obtenerRodeosCache().filter((r) => r.establecimiento_id !== 'feed_lot'
    && composicionDelRodeo(r.id).length === 0);
}

function renderRodeosSinStock() {
  const titulo = el('cfgRodeosSinStockTitulo');
  const lista = el('cfgRodeosSinStock');
  lista.innerHTML = '';

  if (!hayComposicionCargada()) {
    titulo.textContent = 'Sin conexión no se puede saber qué rodeos quedaron vacíos.';
    return;
  }
  const vacios = rodeosSinStock();
  if (!vacios.length) {
    titulo.textContent = 'Todos los rodeos tienen hacienda adentro.';
    return;
  }
  titulo.textContent = vacios.length === 1
    ? '1 rodeo sin stock — se puede dar de baja:'
    : `${vacios.length} rodeos sin stock — se pueden dar de baja:`;

  for (const rodeo of vacios) {
    const fila = document.createElement('div');
    fila.className = 'fila-cliente';
    const nombre = document.createElement('span');
    // textContent y no innerHTML: el nombre lo escribe el usuario.
    nombre.textContent = rodeo.codigo;
    fila.appendChild(nombre);
    const boton = document.createElement('button');
    boton.type = 'button';
    boton.textContent = 'Dar de baja';
    boton.addEventListener('click', () => darDeBajaRodeoDesdePanel(rodeo.id));
    fila.appendChild(boton);
    lista.appendChild(fila);
  }
}

function renderListaRodeosPanel() {
  const select = el('cfgListaRodeos');
  const seleccionPrevia = select.value;
  select.innerHTML = '<option value="">— Elegir rodeo —</option>';
  for (const r of obtenerRodeosCache()) {
    const opt = document.createElement('option');
    opt.value = r.id;
    const stock = textoStockDelRodeo(r.id);
    opt.textContent = stock ? `${r.codigo} — ${stock}` : r.codigo;
    select.appendChild(opt);
  }
  select.value = seleccionPrevia;
  renderRodeosSinStock();
}

async function onSeleccionRodeoLista() {
  const rodeoId = el('cfgListaRodeos').value;
  el('cfgRodeoMensaje').textContent = '';
  const rodeo = obtenerRodeosCache().find((r) => r.id === rodeoId);
  el('cfgRodeoNombreNuevo').value = rodeo ? rodeo.nombre : '';
  const stockEl = el('cfgRodeoStock');
  if (!rodeo) { stockEl.textContent = ''; return; }
  stockEl.textContent = 'Consultando stock...';
  try {
    const cabezas = await stockDelRodeo(rodeoId);
    stockEl.textContent = cabezas > 0 ? `Stock actual: ${cabezas} cabeza(s).` : 'Sin stock — se puede dar de baja.';
  } catch (error) {
    stockEl.textContent = 'No se pudo consultar el stock.';
  }
}

async function guardarNombreRodeo() {
  const rodeoId = el('cfgListaRodeos').value;
  const nombreNuevo = el('cfgRodeoNombreNuevo').value.trim();
  const msj = el('cfgRodeoMensaje');
  msj.textContent = '';
  if (!rodeoId) { msj.textContent = 'Elegí un rodeo de la lista primero.'; msj.className = 'mensaje-panel error'; return; }
  if (!nombreNuevo) { msj.textContent = 'Escribí el nombre nuevo.'; msj.className = 'mensaje-panel error'; return; }
  try {
    const actualizado = await renombrarRodeo(rodeoId, nombreNuevo);
    msj.textContent = `Renombrado a "${actualizado.codigo}".`;
    msj.className = 'mensaje-panel ok';
    renderListaRodeosPanel();
    el('cfgListaRodeos').value = rodeoId;
  } catch (error) {
    msj.textContent = 'No se pudo renombrar: ' + error.message;
    msj.className = 'mensaje-panel error';
  }
}

async function darDeBajaRodeoDesdePanel(idPedido) {
  const rodeoId = typeof idPedido === 'string' ? idPedido : el('cfgListaRodeos').value;
  const msj = el('cfgRodeoMensaje');
  msj.textContent = '';
  if (!rodeoId) { msj.textContent = 'Elegí un rodeo de la lista primero.'; msj.className = 'mensaje-panel error'; return; }
  const rodeo = obtenerRodeosCache().find((r) => r.id === rodeoId);
  if (!confirm(`¿Dar de baja "${rodeo?.codigo || rodeoId}"? Deja de aparecer en las listas de la app — su historial de movimientos no se borra.`)) return;
  try {
    await darDeBajaRodeo(rodeoId);
    msj.textContent = `"${rodeo?.codigo || ''}" dado de baja.`;
    msj.className = 'mensaje-panel ok';
    if (el('cfgListaRodeos').value === rodeoId) {
      el('cfgListaRodeos').value = '';
      el('cfgRodeoNombreNuevo').value = '';
      el('cfgRodeoStock').textContent = '';
    }
    renderListaRodeosPanel();
  } catch (error) {
    msj.textContent = 'No se pudo dar de baja: ' + error.message;
    msj.className = 'mensaje-panel error';
  }
}

const CLAVE_RESET_HACIENDA = '789058';

// Irreversible: borra TODOS los movimientos, Trabajo de Manga y rodeos
// (ver resetear_hacienda() en schema.sql). La clave fija es solo un freno
// contra un click accidental — la protección real es que la función RPC
// rechaza a cualquiera que no sea owner, sin importar qué clave se mande.
async function resetearHacienda() {
  const msj = el('cfgResetMensaje');
  msj.textContent = '';
  const clave = prompt(
    'Esto borra TODOS los movimientos, Trabajo de Manga y rodeos de Hacienda — no se puede deshacer.\n\nEscribí la clave para confirmar:'
  );
  if (clave === null) return;
  if (clave !== CLAVE_RESET_HACIENDA) {
    msj.textContent = 'Clave incorrecta — no se hizo nada.';
    msj.className = 'mensaje-panel error';
    return;
  }
  if (!confirm('Última confirmación: se borra TODO. ¿Seguís?')) return;

  msj.textContent = 'Reseteando...';
  msj.className = 'mensaje-panel';
  const { error } = await supabase.rpc('resetear_hacienda');
  if (error) {
    msj.textContent = 'No se pudo resetear: ' + error.message;
    msj.className = 'mensaje-panel error';
    return;
  }
  msj.textContent = 'Hacienda reseteada. Recargando...';
  msj.className = 'mensaje-panel ok';
  setTimeout(() => location.reload(), 1200);
}

export function initConfigPanel() {
  el('botonConfig').innerHTML = ICONO_ENGRANAJE;
  el('botonConfig').addEventListener('click', abrirPanelConfig);
  el('botonCerrarPanel').innerHTML = ICONO_FLECHA_IZQUIERDA;
  el('botonCerrarPanel').addEventListener('click', cerrarPanelConfig);
  el('panelConfigFondo').addEventListener('click', cerrarPanelConfig);
  document.querySelectorAll('.panel-menu-item[data-seccion]').forEach((btn) => {
    btn.addEventListener('click', () => toggleSeccionConfig(btn.dataset.seccion));
  });
  el('cfgListaUsuarios').addEventListener('change', onSeleccionUsuarioLista);
  el('botonGuardarUsuario').addEventListener('click', guardarUsuario);
  el('botonCambiarClave').addEventListener('click', cambiarClaveUsuario);
  el('botonCerrarSesionPanel').addEventListener('click', cerrarSesionDesdePanel);
  wireMostrarClave('cfgUsuarioPassword', 'cfgUsuarioMostrarClave');
  wireMostrarClave('cfgClaveNueva', 'cfgClaveMostrarClave');
  el('cfgListaRodeos').addEventListener('change', onSeleccionRodeoLista);
  el('botonRenombrarRodeo').addEventListener('click', guardarNombreRodeo);
  el('botonDarDeBajaRodeo').addEventListener('click', darDeBajaRodeoDesdePanel);
  el('botonResetearHacienda').addEventListener('click', resetearHacienda);
}
