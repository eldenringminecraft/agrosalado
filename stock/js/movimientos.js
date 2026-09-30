import {
  TIPOS_MOVIMIENTO, ESTABLECIMIENTOS, CATEGORIAS, SIGUIENTE_CATEGORIA, DESTINO_VENTA,
  KILOS_MIN_SANIDAD, KILOS_MAX_SANIDAD,
} from './config.js';
import { supabase } from './supabaseClient.js';
import { encolarMovimiento } from './sync.js';
import { getEstado } from './auth.js';
import { cargarTitulares, obtenerTitularesCache, crearCapitalizador, crearCliente } from './titulares.js';
import { cargarCompradores, obtenerCompradoresCache, crearComprador } from './compradores.js';
import { cargarRodeos, rodeosDeEstablecimiento, obtenerRodeosCache, crearRodeo, stockDelRodeoPorCategoriaYTitular, stockDetalleRodeoCategoriaYTitular, stockDetalladoDelRodeo, rodeoDelCorral, cargarComposicionRodeos, hayComposicionCargada, composicionDelRodeo, cabezasDelRodeoEnCategoria } from './rodeos.js';
import { crearGrupoBotones, obtenerSeleccion, establecerSeleccion, limpiarSeleccion } from './botones.js';

// Id del movimiento que se está corrigiendo, o null en carga normal — ver
// precargarParaEditar() (disparado desde historial.js vía evento, para no
// armar un import circular entre los dos módulos).
let editandoId = null;

const CAMPOS = [
  'establecimiento_origen', 'establecimiento_destino',
  'categoria_origen', 'categoria_destino',
  'titular_origen', 'titular_destino',
  'rodeo_destino', 'cliente',
  'destino_venta', 'comprador',
];

function el(id) {
  return document.getElementById(id);
}

function aplicarBloqueoAperturaStock() {
  const boton = document.querySelector('#mov-tipo .boton-opcion[data-value="apertura_stock"]');
  if (!boton) return;
  const rol = getEstado().perfil?.rol;
  if (rol !== 'owner') {
    boton.disabled = true;
    boton.classList.add('deshabilitado');
    boton.title = 'Solo un owner puede cargar una apertura de stock';
  }
}

// ─── titularidad: Agro Salado / Doña Julia / Capitalizador (+ lista) ───

function poblarSelectCapitalizadores(idSelect) {
  const select = el(idSelect);
  const valorPrevio = select.value;
  select.innerHTML = '';
  const opcionVacia = document.createElement('option');
  opcionVacia.value = '';
  opcionVacia.textContent = 'Elegir...';
  select.appendChild(opcionVacia);
  for (const c of obtenerTitularesCache().filter((t) => t.tipo === 'capitalizador')) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.nombre;
    select.appendChild(opt);
  }
  const opcionNueva = document.createElement('option');
  opcionNueva.value = '__nuevo__';
  opcionNueva.textContent = '+ Agregar nuevo...';
  select.appendChild(opcionNueva);
  if (valorPrevio) select.value = valorPrevio;
}

function inicializarTitular(prefijo) {
  const idTipo = `mov-titular-${prefijo}-tipo`;
  const idSelectWrap = `mov-titular-${prefijo}-cap-wrap`;
  const idSelect = `mov-titular-${prefijo}-cap`;

  crearGrupoBotones(idTipo, [
    { id: 'agro_salado', nombre: 'Agro Salado' },
    { id: 'dona_julia', nombre: 'Doña Julia' },
    { id: 'capitalizador', nombre: 'Capitalizador' },
  ]);
  poblarSelectCapitalizadores(idSelect);

  el(idTipo).addEventListener('cambio', () => {
    const tipo = obtenerSeleccion(idTipo);
    el(idSelectWrap).classList.toggle('oculto', tipo !== 'capitalizador');
  });

  el(idSelect).addEventListener('change', async () => {
    const select = el(idSelect);
    if (select.value !== '__nuevo__') return;
    const nombre = prompt('Nombre del nuevo capitalizador:');
    if (!nombre || !nombre.trim()) {
      select.value = '';
      return;
    }
    try {
      const nuevo = await crearCapitalizador(nombre.trim());
      poblarSelectCapitalizadores(idSelect);
      select.value = nuevo.id;
    } catch (error) {
      alert('No se pudo crear el capitalizador: ' + error.message);
      select.value = '';
    }
  });
}

function obtenerTitular(prefijo) {
  const tipo = obtenerSeleccion(`mov-titular-${prefijo}-tipo`);
  if (!tipo) return '';
  if (tipo === 'capitalizador') {
    const valor = el(`mov-titular-${prefijo}-cap`).value;
    return valor && valor !== '__nuevo__' ? valor : '';
  }
  return tipo;
}

function limpiarTitular(prefijo) {
  limpiarSeleccion(`mov-titular-${prefijo}-tipo`);
  el(`mov-titular-${prefijo}-cap-wrap`).classList.add('oculto');
  el(`mov-titular-${prefijo}-cap`).value = '';
}

// Para precargar el formulario al editar: reconstruye la selección
// tipo+capitalizador a partir de un titular_id ya resuelto.
function precargarTitular(prefijo, titularId) {
  if (!titularId) { limpiarTitular(prefijo); return; }
  const esBase = titularId === 'agro_salado' || titularId === 'dona_julia';
  establecerSeleccion(`mov-titular-${prefijo}-tipo`, esBase ? titularId : 'capitalizador');
  if (!esBase) {
    el(`mov-titular-${prefijo}-cap-wrap`).classList.remove('oculto');
    el(`mov-titular-${prefijo}-cap`).value = titularId;
  }
}

// ─── Cliente (Hotelería): lista aparte de titulares.tipo='cliente', no se
// mezcla con Agro Salado/Doña Julia/Capitalizador de arriba ───

function poblarSelectCliente() {
  const select = el('mov-cliente');
  const valorPrevio = select.value;
  select.innerHTML = '';
  const opcionVacia = document.createElement('option');
  opcionVacia.value = '';
  opcionVacia.textContent = 'Elegir...';
  select.appendChild(opcionVacia);
  for (const c of obtenerTitularesCache().filter((t) => t.tipo === 'cliente')) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.nombre;
    select.appendChild(opt);
  }
  const opcionNueva = document.createElement('option');
  opcionNueva.value = '__nuevo__';
  opcionNueva.textContent = '+ Agregar nuevo...';
  select.appendChild(opcionNueva);
  if (valorPrevio) select.value = valorPrevio;
}

function inicializarCliente() {
  poblarSelectCliente();
  el('mov-cliente').addEventListener('change', async () => {
    const select = el('mov-cliente');
    if (select.value !== '__nuevo__') return;
    const nombre = prompt('Nombre del cliente:');
    if (!nombre || !nombre.trim()) {
      select.value = '';
      return;
    }
    try {
      const nuevo = await crearCliente(nombre.trim());
      poblarSelectCliente();
      select.value = nuevo.id;
    } catch (error) {
      alert('No se pudo crear el cliente: ' + error.message);
      select.value = '';
    }
  });
}

// Valor limpio del select de Cliente (nunca '__nuevo__', que es solo el
// disparador del alta on-the-fly).
function obtenerCliente() {
  const valor = el('mov-cliente').value;
  return valor && valor !== '__nuevo__' ? valor : '';
}

// ─── Comprador (Venta): trazabilidad de a quién se le vendió, no afecta
// stock ni titularidad — lista propia (compradores.js), mismo patrón
// "+ Agregar nuevo..." que Cliente/Capitalizador ───

function poblarSelectComprador() {
  const select = el('mov-comprador');
  const valorPrevio = select.value;
  select.innerHTML = '';
  const opcionVacia = document.createElement('option');
  opcionVacia.value = '';
  opcionVacia.textContent = 'Elegir...';
  select.appendChild(opcionVacia);
  for (const c of obtenerCompradoresCache()) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.nombre;
    select.appendChild(opt);
  }
  const opcionNueva = document.createElement('option');
  opcionNueva.value = '__nuevo__';
  opcionNueva.textContent = '+ Agregar nuevo...';
  select.appendChild(opcionNueva);
  if (valorPrevio) select.value = valorPrevio;
}

function inicializarComprador() {
  poblarSelectComprador();
  el('mov-comprador').addEventListener('change', async () => {
    const select = el('mov-comprador');
    if (select.value !== '__nuevo__') return;
    const nombre = prompt('Nombre del comprador:');
    if (!nombre || !nombre.trim()) {
      select.value = '';
      return;
    }
    try {
      const nuevo = await crearComprador(nombre.trim());
      poblarSelectComprador();
      select.value = nuevo.id;
    } catch (error) {
      alert('No se pudo crear el comprador: ' + error.message);
      select.value = '';
    }
  });
}

function obtenerComprador() {
  const valor = el('mov-comprador').value;
  return valor && valor !== '__nuevo__' ? valor : '';
}

// El rodeo de origen ya tiene cabezas de titulares puntuales — no tiene
// sentido dejar elegir una titularidad de origen que ese rodeo ni
// siquiera tiene (ej. rodeo con AS + DJ, no debería poder elegirse un
// capitalizador). Se nublan (deshabilitan) las opciones que no
// corresponden, best-effort: si falla la consulta (sin conexión) se
// deja todo habilitado como hasta ahora, no bloquea la carga.
async function actualizarTitularesOrigenDisponibles() {
  const grupo = el('mov-titular-origen-tipo');
  const capSelect = el('mov-titular-origen-cap');
  const habilitarTodo = () => {
    grupo.querySelectorAll('.boton-opcion').forEach((b) => { b.disabled = false; b.classList.remove('deshabilitado'); });
    [...capSelect.options].forEach((o) => { o.disabled = false; });
  };

  const cfg = TIPOS_MOVIMIENTO[obtenerSeleccion('mov-tipo')];
  if (!cfg || !cfg.campos.includes('titular_origen')) { habilitarTodo(); return; }
  const rodeoId = rodeoOrigenActual(cfg)?.id;
  if (!rodeoId || !navigator.onLine) {
    habilitarTodo();
    return;
  }

  // Solo los titulares que tienen stock DE ESA CATEGORÍA en ese rodeo:
  // que un rodeo tenga vacas de Agro Salado no significa que también
  // tenga sus novillos. Si todavía no se eligió categoría, alcanza con
  // que tengan algo adentro. Se incluye la categoría anterior de la
  // cadena para no tapar el cambio de categoría express (el lote que
  // engordó y cuyo cambio nadie cargó todavía).
  const categoriaId = cfg.campos.includes('categoria_origen') ? obtenerSeleccion('mov-categoria-origen') : '';
  const anteriorId = categoriaId && obtenerSeleccion('mov-tipo') !== 'cambio_categoria'
    ? categoriaAnterior(categoriaId)
    : null;

  let disponibles;
  try {
    const detalle = await stockDetalladoDelRodeo(rodeoId);
    disponibles = new Set(detalle
      .filter((f) => !categoriaId || f.categoriaId === categoriaId || f.categoriaId === anteriorId)
      .map((f) => f.titularId));
  } catch (error) {
    console.warn('No se pudo verificar qué titulares tiene ese rodeo:', error);
    habilitarTodo();
    return;
  }
  if (!disponibles.size) { habilitarTodo(); return; }

  grupo.querySelectorAll('.boton-opcion').forEach((boton) => {
    const valor = boton.dataset.value;
    const activo = valor === 'capitalizador'
      ? [...capSelect.options].some((o) => o.value && o.value !== '__nuevo__' && disponibles.has(o.value))
      : disponibles.has(valor);
    boton.disabled = !activo;
    boton.classList.toggle('deshabilitado', !activo);
    if (!activo && boton.classList.contains('seleccionado')) {
      boton.classList.remove('seleccionado');
      grupo.dispatchEvent(new Event('cambio'));
    }
  });
  [...capSelect.options].forEach((opcion) => {
    if (!opcion.value || opcion.value === '__nuevo__') return;
    opcion.disabled = !disponibles.has(opcion.value);
  });
}

