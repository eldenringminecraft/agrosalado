// Rodeos: grupos de animales que se trackean como unidad (nacen, engordan,
// se mueven de establecimiento, van a feed lot, se venden). Mismo patrón
// que titulares.js (cache local + alta on-the-fly desde el formulario).
//
// Un rodeo es un GRUPO EN UN ESTABLECIMIENTO, nada más: no tiene
// categoría (migración 045). Adentro puede haber vacas y terneros al pie
// a la vez, y de hecho es lo normal — la categoría se lee siempre del
// stock (vista stock_actual, agrupada por establecimiento + categoría +
// titular + rodeo), nunca de una etiqueta del rodeo.
import { supabase } from './supabaseClient.js';

let cache = [];

export async function cargarRodeos() {
  const { data, error } = await supabase.from('rodeos').select('*').eq('activo', true).order('codigo');
  if (!error) cache = data;
  return cache;
}

export function obtenerRodeosCache() {
  return cache;
}

// ─── Qué tiene adentro cada rodeo, de verdad ────────────────────────────
// `rodeos.categoria_id` dice que un rodeo es de UNA categoría, pero el
// stock real (vista stock_actual) está agrupado por establecimiento +
// categoría + titular + rodeo: un mismo rodeo puede tener novillitos y
// novillos a la vez, y los tiene. Esto trae esa composición real, una vez,
// para poder mostrarla en los selectores en vez de la etiqueta.
//
// Es una FOTO cacheada, para dibujar. Para validar una salida se sigue
// usando stockDelRodeoPorCategoriaYTitular() en vivo (y abajo de todo el
// trigger de stock negativo, ver migración 042) — nunca esto.
let composicion = new Map();  // rodeo_id -> [{ categoriaId, cabezas }], de mayor a menor
let composicionCargada = false;

export async function cargarComposicionRodeos() {
  const { data, error } = await supabase.from('stock_actual').select('rodeo_id, categoria, cabezas');
  if (error) {
    // Sin red esto falla y no pasa nada: quien dibuja el selector se da
    // cuenta por hayComposicionCargada() y vuelve al filtro de siempre.
    console.warn('No se pudo traer la composición de los rodeos:', error);
    return composicion;
  }
  const porRodeo = new Map();
  for (const fila of data) {
    const cabezas = Number(fila.cabezas) || 0;
    if (!fila.rodeo_id || cabezas <= 0) continue;
    const porCategoria = porRodeo.get(fila.rodeo_id) || new Map();
    porCategoria.set(fila.categoria, (porCategoria.get(fila.categoria) || 0) + cabezas);
    porRodeo.set(fila.rodeo_id, porCategoria);
  }
  composicion = new Map([...porRodeo].map(([rodeoId, porCategoria]) => [
    rodeoId,
    [...porCategoria]
      .map(([categoriaId, cabezas]) => ({ categoriaId, cabezas }))
      .sort((a, b) => b.cabezas - a.cabezas),
  ]));
  composicionCargada = true;
  return composicion;
}

export function hayComposicionCargada() {
  return composicionCargada;
}

export function composicionDelRodeo(rodeoId) {
  return composicion.get(rodeoId) || [];
}

export function cabezasDelRodeoEnCategoria(rodeoId, categoriaId) {
  return composicionDelRodeo(rodeoId).find((c) => c.categoriaId === categoriaId)?.cabezas || 0;
}

// La única forma de filtrar rodeos es por dónde están. Antes había además
// rodeosDe(establecimiento, categoría) y rodeosDeCategoria(categoría),
// que filtraban por la etiqueta del rodeo — se fueron con la migración
// 045, junto con la etiqueta. Para saber si un rodeo tiene lo que buscás,
// se mira el stock (ver la composición más arriba).
export function rodeosDeEstablecimiento(establecimientoId) {
  return cache.filter((r) => r.establecimiento_id === establecimientoId);
}

