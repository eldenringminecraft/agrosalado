// Supabase falso para probar la app en el navegador sin tocar la base real.
//
// Se activa SOLO en localhost con ?mocksupabase=1 (el candado de hostname
// está en supabaseClient.js). Vive acá, aparte, para que nunca más haya que
// pegar un mock adentro de un archivo de producción y acordarse de sacarlo
// antes de commitear — eso estuvo a punto de publicar la app apuntando a
// datos falsos más de una vez.
//
// QUÉ SIMULA (fiel a supabase/schema.sql):
//   · La vista historial_trabajos_manga: se calcula desde trabajos_manga,
//     así que se siembra esa tabla y no la vista.
//   · La vista stock_actual: SIEMPRE se calcula a partir de movimientos,
//     igual que en la base (movimiento_lineas → agrupado por
//     establecimiento+categoría+titular+rodeo, ignorando anulados y
//     reemplazados). Por eso no se siembra stock a mano: se usa
//     sembrarStock(), que carga una apertura como lo haría la app.
//   · trg_actualizar_rodeo_tras_movimiento (el establecimiento del rodeo
//     tras un traslado; desde la migración 045 el rodeo ya no tiene
//     categoría, así que el trigger no toca nada más).
//   · trg_validar_stock_no_negativo (migración 042): rechaza la salida que
//     dejaría el bolsillo abajo de cero.
//
// QUÉ NO SIMULA (si una prueba depende de esto, no sirve el mock):
//   · RLS y permisos por rol.
//   · Los códigos correlativos (M-000123) que genera la base.
//   · validar_movimiento(): las reglas de forma por tipo de movimiento.
//   · Los joins de las vistas historial_* (se pueden sembrar a mano en la
//     tabla correspondiente si una prueba las necesita).

import { CATEGORIAS } from '../config.js';

const TITULAR_POR_DEFECTO = 'agro_salado';

export function tablasVacias() {
  return {
    perfiles: [{ user_id: 'u1', nombre_completo: 'Juan Test', rol: 'owner', activo: true, acceso_hacienda: true, acceso_granos: true, acceso_precios_relativos: true, acceso_logistica: true }],
    titulares: [],
    rodeos: [],
    categorias: [],
    establecimientos: [],
    compradores_hacienda: [],
    movimientos: [],
    trabajos_manga: [],
    trabajo_manga_propietarios: [],
    trabajo_manga_categorias: [],
    animales: [],
    sesiones_baston: [],
    lecturas_baston: [],
    columnas_baston: [],
    codigos_baston: [],
    feed_lot_ciclos: [],
    rodeo_secuencias: [],
    rodeo_pesadas_historial: [],
    rectificaciones_pendientes: [],
    historial_movimientos: [],
    historial_trabajos_manga: [],
  };
}

// Los 4 corrales fijos de Feed Lot, como los deja la migración 039.
export function corralesFeedLot(anio = new Date().getFullYear()) {
  return ['1', '2', '3', '4'].map((corral) => ({
    id: `corral${corral}`,
    codigo: `Corral n°${corral}`,
    nombre: `Corral n°${corral}`,
    categoria_id: null,
    establecimiento_id: 'feed_lot',
    activo: true,
    corral,
    anio,
    secuencia: 0,
  }));
}

// ─── vista movimiento_lineas / stock_actual ─────────────────────────────

function lineasDe(movimientos) {
  const lineas = [];
  for (const m of movimientos) {
    if (m.anulado || m.reemplazado_por) continue;
    if (m.establecimiento_destino) {
      lineas.push({
        id: m.id,
        fecha: m.fecha,
        establecimiento: m.establecimiento_destino,
        categoria: m.categoria_destino,
        titular: m.titular_destino || TITULAR_POR_DEFECTO,
        rodeo_id: m.rodeo_destino_id || m.rodeo_id,
        delta_cabezas: Number(m.cantidad_cabezas),
        kilos_promedio: Number(m.kilos_promedio),
      });
    }
    if (m.establecimiento_origen) {
      lineas.push({
        id: m.id,
        fecha: m.fecha,
        establecimiento: m.establecimiento_origen,
        categoria: m.categoria_origen,
        titular: m.titular_origen || TITULAR_POR_DEFECTO,
        rodeo_id: m.rodeo_id,
        delta_cabezas: -Number(m.cantidad_cabezas),
        kilos_promedio: Number(m.kilos_promedio),
      });
    }
  }
  return lineas;
}