// ─── rodeo: obligatorio, se filtra por la categoría/establecimiento
// "relevante" del tipo de movimiento actual ───

// Para la mayoría de los tipos solo hay un lado (origen O destino) por
// campo; para los que tienen los dos (traslado, cambio_categoria,
// cambio_titular) el rodeo se identifica por el lado ORIGEN, porque es
// el rodeo que ya existe y se está moviendo/modificando — el destino se
// duplica del origen (ver duplicar*EnDestino en config.js).
function campoRelevante(cfg, base) {
  return cfg.campos.includes(`${base}_origen`) ? 'origen' : 'destino';
}

// El rodeo del lado ORIGEN, venga de donde venga: si ese lado es Feed Lot
// el selector de Rodeo está oculto y el rodeo sale del corral elegido (ver
// actualizarRequeridoRodeo); si no, del selector de Rodeo de siempre.
// Devuelve el rodeo entero (no solo el id) porque quien lo llama suele
// necesitar el código o el corral para armar un mensaje.
function rodeoOrigenActual(cfg) {
  if (establecimientosResueltos(cfg).origen === 'feed_lot') {
    return rodeoDelCorral(obtenerSeleccion('mov-feedlot-corral-origen')) || null;
  }
  const id = el(RODEO_ORIGEN_IDS.select).value;
  if (!id || id === '__nuevo__') return null;
  return obtenerRodeosCache().find((r) => r.id === id) || null;
}

// ─── Feed Lot: se organiza por CORRAL, no por Rodeo ─────────────────────
// Acordado con Juan tras varios bugs en cadena (corral sin categoría
// correcta, rodeo creado de más, corral sin guardar por una falla de
// red): en Feed Lot dejan de crearse/buscarse rodeos por categoría —
// existen 4 corrales FIJOS ("Corral n°1".."Corral n°4", ver migración
// 039 y rodeoDelCorral en rodeos.js) que siempre existen y pueden tener
// stock de varias categorías y titulares a la vez. Cualquier movimiento
// que toque Feed Lot (de cualquier lado, incluida Hotelería) elige un
// corral con un botón en vez de un selector de Rodeo — nunca hay que
// "encontrar" ni "crear" nada, el corral resuelve el rodeo siempre.
//
// Devuelve, para el tipo/establecimientos actuales, qué lado(s) del
// formulario hay que resolver por corral en vez de por selector de Rodeo:
// - principalEnFeedLot: el selector genérico "Rodeo" (mov-rodeo) — que
//   representa el lado ORIGEN si el tipo lo tiene (venta, traslado,
//   cambio_categoria, cambio_titular, cambio_rodeo, salida_hoteleria) o
//   el lado DESTINO si no (compra_invernada, apertura_stock, parición,
//   hotelería) — necesita corral en vez de Rodeo.
// - destinoSecundarioEnFeedLot: el selector "Rodeo destino"
//   (mov-rodeo-destino, solo Traslado/Cambio de rodeo) necesita corral.
// Un mismo movimiento puede necesitar los dos a la vez (Cambio de rodeo
// moviendo animales de un corral a otro).
function ladoRodeoPrincipal(cfg) {
  if (cfg.establecimientoOrigenFijo) return 'origen';
  if (cfg.establecimientoDestinoFijo) return 'destino';
  return campoRelevante(cfg, 'establecimiento');
}

function estadoFeedLot(cfg, establecimientoOrigen, establecimientoDestino) {
  const establecimientoPrincipal = ladoRodeoPrincipal(cfg) === 'origen' ? establecimientoOrigen : establecimientoDestino;
  return {
    principalEnFeedLot: establecimientoPrincipal === 'feed_lot',
    destinoSecundarioEnFeedLot: cfg.campos.includes('rodeo_destino') && establecimientoDestino === 'feed_lot',
  };
}

// Establecimiento origen/destino ya resueltos (fijo o elegido) para el
// tipo actual — mismo cálculo que hace leerFormulario(), reusado acá para
// no duplicarlo en cada función que necesita saber si Feed Lot está
// involucrado antes de leer el formulario completo.
function establecimientosResueltos(cfg) {
  return {
    origen: cfg.establecimientoOrigenFijo || (cfg.campos.includes('establecimiento_origen') ? obtenerSeleccion('mov-establecimiento-origen') : null),
    destino: cfg.establecimientoDestinoFijo || (cfg.campos.includes('establecimiento_destino') ? obtenerSeleccion('mov-establecimiento-destino') : null),
  };
}

// IDs de los dos selectores de rodeo posibles — "origen" (siempre visible,
// el rodeo que ya existe) y "destino" (solo para cambio_rodeo: separar/
// fusionar animales en OTRO rodeo). Mismos ids que usaba el selector único
// original para no tener que tocar el resto del formulario.
const RODEO_ORIGEN_IDS = {
  select: 'mov-rodeo', wrap: 'mov-rodeo-nuevo-wrap',
  nombre: 'mov-rodeo-nuevo-nombre', fecha: 'mov-rodeo-nuevo-fecha', crear: 'mov-rodeo-nuevo-crear',
};
const RODEO_DESTINO_IDS = {
  select: 'mov-rodeo-destino', wrap: 'mov-rodeo-destino-nuevo-wrap',
  nombre: 'mov-rodeo-destino-nuevo-nombre', fecha: 'mov-rodeo-destino-nuevo-fecha', crear: 'mov-rodeo-destino-nuevo-crear',
};

// Para el rodeo destino, si el tipo tiene un establecimiento_destino
// REAL (no duplicado del origen — hoy solo cambio_rodeo), el rodeo se
// filtra por ESE establecimiento, no por el de origen: el rodeo destino
// puede estar en otro establecimiento. Hotelería/Salida de hotelería
// tienen el establecimiento FIJO (siempre feed_lot, sin selector).
function establecimientoParaRodeo(cfg, ids) {
  if (cfg.establecimientoOrigenFijo || cfg.establecimientoDestinoFijo) {
    return cfg.establecimientoOrigenFijo || cfg.establecimientoDestinoFijo;
  }
  if (ids === RODEO_DESTINO_IDS && cfg.campos.includes('establecimiento_destino')) {
    return obtenerSeleccion('mov-establecimiento-destino');
  }
  return obtenerSeleccion(`mov-establecimiento-${campoRelevante(cfg, 'establecimiento')}`);
}

// Qué dice cada opción del selector de rodeo. Hasta acá decía solo el
// código ("Vaquillona San Miguel 202601"), que es la ETIQUETA del rodeo y
// puede estar vieja. Ahora dice además lo que el rodeo tiene de verdad
// hoy, que es lo que uno necesita saber para elegir:
//   San Miguel 202601 — Novillito 118 · Novillo 40
function textoOpcionRodeo(rodeo, nota) {
  const partes = [rodeo.codigo];
  if (hayComposicionCargada()) {
    const composicion = composicionDelRodeo(rodeo.id);
    partes.push(composicion.length
      ? composicion.map((c) => `${nombreCategoria(c.categoriaId)} ${c.cabezas}`).join(' · ')
      : 'sin stock');
  }
  if (nota) partes.push(nota);
  return partes.join(' — ');
}

function nombreCategoria(categoriaId) {
  return CATEGORIAS.find((c) => c.id === categoriaId)?.nombre || categoriaId;
}

// Qué rodeos se ofrecen. Del lado que SACA animales se arma con el stock
// real (quién tiene esa categoría hoy), no con rodeos.categoria_id: un
// rodeo etiquetado "Novillito" que ya tiene novillos adentro aparece
// cuando buscás novillos, y uno etiquetado bien pero vacío no aparece.
// Sin conexión no hay composición cargada, así que se vuelve al filtro
// por etiqueta de siempre — peor, pero nunca deja el selector vacío.
//
// Además se siguen ofreciendo los rodeos que solo tienen la categoría
// ANTERIOR de la cadena (el lote que engordó y cuyo Cambio de categoría
// nadie cargó): al elegirlos aparece el aviso de cambio de categoría
// express, que resuelve la diferencia sin salir de la pantalla. Se excluye
// Cambio de categoría: ahí mezclar la categoría anterior induce a error.
function rodeosParaElegir(cfg, ids, establecimientoId) {
  const delEstablecimiento = rodeosDeEstablecimiento(establecimientoId);
  const esLadoQueSaca = ids === RODEO_ORIGEN_IDS && ladoRodeoPrincipal(cfg) === 'origen';
  // El lado que RECIBE animales ofrece todos los rodeos del
  // establecimiento: un rodeo ya no es "de una categoría" (migración
  // 045), así que los terneros al pie pueden entrar al rodeo de las
  // vacas sin tener que crear uno aparte. Sin composición cargada
  // (offline) el lado que saca hace lo mismo — mejor ofrecer de más que
  // dejar el selector vacío.
  if (!esLadoQueSaca || !hayComposicionCargada()) {
    return delEstablecimiento.map((rodeo) => ({ rodeo, nota: null }));
  }
  // Del lado que saca, los que tienen algo adentro: de un rodeo vacío no
  // se puede sacar nada, y ofrecerlo solo hace perder el viaje.
  return delEstablecimiento
    .filter((rodeo) => composicionDelRodeo(rodeo.id).length > 0)
    .map((rodeo) => ({ rodeo, nota: null }));
}

function poblarSelectRodeo(ids, excluirId) {
  const cfg = TIPOS_MOVIMIENTO[obtenerSeleccion('mov-tipo')];
  if (!cfg) return;
  const establecimientoId = establecimientoParaRodeo(cfg, ids);

  const select = el(ids.select);
  const valorPrevio = select.value;
  select.innerHTML = '';
  const opcionVacia = document.createElement('option');
  opcionVacia.value = '';
  opcionVacia.textContent = 'Elegir...';
  select.appendChild(opcionVacia);

  // El rodeo ya no depende de la categoría: se elige primero el rodeo y
  // después qué sale de ahí (ver actualizarCategoriasOrigenDisponibles).
  if (establecimientoId) {
    for (const { rodeo, nota } of rodeosParaElegir(cfg, ids, establecimientoId)) {
      if (excluirId && rodeo.id === excluirId) continue;
      const opt = document.createElement('option');
      opt.value = rodeo.id;
      opt.textContent = textoOpcionRodeo(rodeo, nota);
      select.appendChild(opt);
    }
  }
  // Un puestero no da de alta rodeos — solo puede elegir entre los que ya existen.
  if (getEstado().perfil?.rol !== 'puestero') {
    const opcionNueva = document.createElement('option');
    opcionNueva.value = '__nuevo__';
    opcionNueva.textContent = '+ Crear rodeo nuevo...';
    select.appendChild(opcionNueva);
  }

  if (valorPrevio && [...select.options].some((o) => o.value === valorPrevio)) select.value = valorPrevio;
}

