import { initAuth, onAuthChange, iniciarSesion, cerrarSesion, getEstado } from './auth.js';
import { initSync, onSyncChange, reintentarErrores, outboxConError, descartarDeLaCola } from './sync.js';
import { TIPOS_MOVIMIENTO, CATEGORIAS } from './config.js';
import { obtenerTitularesCache } from './titulares.js';
import { obtenerRodeosCache } from './rodeos.js';
import { initMovimientos } from './movimientos.js';
import { initTrabajoManga } from './trabajoManga.js';
import { initDashboard } from './dashboard.js';
import { initHistorial } from './historial.js';
import { initReportes } from './reportes.js';
import { initBaston } from './baston.js';
import { initIndicesRecordatorio } from './indices.js';
import { initRouter } from './router.js';
import { initConfigPanel } from './configPanel.js';

function el(id) {
  return document.getElementById(id);
}

let appIniciada = false;

function iniciarPantallasDeLaApp(rol) {
  if (appIniciada) return;
  appIniciada = true;
  initMovimientos();
  initTrabajoManga();
  initDashboard();
  initHistorial();
  initReportes();
  initBaston();
  // El cartel de índices pendientes manda a Reportes > Índices, pantalla
  // que un puestero no tiene — no tiene sentido mostrárselo.
  if (rol !== 'puestero') initIndicesRecordatorio();
  initRouter(rol);
}

function actualizarBannerSync({ pendientes, conError }) {
  const banner = el('sync-estado');
  if (conError) {
    banner.textContent = `${conError} movimiento(s) que el servidor rechazó. Tocá para ver el detalle.`;
    banner.className = 'banner-sync error clickeable';
  } else if (pendientes) {
    banner.textContent = `${pendientes} movimiento(s) pendiente(s) de sincronizar...`;
    banner.className = 'banner-sync advertencia';
  } else {
    banner.textContent = 'Todo sincronizado.';
    banner.className = 'banner-sync ok';
  }
  // Si ya no hay rechazados (se reintentaron bien o se descartaron), el
  // panel de detalle no tiene nada que mostrar.
  if (!conError) el('sync-cola').classList.add('oculto');
}

const NOMBRES_TITULAR_BASE = { agro_salado: 'Agro Salado', dona_julia: 'Doña Julia' };

function nombreTitular(id) {
  if (!id) return '';
  return NOMBRES_TITULAR_BASE[id] || obtenerTitularesCache().find((t) => t.id === id)?.nombre || id;
}

// Una línea legible del movimiento trabado, para que se pueda reconocer
// cuál es sin tener que adivinar por el id.
function describirFilaCola(fila) {
  const partes = [TIPOS_MOVIMIENTO[fila.tipo_movimiento]?.nombre || fila.tipo_movimiento];
  if (fila.fecha) partes.push(fila.fecha.split('-').reverse().join('/'));
  partes.push(`${fila.cantidad_cabezas} cab.`);
  const categoria = CATEGORIAS.find((c) => c.id === (fila.categoria_origen || fila.categoria_destino))?.nombre;
  if (categoria) partes.push(categoria);
  const titular = nombreTitular(fila.titular_origen || fila.titular_destino);
  if (titular) partes.push(`de ${titular}`);
  const rodeo = obtenerRodeosCache().find((r) => r.id === fila.rodeo_id)?.codigo;
  if (rodeo) partes.push(`(${rodeo})`);
  return partes.join(' · ');
}

let ocupadoCola = false;

// Se arma con nodos del DOM, no con innerHTML: el texto del error trae
// nombres cargados por el usuario (rodeos, capitalizadores), y concatenarlos
// como HTML sería una vía de inyección.
async function renderColaErrores() {
  const panel = el('sync-cola');
  const items = await outboxConError();
  panel.textContent = '';
  if (!items.length) {
    panel.classList.add('oculto');
    return;
  }

  const titulo = document.createElement('div');
  titulo.className = 'cola-titulo';
  titulo.textContent = `El servidor rechazó ${items.length} movimiento(s)`;
  panel.appendChild(titulo);

  const ayuda = document.createElement('div');
  ayuda.className = 'cola-ayuda';
  ayuda.textContent = 'Están guardados en este celular pero no entraron al sistema. Corregí lo que diga el error y reintentá, o descartalos si ya no corresponden (descartar no se puede deshacer).';
  panel.appendChild(ayuda);

  for (const item of items) {
    const fila = document.createElement('div');
    fila.className = 'cola-item';

    const desc = document.createElement('div');
    desc.className = 'cola-item-desc';
    desc.textContent = describirFilaCola(item);
    fila.appendChild(desc);

    const error = document.createElement('div');
    error.className = 'cola-item-error';
    error.textContent = item.ultimo_error || 'Sin detalle del error.';
    fila.appendChild(error);

    const descartar = document.createElement('button');
    descartar.type = 'button';
    descartar.className = 'boton-secundario';
    descartar.textContent = 'Descartar este movimiento';
    descartar.addEventListener('click', async () => {
      if (ocupadoCola) return;
      if (!confirm(`¿Descartar este movimiento?\n\n${describirFilaCola(item)}\n\nNo se va a cargar nunca y no se puede deshacer.`)) return;
      ocupadoCola = true;
      try {
        await descartarDeLaCola(item.id);
        await renderColaErrores();
      } finally {
        ocupadoCola = false;
      }
    });
    fila.appendChild(descartar);

    panel.appendChild(fila);
  }

  const acciones = document.createElement('div');
  acciones.className = 'cola-acciones';
  const reintentar = document.createElement('button');
  reintentar.type = 'button';
  reintentar.className = 'boton-secundario';
  reintentar.textContent = 'Reintentar todos';
  reintentar.addEventListener('click', async () => {
    if (ocupadoCola) return;
    ocupadoCola = true;
    reintentar.textContent = 'Reintentando...';
    reintentar.disabled = true;
    try {
      await reintentarErrores();
      await renderColaErrores();
    } finally {
      ocupadoCola = false;
    }
  });
  acciones.appendChild(reintentar);
  panel.appendChild(acciones);

  panel.classList.remove('oculto');
}