function stockActualDe(TABLAS) {
  const grupos = {};
  for (const l of lineasDe(TABLAS.movimientos)) {
    const clave = `${l.establecimiento}|${l.categoria}|${l.titular}|${l.rodeo_id || ''}`;
    if (!grupos[clave]) {
      grupos[clave] = {
        establecimiento: l.establecimiento, categoria: l.categoria, titular: l.titular,
        rodeo_id: l.rodeo_id, rodeo: TABLAS.rodeos.find((r) => r.id === l.rodeo_id)?.codigo || null,
        cabezas: 0, sumaKg: 0,
      };
    }
    grupos[clave].cabezas += l.delta_cabezas;
    grupos[clave].sumaKg += l.delta_cabezas * l.kilos_promedio;
  }
  return Object.values(grupos).map((g) => ({
    establecimiento: g.establecimiento, categoria: g.categoria, titular: g.titular,
    rodeo_id: g.rodeo_id, rodeo: g.rodeo,
    cabezas: g.cabezas,
    kilos_promedio_ponderado: g.cabezas > 0 ? Math.round((g.sumaKg / g.cabezas) * 100) / 100 : null,
  }));
}

// La vista historial_trabajos_manga: se calcula desde trabajos_manga, como
// en la base. Si se sembrara aparte, una anulación o una corrección
// actualizarían la tabla pero el listado seguiría mostrando lo viejo, y la
// prueba daría un falso negativo.
function historialTrabajosMangaDe(TABLAS) {
  const nombreDe = (userId) => TABLAS.perfiles.find((p) => p.user_id === userId)?.nombre_completo || null;
  return TABLAS.trabajos_manga
    .map((t) => ({
      ...t,
      rodeo: TABLAS.rodeos.find((r) => r.id === t.rodeo_id)?.codigo || null,
      establecimiento_id: TABLAS.rodeos.find((r) => r.id === t.rodeo_id)?.establecimiento_id || null,
      categoria_nombre: CATEGORIAS.find((c) => c.id === t.categoria_id)?.nombre || t.categoria_id,
      usuario_nombre: nombreDe(t.usuario_id),
      editado_por_nombre: nombreDe(t.editado_por),
    }))
    .sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
}

// La vista historial_lecturas_baston: join de lecturas + sesión + animal.
function historialLecturasBastonDe(TABLAS) {
  return TABLAS.lecturas_baston.map((l) => {
    const sesion = TABLAS.sesiones_baston.find((x) => x.id === l.sesion_id) || {};
    const animal = TABLAS.animales.find((x) => x.id === l.animal_id) || {};
    return {
      ...l,
      sesion: sesion.nombre ?? null,
      fecha: sesion.fecha ?? null,
      establecimiento_id: sesion.establecimiento_id ?? null,
      eid: animal.eid ?? null,
    };
  });
}

// ─── triggers de movimientos ────────────────────────────────────────────

function stockDelBolsillo(TABLAS, est, cat, tit, rodeoId, excluirId) {
  return lineasDe(TABLAS.movimientos.filter((m) => m.id !== excluirId))
    .filter((l) => l.establecimiento === est && l.categoria === cat && l.titular === tit && l.rodeo_id === rodeoId)
    .reduce((acc, l) => acc + l.delta_cabezas, 0);
}