// Lo que hay adentro del rodeo (o corral) del que se van a sacar los
// animales, arriba de la categoría — que es donde hace falta saberlo.
// Sale de la composición cacheada, la misma que arma los selectores.
function actualizarStockDelRodeoTexto() {
  const contenedor = el('mov-rodeo-stock');
  const cfg = TIPOS_MOVIMIENTO[obtenerSeleccion('mov-tipo')];
  const rodeo = cfg && ladoRodeoPrincipal(cfg) === 'origen' ? rodeoOrigenActual(cfg) : null;
  if (!rodeo || !hayComposicionCargada()) {
    contenedor.classList.add('oculto');
    contenedor.textContent = '';
    return;
  }
  const composicion = composicionDelRodeo(rodeo.id);
  contenedor.textContent = composicion.length
    ? `En ${rodeo.codigo} hay: ${composicion.map((c) => `${nombreCategoria(c.categoriaId)} ${c.cabezas}`).join(' · ')}.`
    : `${rodeo.codigo} no tiene stock.`;
  contenedor.classList.remove('oculto');
}

// El rodeo destino nunca puede ser el mismo que el de origen — se re-arma
// cada vez que cambia cualquiera de los dos, para excluir siempre el actual.
function actualizarSelectsRodeo() {
  const cfg = TIPOS_MOVIMIENTO[obtenerSeleccion('mov-tipo')];
  if (!cfg) return;
  const { origen, destino } = establecimientosResueltos(cfg);
  const { principalEnFeedLot, destinoSecundarioEnFeedLot } = estadoFeedLot(cfg, origen, destino);
  // Los lados que van por Feed Lot no tienen selector de rodeo por nombre
  // — se eligen por corral (ver actualizarBloquesCorral/onSubmit), no
  // hace falta poblar nada ahí.
  if (!principalEnFeedLot) poblarSelectRodeo(RODEO_ORIGEN_IDS, null);
  if (cfg.campos.includes('rodeo_destino') && !destinoSecundarioEnFeedLot) {
    poblarSelectRodeo(RODEO_DESTINO_IDS, el(RODEO_ORIGEN_IDS.select).value);
  }
}

function inicializarSelectorRodeo(ids) {
  el(ids.select).addEventListener('change', () => {
    const esNuevo = el(ids.select).value === '__nuevo__';
    el(ids.wrap).classList.toggle('oculto', !esNuevo);
    if (esNuevo) el(ids.fecha).value = new Date().toISOString().slice(0, 10);
    if (ids === RODEO_ORIGEN_IDS) {
      poblarSelectRodeo(RODEO_DESTINO_IDS, el(ids.select).value);
      // El rodeo de origen define TODO lo que viene abajo: qué hay
      // adentro, qué categorías se pueden sacar, qué titulares tienen
      // hacienda ahí y cuánto de eso queda.
      actualizarStockDelRodeoTexto();
      actualizarCategoriasOrigenDisponibles();
      actualizarTitularesOrigenDisponibles();
      actualizarAvisoCambioCategoriaExpress();
      actualizarStockDisponibleTexto();
    }
  });

  el(ids.crear).addEventListener('click', async () => {
    const nombre = el(ids.nombre).value.trim();
    if (!nombre) { alert('Ingresá un nombre para el rodeo.'); return; }
    const cfg = TIPOS_MOVIMIENTO[obtenerSeleccion('mov-tipo')];
    const establecimientoId = establecimientoParaRodeo(cfg, ids);
    if (!establecimientoId) {
      alert('Elegí primero el establecimiento para poder crear el rodeo.');
      return;
    }
    try {
      const nuevo = await crearRodeo({
        nombre,
        establecimientoId,
        fechaCreacion: el(ids.fecha).value || undefined,
        usuarioId: getEstado().session.user.id,
      });
      actualizarSelectsRodeo();
      el(ids.select).value = nuevo.id;
      el(ids.wrap).classList.add('oculto');
      el(ids.nombre).value = '';
    } catch (error) {
      alert('No se pudo crear el rodeo: ' + error.message);
    }
  });
}

// En un traslado, origen y destino nunca pueden ser el mismo
// establecimiento — en vez de dejar clickear y recién avisar al guardar,
// se nubla (deshabilita) la opción de destino que coincide con el
// origen elegido. En cambio_rodeo es al revés: solo puede compartir
// establecimiento (mover animales de un rodeo a otro DENTRO del mismo
// campo; para cambiar de establecimiento existe "Traslado"), así que acá
// se fuerza el mismo valor que el origen y se nubla el resto.
function actualizarEstablecimientosDestinoDisponibles() {
  const tipo = obtenerSeleccion('mov-tipo');
  const esCambioRodeo = tipo === 'cambio_rodeo';
  const origenId = (tipo === 'traslado' || esCambioRodeo) ? obtenerSeleccion('mov-establecimiento-origen') : '';
  el('mov-establecimiento-destino').querySelectorAll('.boton-opcion').forEach((boton) => {
    if (!origenId) {
      boton.disabled = false;
      boton.classList.remove('deshabilitado');
      return;
    }
    const excluir = esCambioRodeo ? boton.dataset.value !== origenId : boton.dataset.value === origenId;
    boton.disabled = excluir;
    boton.classList.toggle('deshabilitado', excluir);
    if (excluir && boton.classList.contains('seleccionado')) {
      boton.classList.remove('seleccionado');
      el('mov-establecimiento-destino').dispatchEvent(new Event('cambio'));
    }
  });
  if (esCambioRodeo && origenId && obtenerSeleccion('mov-establecimiento-destino') !== origenId) {
    establecerSeleccion('mov-establecimiento-destino', origenId);
  }
}

// ─── formulario ───

// Un puestero carga datos pero con un subset acotado de tipos de
// movimiento — el resto (traslados, cambio de titular, ventas, compras,
// apertura de stock) queda para encargado/administrativo/owner. Cambio
// de rodeo entra en el subset porque no requiere crear un rodeo nuevo
// (elige entre los que ya existen en el mismo establecimiento).
const TIPOS_PUESTERO = ['paricion', 'mortandad', 'cambio_categoria', 'cambio_rodeo'];

function tiposVisibles() {
  const rol = getEstado().perfil?.rol;
  const entradas = Object.entries(TIPOS_MOVIMIENTO).filter(([, cfg]) => !cfg.oculto);
  return rol === 'puestero' ? entradas.filter(([id]) => TIPOS_PUESTERO.includes(id)) : entradas;
}

function poblarGrupos() {
  crearGrupoBotones('mov-tipo', tiposVisibles().map(([id, cfg]) => ({ id, nombre: cfg.nombre })));
  aplicarBloqueoAperturaStock();
  crearGrupoBotones('mov-establecimiento-origen', ESTABLECIMIENTOS);
  crearGrupoBotones('mov-establecimiento-destino', ESTABLECIMIENTOS);
  crearGrupoBotones('mov-categoria-origen', CATEGORIAS);
  crearGrupoBotones('mov-categoria-destino', CATEGORIAS);
  crearGrupoBotones('mov-destino-venta', DESTINO_VENTA);
  crearGrupoBotones('mov-kilos-modo', [
    { id: 'promedio', nombre: 'Promedio por cabeza' },
    { id: 'total', nombre: 'Total del lote' },
  ]);
  establecerSeleccion('mov-kilos-modo', 'promedio');
  inicializarTitular('origen');
  inicializarTitular('destino');
  inicializarCliente();
  inicializarComprador();
  crearGrupoBotones('mov-feedlot-corral', [
    { id: '1', nombre: 'Corral 1' }, { id: '2', nombre: 'Corral 2' },
    { id: '3', nombre: 'Corral 3' }, { id: '4', nombre: 'Corral 4' },
  ]);
  crearGrupoBotones('mov-feedlot-corral-origen', [
    { id: '1', nombre: 'Corral 1' }, { id: '2', nombre: 'Corral 2' },
    { id: '3', nombre: 'Corral 3' }, { id: '4', nombre: 'Corral 4' },
  ]);
  // En Feed Lot el corral ES el rodeo del que se saca, así que elegirlo
  // tiene que refrescar lo mismo que elegir un rodeo.
  el('mov-feedlot-corral-origen').addEventListener('cambio', () => {
    actualizarStockDelRodeoTexto();
    actualizarCategoriasOrigenDisponibles();
  });
}

// ─── Consulta rápida de movimientos por establecimiento ────────────────
// Vive acá (pantalla "Cargar movimiento") y no en Historial porque un
// puestero no tiene acceso a Historial (ver router.js), pero sí a esta
// pantalla — es la única forma que tiene de corroborar, antes de cargar,
// que nadie más (ej. un encargado desde Historial) ya cargó ese mismo
// movimiento. Es de solo lectura, sin editar/anular.
function poblarSelectConsultaEstablecimiento() {
  const select = el('mov-consulta-establecimiento');
  select.innerHTML = '';
  for (const e of ESTABLECIMIENTOS) {
    const opt = document.createElement('option');
    opt.value = e.id;
    opt.textContent = e.nombre;
    select.appendChild(opt);
  }
  // El Tara por default: es el establecimiento donde surgió la necesidad
  // (carga por dos personas distintas, Ponce en el campo y Enriques desde
  // Historial) — cualquiera puede elegir otro con el selector.
  select.value = 'el_tara';
}

function itemConsulta(fila) {
  const categoria = fila.categoria_origen_nombre || fila.categoria_destino_nombre || '';
  const hora = fila.created_at ? new Date(fila.created_at).toLocaleString('es-AR') : '';
  const div = document.createElement('div');
  div.className = 'consulta-item';
  div.textContent =
    `${fila.fecha} — ${fila.tipo_movimiento_nombre}${categoria ? ' · ' + categoria : ''} · ${fila.cantidad_cabezas} cab.` +
    ` — cargado por ${fila.usuario_nombre || '—'} (${hora})`;
  return div;
}

export async function refrescarConsultaEstablecimiento() {
  const establecimientoId = el('mov-consulta-establecimiento')?.value;
  const contenedor = el('mov-consulta-lista');
  if (!establecimientoId || !contenedor) return;
  if (!navigator.onLine) {
    contenedor.innerHTML = '<div style="color:#666;">Sin conexión — no se puede consultar ahora.</div>';
    return;
  }
  contenedor.textContent = 'Cargando…';
  const hoy = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('historial_movimientos')
    .select('*')
    .eq('anulado', false)
    .eq('fecha', hoy)
    .or(`establecimiento_origen.eq.${establecimientoId},establecimiento_destino.eq.${establecimientoId}`)
    .order('created_at', { ascending: false })
    .limit(30);
  if (error) {
    contenedor.innerHTML = `<div class="mensaje error">No se pudo consultar: ${error.message}</div>`;
    return;
  }
  contenedor.innerHTML = '';
  if (!data.length) {
    contenedor.innerHTML = '<div style="color:#666;">Sin movimientos cargados hoy en ese establecimiento.</div>';
    return;
  }
  for (const fila of data) contenedor.appendChild(itemConsulta(fila));
}