// Un rodeo de Feed Lot es uno de los 4 corrales fijos ("Corral n°1".."Corral
// n°4") — nunca se crea ni se busca por categoría, siempre existen. Esto
// es lo único que hace falta para resolver a qué rodeo va/sale cualquier
// movimiento que toque Feed Lot (ver movimientos.js).
export function rodeoDelCorral(corral) {
  return cache.find((r) => r.establecimiento_id === 'feed_lot' && r.corral === corral);
}

// El rodeo se llama como lo escribiste y listo. Hasta la migración 045 el
// código se armaba solo, pegándole el año y un correlativo atrás
// ("Vaquillona San Miguel 202601"): esa numeración existía porque hacía
// falta un rodeo por categoría y había que distinguirlos entre sí. Ya no:
// un rodeo es un grupo, se le pone el nombre con el que se lo llama en el
// campo. Los rodeos viejos conservan el código que tienen hasta que se
// los renombre desde Configuración.
//
// El nombre tiene que ser único (lo pide la base): dos rodeos con el
// mismo nombre serían imposibles de distinguir en los selectores.
function errorDeNombreRepetido(error, nombre) {
  return error?.code === '23505'
    ? new Error(`Ya existe un rodeo llamado "${nombre}". Poné otro nombre.`)
    : error;
}

export async function crearRodeo({ nombre, establecimientoId, fechaCreacion, usuarioId }) {
  const codigo = nombre.trim();
  const { data, error } = await supabase
    .from('rodeos')
    .insert({
      nombre: codigo,
      codigo,
      establecimiento_id: establecimientoId,
      fecha_creacion: fechaCreacion || new Date().toISOString().slice(0, 10),
      creado_por: usuarioId,
    })
    .select()
    .single();
  if (error) throw errorDeNombreRepetido(error, codigo);
  cache = [...cache, data];
  return data;
}

export async function renombrarRodeo(id, nuevoNombre) {
  const codigo = nuevoNombre.trim();
  const { data, error } = await supabase
    .from('rodeos')
    .update({ nombre: codigo, codigo })
    .eq('id', id)
    .select()
    .single();
  if (error) throw errorDeNombreRepetido(error, codigo);
  cache = cache.map((r) => (r.id === id ? data : r));
  return data;
}

// "Dar de baja" un rodeo sin stock: no se borra (rompería la trazabilidad
// de los movimientos que ya lo referencian, y no hay policy de delete a
// propósito), se marca activo=false — cargarRodeos() ya filtra por
// activo=true, así que a partir de acá deja de aparecer en "Cargar
// movimiento", Trabajo de Manga y este mismo panel, sin perder su
// historial.
export async function darDeBajaRodeo(id) {
  // Los 4 corrales de Feed Lot existen siempre: todo movimiento que toque
  // Feed Lot se resuelve contra uno de ellos (ver rodeoDelCorral), así que
  // dar uno de baja —aunque esté vacío, que es lo normal— dejaría a Feed
  // Lot sin forma de cargar nada.
  const rodeo = cache.find((r) => r.id === id);
  if (rodeo?.establecimiento_id === 'feed_lot') {
    throw new Error('Los corrales de Feed Lot no se dan de baja: siempre tienen que existir.');
  }
  const cabezas = await stockDelRodeo(id);
  if (cabezas > 0) {
    throw new Error(`Este rodeo todavía tiene ${cabezas} cabeza(s) de stock — no se puede dar de baja.`);
  }
  const { data, error } = await supabase.from('rodeos').update({ activo: false }).eq('id', id).select().single();
  if (error) throw error;
  cache = cache.filter((r) => r.id !== id);
  return data;
}

// Cabezas actuales de un rodeo (sumando todos los titulares) — se pide en
// vivo al validar un movimiento de salida/interna, no se cachea, para no
// dar luz verde con un stock desactualizado.
export async function stockDelRodeo(rodeoId) {
  const { data, error } = await supabase.from('stock_actual').select('cabezas').eq('rodeo_id', rodeoId);
  if (error) throw error;
  return data.reduce((acc, r) => acc + Number(r.cabezas), 0);
}