// Espejo de trg_validar_stock_no_negativo (migración 042). Devuelve el
// mensaje de error, o null si la operación es válida.
function validarStockNoNegativo(TABLAS, mov) {
  if (!mov.establecimiento_origen || !mov.categoria_origen || !mov.rodeo_id) return null;
  const tit = mov.titular_origen || TITULAR_POR_DEFECTO;
  const stock = stockDelBolsillo(TABLAS, mov.establecimiento_origen, mov.categoria_origen, tit, mov.rodeo_id, mov.editado_de);
  const saca = Number(mov.cantidad_cabezas);
  if (stock - saca >= 0) return null;
  return `No hay stock suficiente: ${tit} tiene ${stock} cabeza(s) de ${mov.categoria_origen} en ese rodeo y este movimiento saca ${saca}.`;
}

// Espejo de trg_actualizar_rodeo_tras_movimiento.
function actualizarRodeoTrasMovimiento(TABLAS, mov) {
  const rodeo = TABLAS.rodeos.find((r) => r.id === mov.rodeo_id);
  if (!rodeo || mov.rodeo_destino_id) return;
  if (mov.tipo_movimiento === 'traslado') {
    rodeo.establecimiento_id = mov.establecimiento_destino;
  }
}

// "on delete cascade" del esquema: borrar el padre se lleva a los hijos.
// Sin esto el mock miente sobre lo que pasa de verdad — una prueba podría
// dar por bueno que algo quedó cuando en la base se borra.
const CASCADAS = {
  sesiones_baston: [['lecturas_baston', 'sesion_id']],
  trabajos_manga: [
    ['trabajo_manga_propietarios', 'trabajo_manga_id'],
    ['trabajo_manga_categorias', 'trabajo_manga_id'],
    ['trabajo_manga_sanidad', 'trabajo_manga_id'],
    ['trabajo_manga_vacunas', 'trabajo_manga_id'],
    ['trabajo_manga_otras_sanidades', 'trabajo_manga_id'],
    ['trabajo_manga_reproduccion', 'trabajo_manga_id'],
    ['trabajo_manga_inseminacion_toros', 'trabajo_manga_id'],
    ['trabajo_manga_manejo', 'trabajo_manga_id'],
  ],
  columnas_baston: [['codigos_baston', 'columna']],
};

function borrarEnCascada(TABLAS, tabla, borradas) {
  for (const [hija, campo] of CASCADAS[tabla] || []) {
    if (!TABLAS[hija]) continue;
    const clave = tabla === 'columnas_baston' ? 'columna' : 'id';
    const ids = new Set(borradas.map((f) => f[clave]));
    TABLAS[hija] = TABLAS[hija].filter((f) => !ids.has(f[campo]));
  }
}

// ─── cliente falso ──────────────────────────────────────────────────────

function clonar(filas) {
  return JSON.parse(JSON.stringify(filas));
}

// Semilla para pruebas que necesitan los datos ANTES de que arranque la
// app: los grupos de botones (propietarios) y los catálogos (drogas,
// vacunas, toros) se arman UNA sola vez al iniciar, así que sembrar desde
// la consola después ya llega tarde. Desde la consola:
//   sessionStorage.setItem('__mock_seed', JSON.stringify(tablas)); location.reload();
// Se borra sola al usarse, para que la próxima recarga arranque limpia.
function leerSemilla() {
  try {
    const crudo = sessionStorage.getItem('__mock_seed');
    if (!crudo) return null;
    sessionStorage.removeItem('__mock_seed');
    return { ...tablasVacias(), ...JSON.parse(crudo) };
  } catch {
    return null;
  }
}