// Muestra/esconde los bloques de "Corral de origen"/"Corral de destino"
// según los establecimientos elegidos — un bloque por lado, pueden
// mostrarse los dos a la vez (Cambio de rodeo moviendo entre corrales).
function actualizarBloquesCorral() {
  const cfg = TIPOS_MOVIMIENTO[obtenerSeleccion('mov-tipo')];
  if (!cfg) {
    el('mov-feedlot-salida').classList.add('oculto');
    el('mov-feedlot-entrada').classList.add('oculto');
    return;
  }
  const { origen, destino } = establecimientosResueltos(cfg);
  el('mov-feedlot-salida').classList.toggle('oculto', origen !== 'feed_lot');
  el('mov-feedlot-entrada').classList.toggle('oculto', destino !== 'feed_lot');
}

// Categoría cuyo "siguiente paso" en la cadena es la deseada (ej. la
// anterior de 'novillo' es 'novillito') — o null si no tiene anterior
// (ej. categorías "al pie", o cualquiera que no aparezca como valor en
// SIGUIENTE_CATEGORIA).
function categoriaAnterior(categoriaId) {
  return Object.keys(SIGUIENTE_CATEGORIA).find((id) => SIGUIENTE_CATEGORIA[id] === categoriaId) || null;
}

// Mismo criterio que leerFormulario() para saber qué titular es "el
// origen" según el tipo: Salida de hotelería no usa titular_origen, usa
// Cliente.
function titularOrigenActual(tipo, cfg) {
  if (tipo === 'salida_hoteleria') return obtenerCliente();
  return cfg.campos.includes('titular_origen') ? obtenerTitular('origen') : '';
}

// Cambio de categoría "express": si el corral elegido para una salida
// (Venta, Mortandad, Salida de hotelería...) no tiene stock real de la
// categoría pedida para ESE titular, pero sí tiene la categoría anterior
// de la cadena con ese mismo titular, se ofrece resolverlo ahí mismo en
// vez de solo bloquear al guardar — el caso real es un corral que
// "engordó" y nadie cargó el Cambio de categoría todavía. A diferencia de
// la versión vieja (antes de los 4 corrales fijos), esto NUNCA mira "todo
// el corral": compara puntualmente la categoría elegida contra su
// anterior, siempre para el mismo titular — un corral puede tener
// Novillito, Novillo y Vaquillona a la vez sin que se mezclen entre sí.
let tokenAvisoExpress = 0;
async function actualizarAvisoCambioCategoriaExpress() {
  const idPropio = ++tokenAvisoExpress;
  const aviso = el('mov-cambio-cat-aviso');
  const ocultar = () => aviso.classList.add('oculto');

  const tipo = obtenerSeleccion('mov-tipo');
  const cfg = TIPOS_MOVIMIENTO[tipo];
  // Aplica a cualquier tipo que saque cabezas de una categoría en el
  // origen: Venta, Mortandad, Traslado, Cambio de rodeo, Cambio de
  // titularidad, Salida de hotelería. Se excluye el propio Cambio de
  // categoría, donde ofrecer un cambio de categoría no tendría sentido.
  if (!cfg || tipo === 'cambio_categoria' || !cfg.campos.includes('categoria_origen')) { ocultar(); return; }

  const categoriaDeseada = obtenerSeleccion('mov-categoria-origen');
  const titular = titularOrigenActual(tipo, cfg);
  const categoriaAnteriorId = categoriaAnterior(categoriaDeseada);
  const rodeo = rodeoOrigenActual(cfg);
  if (!categoriaDeseada || !titular || !categoriaAnteriorId || !rodeo || !navigator.onLine) {
    ocultar();
    return;
  }

  let yaTiene, anterior;
  try {
    [yaTiene, anterior] = await Promise.all([
      stockDelRodeoPorCategoriaYTitular(rodeo.id, categoriaDeseada, titular),
      stockDetalleRodeoCategoriaYTitular(rodeo.id, categoriaAnteriorId, titular),
    ]);
  } catch (error) {
    console.warn('No se pudo chequear si corresponde el cambio de categoría express:', error);
    ocultar();
    return;
  }
  if (idPropio !== tokenAvisoExpress) return; // el usuario ya cambió algo mientras esperábamos

  if (yaTiene > 0 || !anterior.cabezas) { ocultar(); return; }

  const nombreAnterior = CATEGORIAS.find((c) => c.id === categoriaAnteriorId)?.nombre || categoriaAnteriorId;
  const nombreDeseada = CATEGORIAS.find((c) => c.id === categoriaDeseada)?.nombre || categoriaDeseada;
  const donde = rodeo.establecimiento_id === 'feed_lot' && rodeo.corral
    ? `el Corral ${rodeo.corral}`
    : `"${rodeo.codigo}"`;
  el('mov-cambio-cat-texto').textContent =
    `⚠️ No hay ${nombreDeseada} de ese titular en ${donde}, pero sí hay ${anterior.cabezas} cabeza(s) de ${nombreAnterior}. ¿Ya engordaron? Pasá las que correspondan y seguí con el movimiento.`;
  el('mov-cambio-cat-label').textContent =
    `¿Cuántas pasar de ${nombreAnterior} a ${nombreDeseada}? (hay ${anterior.cabezas})`;

  // Se propone la cantidad del movimiento que se está cargando, que es el
  // caso normal (se trasladan 30 y hay que recategorizar esas 30), pero
  // queda editable: puede que hayan engordado más de las que se mueven.
  const input = el('mov-cambio-cat-cantidad');
  input.max = anterior.cabezas;
  const delMovimiento = Number(el('mov-cabezas').value);
  input.value = Number.isInteger(delMovimiento) && delMovimiento > 0 && delMovimiento <= anterior.cabezas
    ? delMovimiento
    : '';

  aviso.dataset.rodeoId = rodeo.id;
  aviso.dataset.establecimiento = rodeo.establecimiento_id;
  aviso.dataset.categoriaOrigen = categoriaAnteriorId;
  aviso.dataset.categoriaDestino = categoriaDeseada;
  aviso.dataset.titular = titular;
  aviso.dataset.cabezas = anterior.cabezas;
  aviso.dataset.kilos = anterior.kilosPromedioPonderado;
  aviso.classList.remove('oculto');
}

// Inserta un movimiento real de Cambio de categoría (no pasa por el
// outbox offline, mismo criterio que "+ Crear rodeo nuevo..." — requiere
// conexión) y deja el formulario listo para completar la salida original
// ya con stock disponible en la categoría pedida.
async function ejecutarCambioCategoriaExpress() {
  const aviso = el('mov-cambio-cat-aviso');
  const { rodeoId, establecimiento, categoriaOrigen, categoriaDestino, titular, cabezas, kilos } = aviso.dataset;
  if (!rodeoId || !categoriaDestino) return;
  if (!navigator.onLine) {
    mostrarMensaje('Necesitás conexión a internet para cambiar la categoría.', 'error');
    return;
  }

  const disponible = Number(cabezas);
  const aCambiar = Number(el('mov-cambio-cat-cantidad').value);
  if (!Number.isInteger(aCambiar) || aCambiar <= 0 || aCambiar > disponible) {
    mostrarMensaje(`Poné cuántas cabezas pasar de categoría: un número entero entre 1 y ${disponible}.`, 'error');
    return;
  }

  const boton = el('mov-cambio-cat-boton');
  boton.disabled = true;
  boton.textContent = 'Cambiando…';
  try {
    const { error } = await supabase.from('movimientos').insert({
      id: crypto.randomUUID(),
      tipo_movimiento: 'cambio_categoria',
      fecha: el('mov-fecha').value || new Date().toISOString().slice(0, 10),
      // Un cambio de categoría no mueve de establecimiento: origen y
      // destino son el mismo, el del rodeo donde están los animales.
      establecimiento_origen: establecimiento,
      establecimiento_destino: establecimiento,
      categoria_origen: categoriaOrigen,
      categoria_destino: categoriaDestino,
      titular_origen: titular,
      titular_destino: titular,
      cantidad_cabezas: aCambiar,
      kilos_promedio: Number(kilos),
      usuario_id: getEstado().session.user.id,
      rodeo_id: rodeoId,
      observaciones: 'Cambio de categoría express (cargado al hacer otro movimiento) — ya habían pasado a la categoría siguiente.',
    });
    if (error) throw error;
    mostrarToast('✅ Categoría actualizada — ya podés continuar.');
    await actualizarAvisoCambioCategoriaExpress();
    await actualizarStockDisponibleTexto();
  } catch (error) {
    mostrarMensaje('No se pudo cambiar la categoría: ' + error.message, 'error');
  } finally {
    boton.disabled = false;
    boton.textContent = 'Cambiar categoría y continuar';
  }
}

// Cuánto stock hay realmente de la categoría+titular elegidos en el
// corral de origen — se ve de entrada, sin esperar al error de
// validarStockDisponible() recién al guardar. Aplica a cualquier tipo con
// categoria_origen cuyo origen resuelva a Feed Lot (no solo salidas:
// Traslado/Cambio de categoría/Cambio de rodeo también sacan de un
// corral puntual).
let tokenStockDisponible = 0;
async function actualizarStockDisponibleTexto() {
  const idPropio = ++tokenStockDisponible;
  const texto = el('mov-stock-disponible');
  const ocultar = () => texto.classList.add('oculto');

  const tipo = obtenerSeleccion('mov-tipo');
  const cfg = TIPOS_MOVIMIENTO[tipo];
  if (!cfg || !cfg.campos.includes('categoria_origen')) { ocultar(); return; }

  const categoriaId = obtenerSeleccion('mov-categoria-origen');
  const titular = titularOrigenActual(tipo, cfg);
  const rodeo = rodeoOrigenActual(cfg);
  if (!categoriaId || !titular || !rodeo || !navigator.onLine) { ocultar(); return; }

  let cabezas;
  try {
    cabezas = await stockDelRodeoPorCategoriaYTitular(rodeo.id, categoriaId, titular);
  } catch (error) {
    ocultar();
    return;
  }
  if (idPropio !== tokenStockDisponible) return; // el usuario ya cambió algo mientras esperábamos

  const nombreCategoria = CATEGORIAS.find((c) => c.id === categoriaId)?.nombre || categoriaId;
  const donde = rodeo.establecimiento_id === 'feed_lot' && rodeo.corral
    ? `el Corral ${rodeo.corral}`
    : `"${rodeo.codigo}"`;
  // Con el número en negrita: es lo único que se mira de esta línea. El
  // resto va escapado porque el código del rodeo lo escribe el usuario.
  texto.innerHTML = `Stock disponible de ${esc(nombreCategoria)} de este titular en ${esc(donde)}: <strong>${Number(cabezas)}</strong> cabeza(s).`;
  texto.classList.remove('oculto');
}