function wireSyncBanner() {
  el('sync-estado').addEventListener('click', async () => {
    const panel = el('sync-cola');
    if (!panel.classList.contains('oculto')) {
      panel.classList.add('oculto');
      return;
    }
    await renderColaErrores();
  });
}

function mostrarLogin(mensajeError) {
  el('pantalla-login').classList.remove('oculto');
  el('app-shell').classList.add('oculto');
  el('login-cargando').classList.add('oculto');
  el('login-form').classList.remove('oculto');
  if (mensajeError) {
    el('login-mensaje').textContent = mensajeError;
    el('login-mensaje').className = 'error';
  }
}

function mostrarApp(perfil) {
  el('pantalla-login').classList.add('oculto');
  el('app-shell').classList.remove('oculto');
  el('usuario-nombre').textContent = `${perfil.nombre_completo} (${perfil.rol})`;
  iniciarPantallasDeLaApp(perfil.rol);
}

function wireTabBar() {
  el('tabbar-granos').addEventListener('click', () => {
    const perfil = getEstado().perfil;
    if (perfil?.rol !== 'owner' && !perfil?.acceso_granos) {
      alert('No tenés permisos para acceder a Granos.');
      return;
    }
    window.location.href = '/';
  });
  el('tabbar-posgranaria').addEventListener('click', () => {
    if (getEstado().perfil?.rol !== 'owner') {
      alert('No tenés permisos para acceder a Pos. Granaria.');
      return;
    }
    alert('Pos. Granaria: próximamente 🚧');
  });
  el('tabbar-rel').addEventListener('click', () => {
    const perfil = getEstado().perfil;
    if (perfil?.rol !== 'owner' && !perfil?.acceso_precios_relativos) {
      alert('No tenés permisos para acceder a $Rel.');
      return;
    }
    window.location.href = '/rel/';
  });
  el('tabbar-logistica').addEventListener('click', () => {
    const perfil = getEstado().perfil;
    if (perfil?.rol !== 'owner' && !perfil?.acceso_logistica) {
      alert('No tenés permisos para acceder a Logística.');
      return;
    }
    window.location.href = '/logistica/';
  });
}

const ICONO_OJO = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z"/><circle cx="12" cy="12" r="3"/></svg>';
const ICONO_OJO_TACHADO = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 11 7 11 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.53 13.53 0 0 0 1 12s4 7 11 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/></svg>';

function wireMostrarClave() {
  const input = el('login-password');
  const boton = el('login-mostrar-clave');
  boton.innerHTML = ICONO_OJO;
  boton.addEventListener('click', () => {
    const mostrar = input.type === 'password';
    input.type = mostrar ? 'text' : 'password';
    boton.innerHTML = mostrar ? ICONO_OJO_TACHADO : ICONO_OJO;
  });
}

function wireLogin() {
  el('login-form').addEventListener('submit', async (evento) => {
    evento.preventDefault();
    const email = el('login-email').value.trim();
    const password = el('login-password').value;
    el('login-mensaje').textContent = '';
    try {
      await iniciarSesion(email, password);
    } catch (error) {
      el('login-mensaje').textContent = 'No se pudo iniciar sesión. Revisá el email y la contraseña.';
      el('login-mensaje').className = 'error';
      console.error(error);
    }
  });

  el('logout-boton').addEventListener('click', async () => {
    await cerrarSesion();
    location.hash = '';
  });
}

function wireAuth() {
  onAuthChange((estado) => {
    if (!estado.listo) return;
    if (!estado.session) {
      mostrarLogin();
      return;
    }
    if (!estado.perfil) {
      mostrarLogin('Tu usuario no tiene un perfil asignado en el sistema. Contactá al administrador.');
      return;
    }
    // Un owner siempre tiene acceso total; para el resto hace falta el
    // tilde explícito de "Acceso a Hacienda" (Configuración > Administrar
    // usuarios, en Granos).
    if (estado.perfil.rol !== 'owner' && estado.perfil.acceso_hacienda === false) {
      mostrarLogin('No tenés acceso a Hacienda. Contactá al administrador.');
      return;
    }
    mostrarApp(estado.perfil);
  });
}

async function main() {
  // Versión única compartida con Granos: /version.json en la raíz del sitio
  // (funciona igual desde /stock/ porque es una ruta absoluta).
  fetch('/version.json').then((r) => r.json()).then((d) => {
    el('version-footer').textContent = `v.${d.version}`;
  }).catch(() => {});
  wireTabBar();
  wireLogin();
  wireMostrarClave();
  wireAuth();
  wireSyncBanner();
  initConfigPanel();
  onSyncChange(actualizarBannerSync);
  await initAuth();
  initSync();
}

main();