export function activarMockSupabase(supabase, tablas) {
  const TABLAS = tablas || leerSemilla() || tablasVacias();

  // Inyección de fallas, para probar los caminos de error sin tener que
  // desenchufar nada. Desde la consola:
  //   window.__MOCK.fallas.update = { code: 'X', message: 'lo que sea' }
  //   window.__MOCK.fallas.update = { message: 'Failed to fetch' }  // "sin red"
  const fallas = { insert: null, upsert: null, update: null };
  // Un error tiene que poder encadenarse igual que una consulta que anda:
  // el cliente real permite .insert(...).select().single() y devuelve el
  // error al final, no al llamar .select(). Sin esto, el código que usa
  // esa cadena revienta con un TypeError en vez de recibir el error.
  const comoError = (falla) => {
    const fin = { data: null, error: falla };
    const encadenable = {
      then: (resolve) => resolve(fin),
      single: () => Promise.resolve(fin),
      maybeSingle: () => Promise.resolve(fin),
    };
    for (const metodo of ['select', 'eq', 'neq', 'is', 'in', 'gt', 'gte', 'lt', 'lte', 'ilike', 'or', 'order', 'limit']) {
      encadenable[metodo] = () => encadenable;
    }
    return encadenable;
  };

  supabase.auth.getSession = async () => ({ data: { session: { user: { id: 'u1' } } } });
  supabase.auth.onAuthStateChange = () => ({ data: { subscription: { unsubscribe() {} } } });
  supabase.auth.signInWithPassword = async () => ({ data: { session: { user: { id: 'u1' } } }, error: null });
  supabase.auth.signOut = async () => ({ error: null });
  let secuencia = 1;
  supabase.rpc = async () => ({ data: ++secuencia, error: null });

  supabase.from = (tabla) => {
    const esVista = tabla === 'stock_actual' || tabla === 'historial_trabajos_manga'
      || tabla === 'historial_lecturas_baston';
    if (!esVista) TABLAS[tabla] = TABLAS[tabla] || [];
    let filas;
    if (tabla === 'stock_actual') filas = stockActualDe(TABLAS);
    else if (tabla === 'historial_trabajos_manga') filas = historialTrabajosMangaDe(TABLAS);
    else if (tabla === 'historial_lecturas_baston') filas = historialLecturasBastonDe(TABLAS);
    else filas = [...TABLAS[tabla]];
    let modo = 'select';
    let payload = null;

    const resolver = () => {
      if (modo === 'update') {
        for (const f of filas) Object.assign(f, payload);
      }
      return { data: clonar(filas), error: null };
    };

    const builder = {
      select() { return builder; },
      insert(obj) {
        if (fallas.insert) return comoError(fallas.insert);
        const objs = Array.isArray(obj) ? obj : [obj];
        const nuevas = objs.map((o) => ({ id: 'gen_' + Math.random().toString(36).slice(2), activo: true, ...o }));
        if (tabla === 'movimientos') {
          for (const mov of nuevas) {
            const error = validarStockNoNegativo(TABLAS, mov);
            if (error) return comoError({ code: 'P0001', message: error });
          }
        }
        if (tabla === 'sesiones_baston') {
          for (const nueva of nuevas) {
            if (TABLAS.sesiones_baston.some((x) => x.nombre === nueva.nombre && x.fecha === nueva.fecha)) {
              return comoError({ code: '23505', message: 'duplicate key value violates unique constraint' });
            }
          }
        }
        TABLAS[tabla].push(...nuevas);
        if (tabla === 'movimientos') for (const mov of nuevas) actualizarRodeoTrasMovimiento(TABLAS, mov);
        filas = nuevas;
        return builder;
      },
      upsert(obj, opciones) {
        if (fallas.upsert) return comoError(fallas.upsert);
        const objs = Array.isArray(obj) ? obj : [obj];
        const claves = (opciones?.onConflict || 'id').split(',').map((c) => c.trim());
        for (const o of objs) {
          const existente = TABLAS[tabla].find((f) => claves.every((k) => f[k] === o[k]));
          if (existente) {
            if (!opciones?.ignoreDuplicates) Object.assign(existente, o);
            continue;
          }
          if (tabla === 'movimientos') {
            const error = validarStockNoNegativo(TABLAS, o);
            if (error) return comoError({ code: 'P0001', message: error });
          }
          TABLAS[tabla].push({ ...o });
          if (tabla === 'movimientos') actualizarRodeoTrasMovimiento(TABLAS, o);
        }
        filas = objs;
        return builder;
      },
      update(v) { modo = 'update'; payload = v; return builder; },
      delete() { modo = 'delete'; return builder; },
      eq(c, v) { filas = filas.filter((f) => f[c] === v); return builder; },
      neq(c, v) { filas = filas.filter((f) => f[c] !== v); return builder; },
      is(c, v) { filas = filas.filter((f) => (f[c] ?? null) === v); return builder; },
      in(c, arr) { filas = filas.filter((f) => arr.includes(f[c])); return builder; },
      gt(c, v) { filas = filas.filter((f) => f[c] > v); return builder; },
      gte(c, v) { filas = filas.filter((f) => f[c] >= v); return builder; },
      lt(c, v) { filas = filas.filter((f) => f[c] < v); return builder; },
      lte(c, v) { filas = filas.filter((f) => f[c] <= v); return builder; },
      ilike(c, v) {
        const s = String(v).replace(/%/g, '').toLowerCase();
        filas = filas.filter((f) => String(f[c] ?? '').toLowerCase().includes(s));
        return builder;
      },
      // Soporta "col.eq.valor" y la forma negada "col.not.is.null".
      or(expr) {
        const clausulas = expr.split(',').map((c) => c.split('.'));
        filas = filas.filter((f) => clausulas.some((p) => {
          if (p[1] === 'not' && p[2] === 'is' && p[3] === 'null') return (f[p[0]] ?? null) !== null;
          if (p[1] === 'is' && p[2] === 'null') return (f[p[0]] ?? null) === null;
          return String(f[p[0]]) === p[2];
        }));
        return builder;
      },
      order(campo, opts) {
        filas = filas.slice().sort((a, b) => {
          const av = a[campo], bv = b[campo];
          return opts?.ascending === false ? String(bv).localeCompare(String(av)) : String(av).localeCompare(String(bv));
        });
        return builder;
      },
      limit(n) { filas = filas.slice(0, n); return builder; },
      maybeSingle() { const r = resolver(); return Promise.resolve({ data: r.data?.[0] ?? null, error: null }); },
      single() {
        const r = resolver();
        return Promise.resolve({ data: r.data?.[0] ?? null, error: r.data?.[0] ? null : { message: 'no encontrado' } });
      },
      then(resolve) {
        if (modo === 'update' && fallas.update) {
          resolve({ data: null, error: fallas.update });
          return;
        }
        if (modo === 'delete') {
          // Por referencia y no por id: varias tablas hijas (por ejemplo
          // trabajo_manga_propietarios) tienen clave compuesta y no tienen
          // columna id — filtrando por id se borraría la tabla entera.
          const aBorrar = new Set(filas);
          TABLAS[tabla] = TABLAS[tabla].filter((f) => !aBorrar.has(f));
          borrarEnCascada(TABLAS, tabla, filas);
          resolve({ data: clonar(filas), error: null });
          return;
        }
        resolve(resolver());
      },
    };
    return builder;
  };

  // Carga stock como lo haría la app: con una apertura. Así stock_actual
  // sale del mismo cálculo que en producción y no de datos inventados.
  const sembrarStock = ({ establecimiento, categoria, titular, rodeo_id, cabezas, kilos = 300, fecha }) => {
    TABLAS.movimientos.push({
      id: 'siembra_' + Math.random().toString(36).slice(2),
      tipo_movimiento: 'apertura_stock',
      fecha: fecha || new Date().toISOString().slice(0, 10),
      establecimiento_origen: null,
      establecimiento_destino: establecimiento,
      categoria_origen: null,
      categoria_destino: categoria,
      titular_origen: null,
      titular_destino: titular,
      cantidad_cabezas: cabezas,
      kilos_promedio: kilos,
      usuario_id: 'u1',
      rodeo_id,
      rodeo_destino_id: null,
      anulado: false,
      reemplazado_por: null,
    });
  };

  window.__MOCK = { TABLAS, supabase, fallas, sembrarStock, stockActual: () => stockActualDe(TABLAS) };
  window.__TABLAS_MOCK = TABLAS; // alias corto, cómodo desde la consola
  console.warn('⚠️ MOCK SUPABASE ACTIVO (?mocksupabase=1) — datos falsos, solo para testing. Helpers en window.__MOCK');
  return window.__MOCK;
}