function actualizarRequeridoRodeoDestino() {
  const cfg = TIPOS_MOVIMIENTO[obtenerSeleccion('mov-tipo')];
  if (!cfg) return;
  const { destino } = establecimientosResueltos(cfg);
  const aplica = cfg.campos.includes('rodeo_destino') && destino !== 'feed_lot';
  document.querySelector('[data-campo="rodeo_destino"]').classList.toggle('oculto', !aplica);
  el('mov-rodeo-destino').required = aplica;
}

// El selector "Rodeo" (mov-rodeo) se esconde cuando el lado que
// representa (ver ladoRodeoPrincipal) va por Feed Lot — ese lado se
// resuelve por corral en vez de por nombre.
function actualizarRequeridoRodeo() {
  const cfg = TIPOS_MOVIMIENTO[obtenerSeleccion('mov-tipo')];
  if (!cfg) return;
  const { origen, destino } = establecimientosResueltos(cfg);
  const { principalEnFeedLot } = estadoFeedLot(cfg, origen, destino);
  document.querySelector('[data-campo="rodeo"]').classList.toggle('oculto', principalEnFeedLot);
  el('mov-rodeo').required = !principalEnFeedLot;
}

const CATEGORIAS_AL_PIE = ['ternero_al_pie', 'ternera_al_pie'];

// Qué categorías puede tener mov-categoria-origen para el tipo actual:
// - Cambio de categoría: solo las que tienen un paso siguiente definido en
//   SIGUIENTE_CATEGORIA — novillo/toro/vaca son categorías terminales, no
//   tiene sentido elegirlas como origen de un cambio si no hay adónde ir.
// - Cualquier otro tipo (venta, mortandad, traslado, etc.): todas — ahí
//   categoria_origen es la categoría real del animal en el rodeo, no un
//   paso de la cadena. Traslado con destino Feed Lot tiene una restricción
//   aparte (ver actualizarCategoriasOrigenDisponibles) que nubla en vez de
//   reconstruir, para no perder la selección por tocar el establecimiento.
function opcionesCategoriaOrigen(tipo) {
  if (tipo === 'cambio_categoria') return CATEGORIAS.filter((c) => SIGUIENTE_CATEGORIA[c.id]);
  return CATEGORIAS;
}

// Cuando el destino elegido es Feed Lot (Traslado, Cambio de rodeo):
// "al pie" no tiene sentido ahí (todavía están con la madre) — se
// nublan (deshabilitan) esas 2 opciones en vez de reconstruir el grupo
// entero, mismo criterio que
// actualizarEstablecimientosDestinoDisponibles/actualizarTitularesOrigenDisponibles,
// para no perder una selección válida solo por tocar el establecimiento.
function actualizarCategoriasOrigenDisponibles() {
  const tipo = obtenerSeleccion('mov-tipo');
  const cfg = TIPOS_MOVIMIENTO[tipo];
  const bloquear = Boolean(cfg) && establecimientosResueltos(cfg).destino === 'feed_lot';
  const grupo = el('mov-categoria-origen');

  // Además: del lado que saca, solo se ofrecen las categorías que ese
  // rodeo tiene de verdad. Se suma la categoría SIGUIENTE a cada una que
  // sí tiene (el lote que engordó y cuyo cambio de categoría nadie cargó
  // todavía): al elegirla aparece el aviso de cambio de categoría
  // express, que lo resuelve sin salir de la pantalla. En Cambio de
  // categoría eso no aplica: ahí mezclar induce a error.
  const rodeo = cfg && ladoRodeoPrincipal(cfg) === 'origen' ? rodeoOrigenActual(cfg) : null;
  const filtrarPorStock = Boolean(rodeo) && hayComposicionCargada();
  const conStock = new Set();
  if (filtrarPorStock) {
    for (const c of composicionDelRodeo(rodeo.id)) {
      conStock.add(c.categoriaId);
      if (tipo !== 'cambio_categoria' && SIGUIENTE_CATEGORIA[c.categoriaId]) {
        conStock.add(SIGUIENTE_CATEGORIA[c.categoriaId]);
      }
    }
  }

  grupo.querySelectorAll('.boton-opcion').forEach((boton) => {
    const sinStock = filtrarPorStock && !conStock.has(boton.dataset.value);
    const deshabilitar = sinStock || (bloquear && CATEGORIAS_AL_PIE.includes(boton.dataset.value));
    boton.disabled = deshabilitar;
    boton.classList.toggle('deshabilitado', deshabilitar);
    if (deshabilitar && boton.classList.contains('seleccionado')) {
      boton.classList.remove('seleccionado');
      grupo.dispatchEvent(new Event('cambio'));
    }
  });
}

// Qué categorías puede tener mov-categoria-destino para el tipo actual:
// - Si el tipo tiene categoriasPermitidas (Parición), solo esas.
// - Si es Cambio de categoría, la única "siguiente" definida en
//   SIGUIENTE_CATEGORIA para el origen elegido — no se puede saltar un
//   paso ni elegir cualquier categoría al voleo, para minimizar error de
//   carga (el origen ya está limitado a categorías con cadena definida,
//   ver opcionesCategoriaOrigen()).
// - Cualquier otro tipo: todas.
function opcionesCategoriaDestino(tipo) {
  const cfg = TIPOS_MOVIMIENTO[tipo];
  if (cfg.categoriasPermitidas) return CATEGORIAS.filter((c) => cfg.categoriasPermitidas.includes(c.id));
  if (tipo === 'cambio_categoria') {
    const origen = obtenerSeleccion('mov-categoria-origen');
    const siguienteId = SIGUIENTE_CATEGORIA[origen];
    if (siguienteId) return CATEGORIAS.filter((c) => c.id === siguienteId);
  }
  return CATEGORIAS;
}

// Sin tipo elegido: todos los campos que dependen de él quedan ocultos y
// sin exigir nada, para no bloquear el submit en silencio (ver onSubmit,
// que además corta antes con un mensaje visible si no se eligió tipo).
function ocultarCamposDependientesDeTipo() {
  for (const campo of CAMPOS) {
    document.querySelector(`[data-campo="${campo}"]`).classList.add('oculto');
  }
  document.querySelector('[data-campo="rodeo"]').classList.add('oculto');
  document.querySelector('[data-campo="rodeo_destino"]').classList.add('oculto');
  el('mov-cliente').required = false;
  el('mov-comprador').required = false;
  el('mov-rodeo').required = false;
  el('mov-rodeo-destino').required = false;
  el('mov-observaciones').required = false;
  el('mov-observaciones-label').textContent = 'Observaciones (opcional)';
  actualizarBloquesCorral();
}

function actualizarCamposVisibles() {
  const tipo = obtenerSeleccion('mov-tipo');
  if (!tipo) { ocultarCamposDependientesDeTipo(); return; }
  const cfg = TIPOS_MOVIMIENTO[tipo];

  for (const campo of CAMPOS) {
    const contenedor = document.querySelector(`[data-campo="${campo}"]`);
    contenedor.classList.toggle('oculto', !cfg.campos.includes(campo));
  }
  // mov-rodeo-destino es "required" en el HTML, pero solo corresponde para
  // los tipos que lo usan (y no cuando ese lado va por Feed Lot, ver
  // actualizarRequeridoRodeoDestino) — si queda required mientras su
  // contenedor está oculto, el navegador
  // bloquea el submit en SILENCIO (sin mensaje visible) para cualquier
  // otro caso. Mismo motivo para mov-cliente/mov-comprador: son <select>
  // required en el HTML, pero solo corresponden a algunos tipos.
  actualizarRequeridoRodeoDestino();
  actualizarRequeridoRodeo();
  el('mov-cliente').required = cfg.campos.includes('cliente');
  el('mov-comprador').required = cfg.campos.includes('comprador');

  // Para Mortandad, las Observaciones dejan de ser opcionales: hay que
  // contar qué pasó (causa de la muerte) para que quede registrado.
  const esMortandad = tipo === 'mortandad';
  el('mov-observaciones').required = esMortandad;
  el('mov-observaciones-label').textContent = esMortandad
    ? 'Observaciones — obligatorio para Mortandad (contá qué pasó)'
    : 'Observaciones (opcional)';

  // Siempre se reconstruye para que quede sin selección al cambiar de tipo
  // (evita arrastrar una categoría elegida que ya no corresponde).
  crearGrupoBotones('mov-categoria-origen', opcionesCategoriaOrigen(tipo));
  crearGrupoBotones('mov-categoria-destino', opcionesCategoriaDestino(tipo));
  actualizarCategoriasOrigenDisponibles();
  actualizarSelectsRodeo();
  actualizarBloquesCorral();
  actualizarEstablecimientosDestinoDisponibles();
  actualizarTitularesOrigenDisponibles();
  actualizarAvisoCambioCategoriaExpress();
  actualizarStockDisponibleTexto();
}

function activarAccesoRapidoFeedLot() {
  el('mov-feedlot').addEventListener('click', () => {
    establecerSeleccion('mov-tipo', 'traslado');
    establecerSeleccion('mov-establecimiento-destino', 'feed_lot');
  });
}

// ─── Resumen de lo que se está por guardar ──────────────────────────────
// Se arma leyendo el formulario igual que al guardar, para que diga
// exactamente lo que va a entrar (no lo que parece decir la pantalla).
function nombreDe(lista, id) {
  return lista.find((x) => x.id === id)?.nombre || id || '';
}

// El resumen usa innerHTML para poder resaltar en negrita, y varios de los
// nombres que interpola los carga el usuario (capitalizadores, compradores,
// rodeos): sin escapar, un nombre con "<" inyectaría HTML en la pantalla.
function esc(texto) {
  const d = document.createElement('div');
  d.textContent = texto ?? '';
  return d.innerHTML;
}

function nombreTitularMov(id) {
  if (!id) return '';
  return obtenerTitularesCache().find((t) => t.id === id)?.nombre || id;
}

// Cómo se describe un lado: el corral si es Feed Lot, el rodeo si no.
function ladoTexto(establecimientoId, corral, rodeoId) {
  if (!establecimientoId) return '';
  const est = nombreDe(ESTABLECIMIENTOS, establecimientoId);
  if (establecimientoId === 'feed_lot' && corral) return `${est} (Corral ${corral})`;
  const rodeo = obtenerRodeosCache().find((r) => r.id === rodeoId)?.codigo;
  return rodeo ? `${est} (${rodeo})` : est;
}

