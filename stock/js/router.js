import { refrescarDashboard } from './dashboard.js';
import { cargarHistorial, cargarHistorialManga } from './historial.js';
import { refrescarConsultaManga } from './trabajoManga.js';
import { refrescarReportes } from './reportes.js';
import { refrescarBaston } from './baston.js';
import { refrescarConsultaEstablecimiento, refrescarRodeosDeCarga } from './movimientos.js';

const PANTALLAS_TODAS = ['cargar', 'manga', 'dashboard', 'baston', 'reportes', 'historial'];
// Un puestero carga datos pero no ve Stock/Historial/Reportes (esas
// pantallas quedan para encargado/administrativo/owner).
const PANTALLAS_PUESTERO = ['cargar', 'manga'];

function el(id) {
  return document.getElementById(id);
}

function pantallasDelRol(rol) {
  return rol === 'puestero' ? PANTALLAS_PUESTERO : PANTALLAS_TODAS;
}

function pantallaPorDefecto(rol) {
  return rol === 'owner' ? 'dashboard' : 'cargar';
}

function renderRoute(rol) {
  const pantallas = pantallasDelRol(rol);
  let pantalla = location.hash.slice(1);
  if (!pantallas.includes(pantalla)) {
    pantalla = pantallaPorDefecto(rol);
    location.hash = pantalla;
    return; // el cambio de hash vuelve a disparar renderRoute
  }

  for (const nombre of PANTALLAS_TODAS) {
    el(`pantalla-${nombre}`).classList.toggle('oculto', nombre !== pantalla);
  }
  document.querySelectorAll('[data-ir]').forEach((btn) => {
    btn.classList.toggle('activo', btn.dataset.ir === pantalla);
  });

  if (pantalla === 'dashboard') refrescarDashboard();
  if (pantalla === 'historial') { cargarHistorial(); cargarHistorialManga(); }
  // La caché de rodeos se carga una sola vez al entrar a la app — si
  // alguien corrió una migración o cargó algo desde otra sesión mientras
  // esta quedó abierta, Cargar movimiento (que resuelve rodeos por
  // corral en Feed Lot, sin selector manual ni "+Crear nuevo..." de
  // respaldo) se queda con datos viejos. Se refresca cada vez que se
  // entra a esta pantalla para que eso no se note.
  if (pantalla === 'cargar') { refrescarConsultaEstablecimiento(); refrescarRodeosDeCarga(); }
  if (pantalla === 'manga') refrescarConsultaManga();
  if (pantalla === 'baston') refrescarBaston();
  if (pantalla === 'reportes') refrescarReportes();
}

export function initRouter(rol) {
  const pantallas = pantallasDelRol(rol);
  document.querySelectorAll('[data-ir]').forEach((btn) => {
    btn.addEventListener('click', () => { location.hash = btn.dataset.ir; });
    btn.classList.toggle('oculto', !pantallas.includes(btn.dataset.ir));
  });
  window.addEventListener('hashchange', () => renderRoute(rol));
  renderRoute(rol);
}