// Cabezas de una categoría puntual dentro de un rodeo (ej. cuántos
// "ternero" hay en el rodeo de la madre, para validar un Destete).
export async function stockDelRodeoPorCategoria(rodeoId, categoriaId) {
  const { data, error } = await supabase.from('stock_actual').select('cabezas').eq('rodeo_id', rodeoId).eq('categoria', categoriaId);
  if (error) throw error;
  return data.reduce((acc, r) => acc + Number(r.cabezas), 0);
}

// Cabezas de una categoría Y titular puntuales dentro de un rodeo — un
// rodeo puede tener stock de más de un titular a la vez (ej. dos
// Aperturas de stock distintas al mismo corral de Feed Lot), así que
// "el rodeo tiene stock" no alcanza para validar una salida/interna:
// tiene que ser ESE titular el que tenga stock de ESA categoría ahí. Sin
// esto, se podía vender a nombre de un titular sin stock real con tal de
// que ALGÚN otro titular del mismo rodeo sí lo tuviera.
export async function stockDelRodeoPorCategoriaYTitular(rodeoId, categoriaId, titularId) {
  const { data, error } = await supabase
    .from('stock_actual')
    .select('cabezas')
    .eq('rodeo_id', rodeoId)
    .eq('categoria', categoriaId)
    .eq('titular', titularId);
  if (error) throw error;
  return data.reduce((acc, r) => acc + Number(r.cabezas), 0);
}

// Igual que la de arriba, pero además devuelve el kilo promedio ponderado
// — lo usa el Cambio de categoría "express" (ver movimientos.js) para
// saber no solo si hay stock de la categoría anterior de la cadena, sino
// cuántas cabezas y con qué peso mover exactamente.
export async function stockDetalleRodeoCategoriaYTitular(rodeoId, categoriaId, titularId) {
  const { data, error } = await supabase
    .from('stock_actual')
    .select('cabezas, kilos_promedio_ponderado')
    .eq('rodeo_id', rodeoId)
    .eq('categoria', categoriaId)
    .eq('titular', titularId);
  if (error) throw error;
  const cabezas = data.reduce((acc, r) => acc + Number(r.cabezas), 0);
  const kilosPromedioPonderado = cabezas > 0
    ? data.reduce((acc, r) => acc + Number(r.cabezas) * Number(r.kilos_promedio_ponderado), 0) / cabezas
    : null;
  return { cabezas, kilosPromedioPonderado };
}

// Todo lo que hay adentro de un rodeo, en vivo y abierto por categoría y
// titular. Es lo que arma el cuadro de stock de Trabajo de Manga y lo que
// decide qué titulares y qué categorías se pueden elegir ahí: no se pide
// a la caché de composición (que es una foto para dibujar selectores) sino
// a la base, porque de acá salen las cantidades que se van a cargar.
export async function stockDetalladoDelRodeo(rodeoId) {
  const { data, error } = await supabase
    .from('stock_actual')
    .select('categoria, titular, cabezas')
    .eq('rodeo_id', rodeoId);
  if (error) throw error;
  return data
    .map((f) => ({ categoriaId: f.categoria, titularId: f.titular, cabezas: Number(f.cabezas) || 0 }))
    .filter((f) => f.cabezas > 0);
}

// Nota: ya no hace falta "registrar entrada/salida de feed lot" — el
// corral de un rodeo de Feed Lot es fijo para siempre (uno de los 4
// corrales), nunca se asigna ni se limpia por movimiento. El "corral"
// simplemente ES el campo `corral` de esos 4 rodeos, ya disponible en
// cache/obtenerRodeosCache() sin pedir nada aparte (ver dashboard.js).