function actualizarResumen() {
  const contenedor = el('mov-resumen');
  const tipo = obtenerSeleccion('mov-tipo');
  const cfg = TIPOS_MOVIMIENTO[tipo];
  const cabezas = Number(el('mov-cabezas').value);
  const categoria = obtenerSeleccion(`mov-categoria-${cfg ? campoRelevante(cfg, 'categoria') : 'origen'}`);

  // Hasta que no haya tipo, cabezas y categoría no hay nada que resumir.
  if (!cfg || !cabezas || !categoria) {
    contenedor.classList.add('oculto');
    contenedor.textContent = '';
    return;
  }

  const partes = [`<strong>${esc(cfg.nombre)}</strong>`, `${cabezas} ${esc(nombreDe(CATEGORIAS, categoria))}`];

  const titular = cfg.campos.includes('titular_origen')
    ? obtenerTitular('origen')
    : (tipo === 'salida_hoteleria' ? obtenerCliente() : (cfg.campos.includes('titular_destino') ? obtenerTitular('destino') : (tipo === 'hoteleria' ? obtenerCliente() : '')));
  if (titular) partes.push(`de <strong>${esc(nombreTitularMov(titular))}</strong>`);

  const { origen, destino } = establecimientosResueltos(cfg);
  const desde = ladoTexto(origen, obtenerSeleccion('mov-feedlot-corral-origen'), el('mov-rodeo').value);
  const hasta = ladoTexto(destino, obtenerSeleccion('mov-feedlot-corral'), el('mov-rodeo-destino').value);
  if (desde && hasta) partes.push(`${esc(desde)} → ${esc(hasta)}`);
  else if (desde) partes.push(`desde ${esc(desde)}`);
  else if (hasta) partes.push(`a ${esc(hasta)}`);

  if (cfg.campos.includes('titular_destino') && cfg.campos.includes('titular_origen')) {
    const destinoTit = obtenerTitular('destino');
    if (destinoTit) partes.push(`pasa a <strong>${esc(nombreTitularMov(destinoTit))}</strong>`);
  }
  if (cfg.campos.includes('categoria_destino')) {
    const catDestino = obtenerSeleccion('mov-categoria-destino');
    if (catDestino && catDestino !== categoria) partes.push(`pasa a <strong>${esc(nombreDe(CATEGORIAS, catDestino))}</strong>`);
  }
  if (cfg.campos.includes('comprador')) {
    const comprador = obtenerComprador();
    if (comprador) partes.push(`comprador <strong>${esc(nombreDe(obtenerCompradoresCache(), comprador))}</strong>`);
  }

  const kilos = Number(kilosPromedioDelFormulario());
  if (kilos > 0) partes.push(`${kilos} kg/cab.`);

  contenedor.innerHTML = `Vas a guardar: ${partes.join(' · ')}`;
  contenedor.classList.remove('oculto');
}

// ─── Kilos: promedio por cabeza o total del lote ────────────────────────
// La base guarda siempre el promedio (movimientos.kilos_promedio). Poder
// escribir el total es solo para no obligar a dividir a mano en el corral,
// que es de donde salen los errores de un dígito.
function modoKilos() {
  return obtenerSeleccion('mov-kilos-modo') || 'promedio';
}

function kilosPromedioDelFormulario() {
  const valor = Number(el('mov-kilos').value);
  if (!valor) return '';
  if (modoKilos() !== 'total') return el('mov-kilos').value;
  const cabezas = Number(el('mov-cabezas').value);
  if (!cabezas) return '';
  return Math.round((valor / cabezas) * 100) / 100;
}

// Muestra la cuenta hecha, para que se vea qué se va a guardar.
function actualizarAyudaKilos() {
  const esTotal = modoKilos() === 'total';
  el('mov-kilos-label').textContent = esTotal ? 'Kilos totales del lote' : 'Kilos promedio por cabeza';

  const ayuda = el('mov-kilos-calculado');
  if (!esTotal) { ayuda.classList.add('oculto'); return; }

  const total = Number(el('mov-kilos').value);
  const cabezas = Number(el('mov-cabezas').value);
  if (!total) { ayuda.classList.add('oculto'); return; }
  ayuda.textContent = cabezas
    ? `Se guardan ${kilosPromedioDelFormulario()} kg por cabeza (${total} ÷ ${cabezas}).`
    : 'Cargá primero la cantidad de cabezas para poder sacar el promedio.';
  ayuda.classList.remove('oculto');
}

function leerFormulario() {
  const tipo = obtenerSeleccion('mov-tipo');
  const cfg = TIPOS_MOVIMIENTO[tipo];
  // Cliente (Hotelería): reemplaza a Titularidad de origen/destino para
  // 'hoteleria'/'salida_hoteleria' — ver campos en config.js.
  const cliente = cfg.campos.includes('cliente') ? obtenerCliente() : null;
  const { origen: establecimientoOrigen, destino: establecimientoDestino } = establecimientosResueltos(cfg);
  const { principalEnFeedLot, destinoSecundarioEnFeedLot } = estadoFeedLot(cfg, establecimientoOrigen, establecimientoDestino);
  return {
    tipo,
    cfg,
    principalEnFeedLot,
    destinoSecundarioEnFeedLot,
    fecha: el('mov-fecha').value,
    establecimiento_origen: establecimientoOrigen,
    establecimiento_destino: establecimientoDestino,
    categoria_origen: cfg.campos.includes('categoria_origen') ? obtenerSeleccion('mov-categoria-origen') : null,
    categoria_destino: cfg.campos.includes('categoria_destino') ? obtenerSeleccion('mov-categoria-destino') : null,
    titular_origen: cfg.campos.includes('titular_origen') ? obtenerTitular('origen') : (tipo === 'salida_hoteleria' ? cliente : null),
    titular_destino: cfg.campos.includes('titular_destino') ? obtenerTitular('destino') : (tipo === 'hoteleria' ? cliente : null),
    cliente,
    destino_venta: cfg.campos.includes('destino_venta') ? obtenerSeleccion('mov-destino-venta') : null,
    comprador: cfg.campos.includes('comprador') ? obtenerComprador() : null,
    cantidad_cabezas: el('mov-cabezas').value,
    // Siempre se guarda el promedio por cabeza; si el usuario cargó el
    // total del lote (lo que da la balanza), se divide acá.
    kilos_promedio: kilosPromedioDelFormulario(),
    rodeo_id: principalEnFeedLot ? null : el('mov-rodeo').value,
    rodeo_destino: (cfg.campos.includes('rodeo_destino') && !destinoSecundarioEnFeedLot) ? el('mov-rodeo-destino').value : null,
    observaciones: el('mov-observaciones').value.trim() || null,
    // Corral de origen/destino: se leen siempre (aunque el bloque esté
    // oculto) — es más simple que ramificar acá, y quedan sin usar si el
    // establecimiento correspondiente no es Feed Lot.
    feedlotCorralOrigen: obtenerSeleccion('mov-feedlot-corral-origen'),
    feedlotCorralDestino: obtenerSeleccion('mov-feedlot-corral'),
    editandoId,
  };
}

function validar(datos) {
  const errores = [];
  const advertencias = [];

  if (datos.cfg.soloOwner && getEstado().perfil?.rol !== 'owner') {
    errores.push('Solo un owner puede cargar este tipo de movimiento.');
  }

  if (!datos.fecha) errores.push('Falta la fecha.');
  else if (datos.fecha > new Date().toISOString().slice(0, 10)) errores.push('La fecha no puede ser futura.');

  for (const campo of datos.cfg.campos) {
    if (campo === 'rodeo_destino') continue; // se valida aparte, abajo (no aplica a un traslado a feed lot)
    if (!datos[campo]) errores.push('Falta completar un campo obligatorio.');
  }

  // El lado que va por Feed Lot no elige rodeo por nombre — se resuelve
  // por corral (ver onSubmit), siempre existe (son los 4 corrales fijos).
  if (!datos.principalEnFeedLot && (!datos.rodeo_id || datos.rodeo_id === '__nuevo__')) {
    errores.push('Elegí un rodeo (o creá uno nuevo con "+ Crear rodeo nuevo...").');
  }
  if (datos.cfg.campos.includes('rodeo_destino') && !datos.destinoSecundarioEnFeedLot) {
    if (!datos.rodeo_destino) {
      errores.push('Elegí un rodeo destino (o creá uno nuevo con "+ Crear rodeo nuevo...").');
    } else if (datos.rodeo_destino === '__nuevo__') {
      errores.push('Terminá de crear el rodeo destino (o elegí uno existente).');
    } else if (datos.rodeo_destino === datos.rodeo_id) {
      errores.push('El rodeo destino tiene que ser distinto del rodeo de origen.');
    }
  }

  if (datos.establecimiento_origen === 'feed_lot' && !datos.feedlotCorralOrigen) {
    errores.push('Elegí de qué corral sale.');
  }
  if (datos.establecimiento_destino === 'feed_lot' && !datos.feedlotCorralDestino) {
    errores.push('Elegí a qué corral entra.');
  }

  const cabezas = Number(datos.cantidad_cabezas);
  if (!Number.isInteger(cabezas) || cabezas <= 0) errores.push('La cantidad de cabezas debe ser un entero mayor a 0.');

  const kilos = Number(datos.kilos_promedio);
  // Con el modo "total" el promedio sale de dividir por las cabezas, así
  // que sin cabezas no hay promedio que guardar — el mensaje lo dice.
  if (!(kilos > 0) && modoKilos() === 'total' && el('mov-kilos').value) {
    errores.push('Para cargar los kilos totales hace falta la cantidad de cabezas.');
  } else if (!(kilos > 0)) errores.push('Los kilos promedio deben ser mayores a 0.');
  else if (kilos < KILOS_MIN_SANIDAD || kilos > KILOS_MAX_SANIDAD) {
    advertencias.push(`${kilos} kg/cabeza es un valor fuera de lo habitual (${KILOS_MIN_SANIDAD}-${KILOS_MAX_SANIDAD} kg). Verificá antes de confirmar.`);
  }

  if (datos.tipo === 'traslado' && datos.establecimiento_origen === datos.establecimiento_destino) {
    errores.push('En un traslado, el establecimiento de origen y destino deben ser distintos.');
  }
  if (datos.tipo === 'cambio_rodeo' && datos.establecimiento_origen !== datos.establecimiento_destino) {
    errores.push('Un cambio de rodeo tiene que ser dentro del mismo establecimiento (para cambiar de establecimiento usá "Traslado").');
  }
  if (datos.tipo === 'cambio_categoria' && datos.categoria_origen === datos.categoria_destino) {
    errores.push('En un cambio de categoría, la categoría de origen y destino deben ser distintas.');
  }
  if (datos.tipo === 'cambio_titular' && datos.titular_origen === datos.titular_destino) {
    errores.push('En un cambio de titularidad, la titularidad de origen y destino deben ser distintas.');
  }
  if (datos.tipo === 'mortandad' && !datos.observaciones) {
    errores.push('Para Mortandad, las Observaciones son obligatorias (contá qué pasó).');
  }

  return { errores, advertencias };
}

function armarFila(datos) {
  const { cfg } = datos;
  let categoria_destino = datos.categoria_destino;
  let establecimiento_destino = datos.establecimiento_destino;
  let titular_destino = datos.titular_destino;
  if (cfg.duplicarCategoriaEnDestino) categoria_destino = datos.categoria_origen;
  if (cfg.duplicarEstablecimientoEnDestino) establecimiento_destino = datos.establecimiento_origen;
  if (cfg.duplicarTitularEnDestino) titular_destino = datos.titular_origen;

  return {
    id: crypto.randomUUID(),
    tipo_movimiento: datos.tipo,
    fecha: datos.fecha,
    establecimiento_origen: datos.establecimiento_origen || null,
    establecimiento_destino: establecimiento_destino || null,
    categoria_origen: datos.categoria_origen || null,
    categoria_destino: categoria_destino || null,
    titular_origen: datos.titular_origen || null,
    titular_destino: titular_destino || null,
    cantidad_cabezas: Number(datos.cantidad_cabezas),
    kilos_promedio: Number(datos.kilos_promedio),
    usuario_id: getEstado().session.user.id,
    rodeo_id: datos.rodeo_id,
    rodeo_destino_id: datos.rodeo_destino || null,
    observaciones: datos.observaciones,
    destino_venta: datos.destino_venta || null,
    comprador_id: datos.comprador || null,
    editado_de: datos.editandoId || null,
  };
}

function mostrarMensaje(texto, tipo) {
  const contenedor = el('mov-mensaje');
  contenedor.textContent = texto;
  contenedor.className = tipo; // 'error' | 'ok' | 'advertencia'
}

let toastTimer = null;
function mostrarToast(texto, duracionMs) {
  const toast = el('toast');
  toast.textContent = texto;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), duracionMs || 3000);
}

function resetFormulario() {
  ocultarAvisoSanidad();
  el('mov-cabezas').value = '';
  el('mov-kilos').value = '';
  establecerSeleccion('mov-kilos-modo', 'promedio');
  actualizarAyudaKilos();
  actualizarResumen();
  el('mov-observaciones').value = '';
  el('mov-fecha').value = new Date().toISOString().slice(0, 10);
  limpiarSeleccion('mov-establecimiento-origen');
  limpiarSeleccion('mov-establecimiento-destino');
  limpiarSeleccion('mov-categoria-origen');
  limpiarSeleccion('mov-destino-venta');
  limpiarTitular('origen');
  limpiarTitular('destino');
  el('mov-cliente').value = '';
  el('mov-comprador').value = '';
  el('mov-rodeo-nuevo-wrap').classList.add('oculto');
  el('mov-rodeo-nuevo-nombre').value = '';
  el('mov-rodeo-destino-nuevo-wrap').classList.add('oculto');
  el('mov-rodeo-destino-nuevo-nombre').value = '';
  limpiarSeleccion('mov-feedlot-corral');
  limpiarSeleccion('mov-feedlot-corral-origen');
  // Sin tipo preseleccionado a propósito: si quedara uno marcado por
  // defecto, es fácil no darse cuenta y cargar el movimiento equivocado
  // (venía pasando con "Compra de invernada"). limpiarSeleccion no dispara
  // 'cambio', así que se llama a mano para ocultar los campos dependientes.
  limpiarSeleccion('mov-tipo');
  actualizarCamposVisibles();
}

function cancelarEdicion() {
  editandoId = null;
  el('mov-editando-aviso').classList.add('oculto');
  el('mov-submit').textContent = 'Guardar movimiento';
  resetFormulario();
}

// Precarga el formulario con los datos de un movimiento del historial para
// corregirlo — el tipo se elige primero porque dispara
// actualizarCamposVisibles() (reconstruye categoría-destino, selects de
// rodeo y bloque de feed lot), recién después tiene sentido setear el
// resto de los campos que dependen de eso.
function precargarParaEditar(fila) {
  editandoId = fila.id;
  establecerSeleccion('mov-tipo', fila.tipo_movimiento);
  if (fila.establecimiento_origen) establecerSeleccion('mov-establecimiento-origen', fila.establecimiento_origen);
  if (fila.establecimiento_destino) establecerSeleccion('mov-establecimiento-destino', fila.establecimiento_destino);
  if (fila.categoria_origen) establecerSeleccion('mov-categoria-origen', fila.categoria_origen);
  if (fila.categoria_destino) establecerSeleccion('mov-categoria-destino', fila.categoria_destino);
  precargarTitular('origen', fila.titular_origen);
  precargarTitular('destino', fila.titular_destino);
  if (fila.tipo_movimiento === 'hoteleria') el('mov-cliente').value = fila.titular_destino || '';
  if (fila.tipo_movimiento === 'salida_hoteleria') el('mov-cliente').value = fila.titular_origen || '';
  if (fila.destino_venta) establecerSeleccion('mov-destino-venta', fila.destino_venta);
  el('mov-comprador').value = fila.comprador_id || '';
  el('mov-cabezas').value = fila.cantidad_cabezas;
  establecerSeleccion('mov-kilos-modo', 'promedio');
  el('mov-kilos').value = fila.kilos_promedio;
  el('mov-fecha').value = fila.fecha;
  el('mov-observaciones').value = fila.observaciones || '';
  actualizarSelectsRodeo();
  // Si el lado origen/destino es Feed Lot, el selector de Rodeo queda
  // oculto (ver actualizarRequeridoRodeo) — hay que precargar el botón
  // de Corral correspondiente en su lugar, mirando en qué corral está el
  // rodeo guardado (rodeoDelCorral resuelve al revés: acá se busca el
  // corral A PARTIR del rodeo, por eso se consulta la caché directo).
  if (fila.establecimiento_origen === 'feed_lot') {
    const rodeoOrigen = obtenerRodeosCache().find((r) => r.id === fila.rodeo_id);
    if (rodeoOrigen) establecerSeleccion('mov-feedlot-corral-origen', rodeoOrigen.corral);
  } else if (fila.rodeo_id) {
    el('mov-rodeo').value = fila.rodeo_id;
  }
  if (fila.establecimiento_destino === 'feed_lot') {
    // El rodeo "destino" puede ser el mismo rodeo (tipos donde mov-rodeo
    // representa el lado destino, ej. Apertura de stock) o rodeo_destino_id
    // real (Traslado/Cambio de rodeo).
    const rodeoDestino = obtenerRodeosCache().find((r) => r.id === (fila.rodeo_destino_id || fila.rodeo_id));
    if (rodeoDestino) establecerSeleccion('mov-feedlot-corral', rodeoDestino.corral);
  } else if (fila.rodeo_destino_id) {
    el('mov-rodeo-destino').value = fila.rodeo_destino_id;
  }
  actualizarTitularesOrigenDisponibles();

  el('mov-editando-texto').textContent =
    `✏️ Corrigiendo el movimiento del ${fila.fecha} (${fila.tipo_movimiento_nombre}). Al guardar, el original queda tachado en el historial como "Editado".`;
  el('mov-editando-aviso').classList.remove('oculto');
  el('mov-submit').textContent = 'Guardar corrección';
  location.hash = 'cargar';
}

// ─── Sanidad del ingreso ────────────────────────────────────────────────
// A los animales que entran por una Compra se les suele hacer sanidad el
// mismo día. El problema es el ORDEN: si el Trabajo de Manga se carga
// antes que el ingreso, el rodeo todavía no tiene esas cabezas, la
// cantidad trabajada no coincide con el stock y queda una diferencia
// pendiente por cada trabajo así — que después hay que ir a resolver a
// mano. Preguntarlo acá, recién guardada la compra, hace que el orden
// correcto sea el camino fácil.
//
// Solo para Compra de invernada: es el ingreso que viene de afuera y
// llega a la manga. Parición no (los terneros al pie no se trabajan al
// nacer) y Apertura de stock tampoco (es carga inicial, no un ingreso
// real de animales).
let ingresoParaSanidad = null;

function ofrecerCargarSanidadDelIngreso(datos) {
  if (datos.tipo !== 'compra_invernada' || datos.editandoId) return;
  const rodeo = obtenerRodeosCache().find((r) => r.id === datos.rodeo_id);
  ingresoParaSanidad = {
    establecimientoId: datos.establecimiento_destino,
    rodeoId: datos.rodeo_id,
    categoriaId: datos.categoria_destino,
    titularId: datos.titular_destino,
    cantidad: Number(datos.cantidad_cabezas) || null,
    fecha: datos.fecha,
  };
  const categoria = CATEGORIAS.find((c) => c.id === datos.categoria_destino)?.nombre || datos.categoria_destino;
  el('mov-sanidad-texto').textContent =
    `¿A estas ${datos.cantidad_cabezas} ${categoria} les hiciste sanidad (vacunas, desparasitada, lo que sea)?` +
    (rodeo ? ` Entraron a ${rodeo.codigo}.` : '') +
    ' Si sí, cargá el trabajo de manga ahora: así queda en el orden correcto y no salta una diferencia pendiente.';
  el('mov-sanidad-aviso').classList.remove('oculto');
}

function ocultarAvisoSanidad() {
  ingresoParaSanidad = null;
  el('mov-sanidad-aviso').classList.add('oculto');
}

function irACargarSanidadDelIngreso() {
  if (!ingresoParaSanidad) return;
  const detalle = ingresoParaSanidad;
  ocultarAvisoSanidad();
  document.dispatchEvent(new CustomEvent('hacienda:precargar-manga', { detail: detalle }));
}

// Precarga "Cargar movimiento" con tipo Mortandad para resolver una
// diferencia pendiente de Trabajo de Manga (pedido desde el botón
// "Cargar movimiento que lo explica" — ver trabajoManga.js). Deja la
// cantidad como punto de partida, no como definitiva: el usuario la
// puede ajustar antes de guardar.
function precargarParaMortandad({ establecimientoId, categoriaId, rodeoId, cantidad }) {
  establecerSeleccion('mov-tipo', 'mortandad');
  if (establecimientoId) establecerSeleccion('mov-establecimiento-origen', establecimientoId);
  if (categoriaId) establecerSeleccion('mov-categoria-origen', categoriaId);
  actualizarSelectsRodeo();
  if (establecimientoId === 'feed_lot' && rodeoId) {
    const rodeo = obtenerRodeosCache().find((r) => r.id === rodeoId);
    if (rodeo) establecerSeleccion('mov-feedlot-corral-origen', rodeo.corral);
  } else if (rodeoId) {
    el('mov-rodeo').value = rodeoId;
  }
  actualizarTitularesOrigenDisponibles();
  if (cantidad) el('mov-cabezas').value = cantidad;
  location.hash = 'cargar';
}

// Alerta (no bloquea) si ya existe un movimiento muy parecido: mismo tipo,
// fecha, establecimiento(s), categoría(s) y cantidad de cabezas, sin
// anular ni reemplazado. Pensado para el caso real de dos personas
// cargando por separado (ej. Ponce en el campo, Enriques desde Historial)
// sin verse una a la otra — ver mov-consulta-establecimiento más arriba,
// que le da a Ponce una forma de chequear antes de cargar. Solo se puede
// chequear con conexión; si falla la consulta, se deja pasar (best-effort,
// mismo criterio que validarStockDisponible).
async function buscarPosibleDuplicado(datos) {
  let query = supabase
    .from('historial_movimientos')
    .select('codigo, created_at, usuario_nombre')
    .eq('tipo_movimiento', datos.tipo)
    .eq('fecha', datos.fecha)
    .eq('cantidad_cabezas', Number(datos.cantidad_cabezas))
    .eq('anulado', false)
    .is('reemplazado_por', null)
    .limit(1);
  if (datos.establecimiento_origen) query = query.eq('establecimiento_origen', datos.establecimiento_origen);
  if (datos.establecimiento_destino) query = query.eq('establecimiento_destino', datos.establecimiento_destino);
  if (datos.categoria_origen) query = query.eq('categoria_origen', datos.categoria_origen);
  if (datos.categoria_destino) query = query.eq('categoria_destino', datos.categoria_destino);
  const { data, error } = await query;
  if (error) { console.warn('No se pudo chequear duplicados:', error); return null; }
  return data && data[0] ? data[0] : null;
}

// Salida/interna sacan cabezas del rodeo de origen — no puede haber más
// saliendo que las que tiene. Solo se puede chequear con conexión (pide el
// stock real a Supabase); si está offline se deja pasar como hasta ahora
// (la app es offline-first) y si el chequeo mismo falla por red no se
// bloquea el movimiento por eso — solo cuando el chequeo SÍ pudo hacerse y
// da que no alcanza.
async function validarStockDisponible(datos) {
  if (datos.cfg.clase === 'entrada') return null;
  if (!navigator.onLine) return null;
  // Filtrado por categoría Y titular, no solo por rodeo: un rodeo puede
  // tener cabezas de más de un titular a la vez (ver
  // stockDelRodeoPorCategoriaYTitular en rodeos.js) — sin este filtro se
  // podía vender/mover a nombre de un titular sin stock real ahí con tal
  // de que otro titular del mismo rodeo sí lo tuviera.
  let disponible;
  try {
    disponible = await stockDelRodeoPorCategoriaYTitular(datos.rodeo_id, datos.categoria_origen, datos.titular_origen || 'agro_salado');
  } catch (error) {
    console.warn('No se pudo verificar el stock del rodeo antes de guardar:', error);
    return null;
  }
  const cabezas = Number(datos.cantidad_cabezas);
  if (cabezas > disponible) {
    const NOMBRES_TITULAR_BASE = { agro_salado: 'Agro Salado', dona_julia: 'Doña Julia' };
    const nombreTitular = NOMBRES_TITULAR_BASE[datos.titular_origen]
      || obtenerTitularesCache().find((t) => t.id === datos.titular_origen)?.nombre
      || (datos.titular_origen ? datos.titular_origen : 'Agro Salado');
    const nombreCategoria = CATEGORIAS.find((c) => c.id === datos.categoria_origen)?.nombre || datos.categoria_origen;
    return `No hay stock suficiente: ${nombreTitular} tiene ${disponible} cabeza(s) de ${nombreCategoria} en ese rodeo y se intentan mover ${cabezas}.`;
  }
  return null;
}

async function onSubmit(evento) {
  evento.preventDefault();
  if (!obtenerSeleccion('mov-tipo')) {
    mostrarMensaje('Elegí un tipo de movimiento.', 'error');
    return;
  }
  const datos = leerFormulario();
  const { errores, advertencias } = validar(datos);

  if (errores.length) {
    mostrarMensaje(errores.join(' '), 'error');
    return;
  }

  // Corregir ya no exige conexión: la marca del original viaja con la
  // corrección en el mismo ítem de la cola (ver guardarMovimiento en
  // sync.js), así que las dos entran juntas o ninguna.

  // No aplica al editar (no tiene sentido que un movimiento se marque
  // "duplicado" de sí mismo) ni sin conexión (no hay forma de chequear).
  if (!datos.editandoId && navigator.onLine) {
    const duplicado = await buscarPosibleDuplicado(datos);
    if (duplicado) {
      const hora = duplicado.created_at ? new Date(duplicado.created_at).toLocaleString('es-AR') : '';
      const seguir = confirm(
        `⚠️ Ya hay un movimiento muy parecido cargado (${duplicado.codigo || 'sin código'}), por ${duplicado.usuario_nombre || 'otro usuario'} el ${hora}.\n\n¿Confirmás que este NO es un duplicado y querés guardarlo igual?`
      );
      if (!seguir) return;
    }
  }

  // El lado de Feed Lot se resuelve por corral, no por nombre: los 4
  // corrales son fijos (ver rodeoDelCorral en rodeos.js) — nunca se crea
  // ni se busca por categoría, si el corral está elegido el rodeo
  // siempre existe. "No encontré el corral" solo puede pasar si los 4
  // corrales todavía no se crearon en la base (ver migración 039).
  if (datos.establecimiento_origen === 'feed_lot') {
    const rodeo = rodeoDelCorral(datos.feedlotCorralOrigen);
    if (!rodeo) {
      mostrarMensaje(`No encontré el Corral ${datos.feedlotCorralOrigen} — avisá para revisarlo.`, 'error');
      return;
    }
    if (ladoRodeoPrincipal(datos.cfg) === 'origen') datos.rodeo_id = rodeo.id;
  }
  if (datos.establecimiento_destino === 'feed_lot') {
    const rodeo = rodeoDelCorral(datos.feedlotCorralDestino);
    if (!rodeo) {
      mostrarMensaje(`No encontré el Corral ${datos.feedlotCorralDestino} — avisá para revisarlo.`, 'error');
      return;
    }
    if (ladoRodeoPrincipal(datos.cfg) === 'destino') datos.rodeo_id = rodeo.id;
    if (datos.cfg.campos.includes('rodeo_destino')) datos.rodeo_destino = rodeo.id;
  }

  // Hotelería sigue sin crear un rodeo propio por lote: comparte uno de
  // los 4 corrales fijos (resuelto arriba), distinguiéndose por
  // "Cliente"/titular en stock_actual — no necesita conexión especial ni
  // creación acá.

  const errorStock = await validarStockDisponible(datos);
  if (errorStock) {
    mostrarMensaje(errorStock, 'error');
    return;
  }

  // armarFila deja editado_de = id del movimiento corregido: sync.js lo usa
  // para marcar el original como reemplazado apenas entra la corrección.
  const fila = armarFila(datos);
  await encolarMovimiento(fila);

  mostrarToast(datos.editandoId ? '✅ CORRECCIÓN REGISTRADA' : '✅ MOVIMIENTO REGISTRADO');
  if (advertencias.length) {
    mostrarMensaje(`Se sincroniza automáticamente. (${advertencias.join(' ')})`, 'advertencia');
  } else {
    mostrarMensaje('', 'ok');
  }
  cancelarEdicion();
  ofrecerCargarSanidadDelIngreso(datos);
  // Best-effort también acá: si el movimiento ya sincronizó, el selector
  // queda mostrando el stock nuevo sin salir de la pantalla; si todavía
  // está en la cola, se pone al día al volver a entrar.
  cargarComposicionRodeos().then(actualizarSelectsRodeo);
}

// La llama el router cada vez que se entra a Cargar movimiento. Antes
// refrescaba solo la caché de rodeos; ahora también lo que cada rodeo
// tiene adentro, que es lo que se lee en el selector — si alguien cargó
// algo desde otra sesión, se ve acá sin recargar la página.
export async function refrescarRodeosDeCarga() {
  await Promise.all([cargarRodeos(), cargarComposicionRodeos()]);
  actualizarSelectsRodeo();
}

export async function initMovimientos() {
  await Promise.all([cargarTitulares(), cargarRodeos(), cargarCompradores(), cargarComposicionRodeos()]);
  poblarGrupos();
  inicializarSelectorRodeo(RODEO_ORIGEN_IDS);
  inicializarSelectorRodeo(RODEO_DESTINO_IDS);
  el('mov-fecha').value = new Date().toISOString().slice(0, 10);
  el('mov-tipo').addEventListener('cambio', actualizarCamposVisibles);
  for (const id of ['mov-categoria-origen', 'mov-categoria-destino', 'mov-establecimiento-origen', 'mov-establecimiento-destino']) {
    el(id).addEventListener('cambio', () => {
      actualizarSelectsRodeo(); actualizarBloquesCorral(); actualizarRequeridoRodeoDestino(); actualizarRequeridoRodeo();
      actualizarStockDelRodeoTexto();
      actualizarCategoriasOrigenDisponibles();
      actualizarTitularesOrigenDisponibles();
      actualizarAvisoCambioCategoriaExpress();
      actualizarStockDisponibleTexto();
    });
  }
  el('mov-establecimiento-origen').addEventListener('cambio', actualizarEstablecimientosDestinoDisponibles);
  // Nubla "al pie" apenas se elige Feed Lot como establecimiento de
  // destino (Traslado, Cambio de rodeo).
  el('mov-establecimiento-destino').addEventListener('cambio', actualizarCategoriasOrigenDisponibles);
  // Solo importa para Cambio de categoría (el único tipo donde origen y
  // destino de categoría son independientes) — reconstruye las opciones
  // de destino según la cadena SIGUIENTE_CATEGORIA del origen elegido.
  el('mov-categoria-origen').addEventListener('cambio', () => {
    crearGrupoBotones('mov-categoria-destino', opcionesCategoriaDestino(obtenerSeleccion('mov-tipo')));
  });
  el('mov-feedlot-corral-origen').addEventListener('cambio', () => {
    actualizarTitularesOrigenDisponibles();
    actualizarAvisoCambioCategoriaExpress();
    actualizarStockDisponibleTexto();
  });
  el('mov-titular-origen-tipo').addEventListener('cambio', () => {
    actualizarAvisoCambioCategoriaExpress();
    actualizarStockDisponibleTexto();
  });
  el('mov-titular-origen-cap').addEventListener('change', () => {
    actualizarAvisoCambioCategoriaExpress();
    actualizarStockDisponibleTexto();
  });
  el('mov-cliente').addEventListener('change', () => {
    actualizarAvisoCambioCategoriaExpress();
    actualizarStockDisponibleTexto();
  });
  el('mov-cambio-cat-boton').addEventListener('click', ejecutarCambioCategoriaExpress);
  ocultarCamposDependientesDeTipo();
  activarAccesoRapidoFeedLot();
  // El resumen y la ayuda de kilos dependen de casi todo el formulario, así
  // que en vez de enganchar campo por campo se escucha en el formulario
  // entero: los clicks de los grupos de botones y los input/change de los
  // campos burbujean hasta acá, y para cuando llegan el estado ya cambió.
  const refrescarAyudas = () => { actualizarAyudaKilos(); actualizarResumen(); };
  el('mov-form').addEventListener('click', (evento) => {
    if (evento.target.closest('.boton-opcion')) refrescarAyudas();
  });
  el('mov-form').addEventListener('input', refrescarAyudas);
  el('mov-form').addEventListener('change', refrescarAyudas);

  el('mov-form').addEventListener('submit', onSubmit);
  el('mov-editando-cancelar').addEventListener('click', cancelarEdicion);
  document.addEventListener('hacienda:editar-movimiento', (evento) => precargarParaEditar(evento.detail));
  document.addEventListener('hacienda:precargar-mortandad', (evento) => precargarParaMortandad(evento.detail));
  el('mov-sanidad-si').addEventListener('click', irACargarSanidadDelIngreso);
  el('mov-sanidad-no').addEventListener('click', ocultarAvisoSanidad);

  poblarSelectConsultaEstablecimiento();
  el('mov-consulta-establecimiento').addEventListener('change', refrescarConsultaEstablecimiento);
  el('mov-consulta-actualizar').addEventListener('click', refrescarConsultaEstablecimiento);
  refrescarConsultaEstablecimiento();
}
