import { supabase } from './supabaseClient.js';
import { ESTABLECIMIENTOS, CATEGORIAS } from './config.js';
import { stockCacheGet, stockCacheSet } from './db-local.js';
import { exportarMatrizStock, exportarStockEstablecimiento } from './export.js';
import { cargarTitulares, obtenerTitularesCache } from './titulares.js';
import { cargarRodeos, obtenerRodeosCache } from './rodeos.js';
import { crearGrupoBotones, obtenerSeleccion, establecerSeleccion } from './botones.js';

function el(id) {
  return document.getElementById(id);
}

function esCapitalizador(titularId) {
  const t = obtenerTitularesCache().find((x) => x.id === titularId);
  return t ? t.tipo === 'capitalizador' : titularId !== 'agro_salado' && titularId !== 'dona_julia';
}

// Hotelería: hacienda de un tercero que NO es socio (titulares.tipo =
// 'cliente'), que solo está pensionada en Feed Lot. No es ni del grupo ni
// de un capitalizador, así que antes no caía en ningún balde: no se veía en
// ninguna vista salvo "Total" y quedaba afuera del Total general.
function esCliente(titularId) {
  return obtenerTitularesCache().find((x) => x.id === titularId)?.tipo === 'cliente';
}

// Agro Salado y Doña Julia no viven en la tabla titulares (son fijos), así
// que el cache solo resuelve capitalizadores y clientes de hotelería.
const NOMBRES_TITULAR_FIJOS = { agro_salado: 'Agro Salado', dona_julia: 'Doña Julia' };

// Los nombres de capitalizadores y clientes de hotelería los escribe el
// usuario, y acá se arman encabezados de tabla con innerHTML.
function esc(texto) {
  const d = document.createElement('div');
  d.textContent = texto ?? '';
  return d.innerHTML;
}

function nombreTitular(titularId) {
  return NOMBRES_TITULAR_FIJOS[titularId]
    || obtenerTitularesCache().find((t) => t.id === titularId)?.nombre
    || titularId;
}

// Los titulares que tienen algo, en el orden en que se los piensa: primero
// los propios, después capitalizadores y hotelería (por el orden con el que
// están cargados en titulares).
function titularesConStock(rows) {
  const conStock = new Set();
  for (const r of rows) if (r.cabezas !== 0) conStock.add(r.titular);
  const propios = ['agro_salado', 'dona_julia'].filter((id) => conStock.has(id));
  const resto = obtenerTitularesCache()
    .filter((t) => conStock.has(t.id) && !NOMBRES_TITULAR_FIJOS[t.id])
    .map((t) => t.id);
  // Por las dudas: un titular con stock que no esté en el cache igual entra.
  const sueltos = [...conStock].filter((id) => !propios.includes(id) && !resto.includes(id));
  return [...propios, ...resto, ...sueltos];
}

// Filtra las filas de stock_actual según la "vista" de titularidad elegida.
// titularElegido: el del desplegable que acompaña a "Capitalizadores" y a
// "Hotelería" para ver uno solo en vez de la suma de todos.
function filtrarPorVista(rows, vista, titularElegido) {
  if (vista === 'agro_salado') return rows.filter((r) => r.titular === 'agro_salado');
  if (vista === 'dona_julia') return rows.filter((r) => r.titular === 'dona_julia');
  if (vista === 'capitalizadores') {
    if (titularElegido) return rows.filter((r) => r.titular === titularElegido);
    return rows.filter((r) => esCapitalizador(r.titular));
  }
  if (vista === 'hoteleria') {
    if (titularElegido) return rows.filter((r) => r.titular === titularElegido);
    return rows.filter((r) => esCliente(r.titular));
  }
  if (vista === 'total') return rows; // AS + DJ + todos los capitalizadores, sin filtrar
  return rows.filter((r) => r.titular === 'agro_salado' || r.titular === 'dona_julia'); // 'grupo'
}

function construirMatriz(rows) {
  const matriz = {};
  for (const e of ESTABLECIMIENTOS) {
    matriz[e.id] = {};
    for (const c of CATEGORIAS) matriz[e.id][c.id] = 0;
  }
  for (const r of rows) {
    if (matriz[r.establecimiento]) matriz[r.establecimiento][r.categoria] = (matriz[r.establecimiento][r.categoria] || 0) + r.cabezas;
  }
  return matriz;
}

// Kilos promedio ponderado por celda establecimiento×categoría: pondera
// el kilos_promedio_ponderado de cada fila de stock_actual (que ya viene
// ponderado a nivel rodeo/titular) por sus propias cabezas — es la misma
// identidad matemática que un promedio ponderado de promedios ponderados
// (sum(cabezas×kg)/sum(cabezas) en cada nivel de agregación).
function construirMatrizKilos(rows) {
  const sumaKg = {};
  const sumaCab = {};
  for (const e of ESTABLECIMIENTOS) {
    sumaKg[e.id] = {};
    sumaCab[e.id] = {};
    for (const c of CATEGORIAS) { sumaKg[e.id][c.id] = 0; sumaCab[e.id][c.id] = 0; }
  }
  for (const r of rows) {
    if (!sumaCab[r.establecimiento] || r.kilos_promedio_ponderado == null || r.cabezas <= 0) continue;
    sumaCab[r.establecimiento][r.categoria] += r.cabezas;
    sumaKg[r.establecimiento][r.categoria] += r.cabezas * r.kilos_promedio_ponderado;
  }
  const matriz = {};
  for (const e of ESTABLECIMIENTOS) {
    matriz[e.id] = {};
    for (const c of CATEGORIAS) {
      matriz[e.id][c.id] = sumaCab[e.id][c.id] > 0 ? sumaKg[e.id][c.id] / sumaCab[e.id][c.id] : null;
    }
  }
  return matriz;
}

function totalesKilosPorCategoria(rows) {
  const sumaKg = {};
  const sumaCab = {};
  for (const c of CATEGORIAS) { sumaKg[c.id] = 0; sumaCab[c.id] = 0; }
  for (const r of rows) {
    if (r.kilos_promedio_ponderado == null || r.cabezas <= 0) continue;
    sumaCab[r.categoria] = (sumaCab[r.categoria] || 0) + r.cabezas;
    sumaKg[r.categoria] = (sumaKg[r.categoria] || 0) + r.cabezas * r.kilos_promedio_ponderado;
  }
  const resultado = {};
  for (const c of CATEGORIAS) resultado[c.id] = sumaCab[c.id] > 0 ? sumaKg[c.id] / sumaCab[c.id] : null;
  return resultado;
}

function formatearKilos(kg) {
  return kg == null ? '—' : `${kg.toFixed(0)} kg`;
}

// Rodeos con stock (>0) en un establecimiento, sumando titulares — para el
// detalle que se abre al tocar la fila en "Por establecimiento". Un rodeo
// puede tener más de una categoría a la vez (los 4 corrales fijos de Feed
// Lot, ver rodeoDelCorral en rodeos.js), así que se acumula una lista de
// categoría+cabezas por rodeo, no un valor único.
function rodeosPorEstablecimiento(rows, establecimientoId) {
  const acumulado = {};
  for (const r of rows) {
    if (r.establecimiento !== establecimientoId || !r.rodeo_id || r.cabezas <= 0) continue;
    if (!acumulado[r.rodeo_id]) acumulado[r.rodeo_id] = { rodeoId: r.rodeo_id, rodeo: r.rodeo, categorias: [] };
    acumulado[r.rodeo_id].categorias.push({ categoriaId: r.categoria, cabezas: r.cabezas });
  }
  return Object.values(acumulado).sort((a, b) => (a.rodeo || '').localeCompare(b.rodeo || ''));
}

async function obtenerStock() {
  const { data, error } = await supabase.from('stock_actual').select('*');
  if (!error) {
    await stockCacheSet(data);
    return { rows: data, offline: false, fetchedAt: new Date().toISOString() };
  }
  const cache = await stockCacheGet();
  if (cache) return { rows: cache.rows, offline: true, fetchedAt: cache.fetched_at };
  return { rows: [], offline: true, fetchedAt: null };
}

function hoyISO() {
  return new Date().toISOString().slice(0, 10);
}

function esHoy(fecha) {
  return !fecha || fecha === hoyISO();
}

// Reconstruye el stock a una fecha pasada sumando movimiento_lineas hasta
// esa fecha, con la misma agregación (y misma fórmula de kilos promedio
// ponderado) que la vista stock_actual — así el resultado tiene la misma
// forma de fila y las tablas/exportación existentes lo pueden usar sin
// cambios cuando la fecha elegida no es hoy.
async function obtenerStockAFecha(fecha) {
  const { data, error } = await supabase
    .from('movimiento_lineas')
    .select('establecimiento, categoria, titular, rodeo_id, delta_cabezas, kilos_promedio')
    .lte('fecha', fecha);
  if (error) throw error;

  const grupos = {};
  for (const r of data) {
    const clave = `${r.establecimiento}|${r.categoria}|${r.titular}|${r.rodeo_id || ''}`;
    if (!grupos[clave]) {
      grupos[clave] = { establecimiento: r.establecimiento, categoria: r.categoria, titular: r.titular, rodeo_id: r.rodeo_id, cabezas: 0, sumaKg: 0 };
    }
    grupos[clave].cabezas += r.delta_cabezas;
    grupos[clave].sumaKg += r.delta_cabezas * r.kilos_promedio;
  }

  const rodeosCache = obtenerRodeosCache();
  return Object.values(grupos).map((g) => ({
    establecimiento: g.establecimiento,
    categoria: g.categoria,
    titular: g.titular,
    rodeo_id: g.rodeo_id,
    rodeo: g.rodeo_id ? rodeosCache.find((r) => r.id === g.rodeo_id)?.codigo || null : null,
    cabezas: g.cabezas,
    kilos_promedio_ponderado: g.cabezas > 0 ? Math.round((g.sumaKg / g.cabezas) * 100) / 100 : null,
  }));
}

function renderEstado({ offline, fetchedAt, fecha }) {
  const contenedor = el('dash-estado');
  if (!esHoy(fecha)) {
    contenedor.textContent = `Mostrando stock al ${formatearFechaDMY(fecha)}.`;
    contenedor.className = 'ok';
    return;
  }
  const hora = fetchedAt ? new Date(fetchedAt).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) : '—';
  if (!offline) {
    contenedor.textContent = `Actualizado a las ${hora}.`;
    contenedor.className = 'ok';
    return;
  }
  contenedor.textContent = `Sin conexión — mostrando datos de las ${hora}.`;
  contenedor.className = 'advertencia';
}

// Un bolsillo (rodeo + categoría + titular) en negativo significa que se
// sacaron más cabezas de las que había — dato roto que hay que corregir a
// mano. Desde la migración 042 la base no deja que pase, pero los que
// hayan quedado de antes seguirían restando en silencio de los totales.
function renderStockNegativo(rows) {
  const contenedor = el('dash-stock-negativo');
  const negativos = rows.filter((r) => r.cabezas < 0);
  if (!negativos.length) {
    contenedor.classList.add('oculto');
    contenedor.textContent = '';
    return;
  }
  const detalle = negativos.map((r) => {
    const rodeo = r.rodeo || obtenerRodeosCache().find((x) => x.id === r.rodeo_id)?.codigo || 'sin rodeo';
    const categoria = CATEGORIAS.find((c) => c.id === r.categoria)?.nombre || r.categoria;
    return `${rodeo} — ${categoria} de ${nombreTitular(r.titular)}: ${r.cabezas}`;
  }).join(' · ');
  contenedor.textContent = `⚠️ Hay stock en negativo (se sacaron más cabezas de las que había): ${detalle}. Estos totales están mal hasta que se corrija: revisá el Historial de ese rodeo y anulá o corregí el movimiento que sobra.`;
  contenedor.classList.remove('oculto');
}

function renderResumenTitularidad(rows) {
  const suma = (filtro) => rows.filter(filtro).reduce((acc, r) => acc + r.cabezas, 0);
  const totalAgro = suma((r) => r.titular === 'agro_salado');
  const totalDona = suma((r) => r.titular === 'dona_julia');
  const totalGrupo = totalAgro + totalDona;
  const totalTerceros = suma((r) => esCapitalizador(r.titular));
  const totalHoteleria = suma((r) => esCliente(r.titular));
  // La hacienda en hotelería no es nuestra, pero está en el campo: si no
  // entra acá, el Total general no coincide con lo que hay de verdad.
  const totalGeneral = totalGrupo + totalTerceros + totalHoteleria;

  el('dash-total-agro').textContent = totalAgro;
  el('dash-total-dona').textContent = totalDona;
  el('dash-total-grupo').textContent = totalGrupo;
  el('dash-total-terceros').textContent = totalTerceros;
  el('dash-total-hoteleria').textContent = totalHoteleria;
  el('dash-total-general').textContent = totalGeneral;
}

// Las categorías que no tienen nada se esconden: con 10 categorías y la
// mayoría en cero, las tablas quedaban llenas de columnas y filas vacías
// que solo hacían ruido y las volvían más anchas que la pantalla.
function categoriasConStock(rows) {
  const hay = new Set();
  for (const r of rows) if (r.cabezas !== 0) hay.add(r.categoria);
  return CATEGORIAS.filter((c) => hay.has(c.id));
}

// En la vista "Total" este cuadro se abre por titular: el total sigue
// primero (es el número que se mira) y cada titular suma su columna, en
// vez del kilaje promedio — mezclar hacienda de varios dueños en un mismo
// promedio no dice nada útil, y de quién es cada cosa sí.
function renderGlobal(rows, porTitular) {
  const totales = {};
  for (const c of CATEGORIAS) totales[c.id] = 0;
  for (const r of rows) totales[r.categoria] = (totales[r.categoria] || 0) + r.cabezas;

  const tabla = el('dash-global-tabla');
  const titulares = porTitular ? titularesConStock(rows) : [];
  tabla.querySelector('thead').innerHTML = porTitular
    ? `<tr><th>Categoría</th><th>Total</th>${titulares.map((t) => `<th>${esc(nombreTitular(t))}</th>`).join('')}</tr>`
    : '<tr><th>Categoría</th><th>Cabezas</th><th>Kg prom.</th></tr>';

  const tbody = tabla.querySelector('tbody');
  tbody.innerHTML = '';
  const visibles = CATEGORIAS.filter((c) => totales[c.id] !== 0);
  if (!visibles.length) {
    tbody.innerHTML = `<tr><td colspan="${porTitular ? titulares.length + 2 : 3}">Sin stock para esta selección.</td></tr>`;
    return;
  }

  // porTitular[categoria][titular] = cabezas
  const matriz = {};
  if (porTitular) {
    for (const r of rows) {
      matriz[r.categoria] = matriz[r.categoria] || {};
      matriz[r.categoria][r.titular] = (matriz[r.categoria][r.titular] || 0) + r.cabezas;
    }
  }
  const kilos = porTitular ? null : totalesKilosPorCategoria(rows);

  for (const c of visibles) {
    const tr = document.createElement('tr');
    tr.innerHTML = porTitular
      ? `<td>${c.nombre}</td><td><strong>${totales[c.id]}</strong></td>` +
        titulares.map((t) => `<td>${matriz[c.id]?.[t] || ''}</td>`).join('')
      : `<td>${c.nombre}</td><td>${totales[c.id]}</td><td class="kilos-cell">${formatearKilos(kilos[c.id])}</td>`;
    tbody.appendChild(tr);
  }

  const totalGeneral = Object.values(totales).reduce((a, b) => a + b, 0);
  const trTotal = document.createElement('tr');
  trTotal.classList.add('fila-total');
  trTotal.innerHTML = porTitular
    ? `<td><strong>Total</strong></td><td><strong>${totalGeneral}</strong></td>` +
      titulares.map((t) => {
        const suma = rows.filter((r) => r.titular === t).reduce((acc, r) => acc + r.cabezas, 0);
        return `<td><strong>${suma}</strong></td>`;
      }).join('')
    : `<td><strong>Total</strong></td><td><strong>${totalGeneral}</strong></td><td></td>`;
  tbody.appendChild(trTotal);
}

// rowsFiltradas: mismas filas (ya filtradas por vista de titularidad) que
// se usaron para armar `matriz`, para poder abrir el detalle de rodeos de
// cada establecimiento con la misma vista activa.
function renderPorEstablecimiento(matriz, matrizKilos, rowsFiltradas) {
  const tabla = el('dash-establecimientos-tabla');
  // Solo las categorías con algo EN ESTA TABLA (Feed Lot va aparte, así que
  // sus categorías no deben abrir columna acá).
  const visibles = categoriasConStock(rowsFiltradas.filter((r) => r.establecimiento !== 'feed_lot'));
  tabla.querySelector('thead').innerHTML =
    `<tr><th>Establecimiento</th>${visibles.map((c) => `<th>${c.nombre}</th>`).join('')}<th>Total</th></tr>`;

  const tbody = tabla.querySelector('tbody');
  tbody.innerHTML = '';
  const totalesPorCategoria = {};
  for (const c of visibles) totalesPorCategoria[c.id] = 0;

  // Feed Lot sale de esta tabla: tiene su propio cuadro abierto por corral
  // más abajo, que es como se mira en la práctica (no interesa "cuánto hay
  // en Feed Lot" sino qué hay en cada corral).
  for (const e of ESTABLECIMIENTOS.filter((x) => x.id !== 'feed_lot')) {
    const totalFila = visibles.reduce((acc, c) => acc + matriz[e.id][c.id], 0);
    for (const c of visibles) totalesPorCategoria[c.id] += matriz[e.id][c.id];

    const tr = document.createElement('tr');
    tr.className = 'fila-clickeable';
    tr.innerHTML =
      `<td>${e.nombre}</td>` +
      visibles.map((c) => `<td>${matriz[e.id][c.id]}${matrizKilos[e.id][c.id] != null ? `<br><span class="kilos-cell">${formatearKilos(matrizKilos[e.id][c.id])}</span>` : ''}</td>`).join('') +
      `<td><strong>${totalFila}</strong></td>`;

    const trRodeos = document.createElement('tr');
    trRodeos.className = 'fila-rodeos oculto';
    const tdRodeos = document.createElement('td');
    tdRodeos.colSpan = visibles.length + 2;
    const rodeos = rodeosPorEstablecimiento(rowsFiltradas, e.id);
    tdRodeos.innerHTML = rodeos.length
      ? `<strong>${rodeos.length} rodeo(s):</strong> ` + rodeos.map((r) => {
          const detalle = r.categorias
            .map(({ categoriaId, cabezas }) => `${CATEGORIAS.find((c) => c.id === categoriaId)?.nombre || categoriaId}: ${cabezas}`)
            .join(', ');
          return `<button type="button" class="link-rodeo" data-rodeo-id="${r.rodeoId}">${r.rodeo}</button> (${detalle})`;
        }).join(' · ')
      : 'Sin rodeos con stock en este establecimiento.';
    tdRodeos.querySelectorAll('.link-rodeo').forEach((boton) => {
      boton.addEventListener('click', (evento) => {
        evento.stopPropagation();
        document.dispatchEvent(new CustomEvent('hacienda:ver-historia-rodeo', { detail: { rodeoId: boton.dataset.rodeoId } }));
      });
    });
    trRodeos.appendChild(tdRodeos);

    tr.addEventListener('click', () => trRodeos.classList.toggle('oculto'));
    tbody.appendChild(tr);
    tbody.appendChild(trRodeos);
  }

  const totalGeneral = Object.values(totalesPorCategoria).reduce((a, b) => a + b, 0);
  const trTotal = document.createElement('tr');
  trTotal.classList.add('fila-total');
  trTotal.innerHTML =
    `<td><strong>Total (sin Feed Lot)</strong></td>${visibles.map((c) => `<td><strong>${totalesPorCategoria[c.id]}</strong></td>`).join('')}<td><strong>${totalGeneral}</strong></td>`;
  tbody.appendChild(trTotal);

  // Al sacar Feed Lot de esta tabla, su total dejó de estar acá y los
  // números ya no cierran contra la tarjeta de arriba ni contra "Por
  // categoría". En vez de dejar esa diferencia sin explicación, se dice
  // cuánto hay en Feed Lot y cuánto da la suma de las dos cosas.
  const enFeedLot = rowsFiltradas
    .filter((r) => r.establecimiento === 'feed_lot')
    .reduce((acc, r) => acc + r.cabezas, 0);
  if (enFeedLot !== 0) {
    const trFeedLot = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = visibles.length + 2;
    td.innerHTML = `<span class="ayuda">En Feed Lot hay <strong>${enFeedLot}</strong> cabeza(s) más, que se ven abajo abiertas por corral. Total con Feed Lot: <strong>${totalGeneral + enFeedLot}</strong>.</span>`;
    trFeedLot.appendChild(td);
    tbody.appendChild(trFeedLot);
  }
}

// ─── Feed Lot por corral ────────────────────────────────────────────────
// Los 4 corrales son fijos (migración 039) y se listan SIEMPRE, aunque
// estén vacíos: que un corral figure en cero es información, no un dato que
// falta. Por eso se recorre la lista fija y no los rodeos que tengan stock.
const CORRALES_FEED_LOT = ['1', '2', '3', '4'];

// De quién es la hacienda que hay en un corral, con el desglose por
// categoría de cada uno — es lo que se despliega al tocar la fila.
function titularesDelCorral(rowsDelCorral) {
  const acumulado = {};
  for (const r of rowsDelCorral) {
    if (r.cabezas <= 0) continue;
    if (!acumulado[r.titular]) acumulado[r.titular] = { titular: r.titular, categorias: [], total: 0 };
    acumulado[r.titular].categorias.push({ categoriaId: r.categoria, cabezas: r.cabezas });
    acumulado[r.titular].total += r.cabezas;
  }
  return Object.values(acumulado).sort((a, b) => b.total - a.total);
}

function renderPorCorral(rows) {
  const tabla = el('dash-corrales-tabla');
  // Igual que en la tabla de establecimientos: solo columnas con algo.
  // Si Feed Lot está vacío no queda ninguna, y se muestran los 4 corrales
  // en cero igual (que estén vacíos es el dato).
  const visibles = categoriasConStock(rows);
  tabla.querySelector('thead').innerHTML =
    `<tr><th>Corral</th>${visibles.map((c) => `<th>${c.nombre}</th>`).join('')}<th>Total</th></tr>`;

  const tbody = tabla.querySelector('tbody');
  tbody.innerHTML = '';
  const totalesPorCategoria = {};
  for (const c of visibles) totalesPorCategoria[c.id] = 0;

  for (const corral of CORRALES_FEED_LOT) {
    const rodeo = obtenerRodeosCache().find((r) => r.establecimiento_id === 'feed_lot' && r.corral === corral);
    const delCorral = rodeo ? rows.filter((r) => r.rodeo_id === rodeo.id) : [];

    const porCategoria = {};
    for (const c of visibles) porCategoria[c.id] = 0;
    for (const r of delCorral) {
      if (porCategoria[r.categoria] === undefined) porCategoria[r.categoria] = 0;
      porCategoria[r.categoria] += r.cabezas;
    }
    const totalFila = visibles.reduce((acc, c) => acc + (porCategoria[c.id] || 0), 0);
    for (const c of visibles) totalesPorCategoria[c.id] += porCategoria[c.id] || 0;

    const tr = document.createElement('tr');
    tr.className = 'fila-clickeable';
    tr.innerHTML =
      `<td>Corral ${corral}</td>` +
      visibles.map((c) => `<td>${porCategoria[c.id] || 0}</td>`).join('') +
      `<td><strong>${totalFila}</strong></td>`;

    const trDetalle = document.createElement('tr');
    trDetalle.className = 'fila-rodeos oculto';
    const td = document.createElement('td');
    td.colSpan = visibles.length + 2;
    const titulares = titularesDelCorral(delCorral);
    td.innerHTML = titulares.length
      ? `<strong>Por titular:</strong> ` + titulares.map((t) => {
          const detalle = t.categorias
            .map(({ categoriaId, cabezas }) => `${CATEGORIAS.find((c) => c.id === categoriaId)?.nombre || categoriaId}: ${cabezas}`)
            .join(', ');
          return `${nombreTitular(t.titular)} (${detalle})`;
        }).join(' · ')
      : 'Corral vacío.';
    trDetalle.appendChild(td);

    tr.addEventListener('click', () => trDetalle.classList.toggle('oculto'));
    tbody.appendChild(tr);
    tbody.appendChild(trDetalle);
  }

  const totalGeneral = Object.values(totalesPorCategoria).reduce((a, b) => a + b, 0);
  const trTotal = document.createElement('tr');
  trTotal.classList.add('fila-total');
  trTotal.innerHTML =
    `<td><strong>Total</strong></td>${visibles.map((c) => `<td><strong>${totalesPorCategoria[c.id]}</strong></td>`).join('')}<td><strong>${totalGeneral}</strong></td>`;
  tbody.appendChild(trTotal);
}

// Detalle de rodeos de UN establecimiento — cabezas y kilos promedio
// ponderado por rodeo (a diferencia de rodeosPorEstablecimiento, que solo
// suma cabezas para el detalle plegable de "Por establecimiento").
function rodeosDetalladosPorEstablecimiento(rows, establecimientoId) {
  const acumulado = {};
  for (const r of rows) {
    if (r.establecimiento !== establecimientoId || !r.rodeo_id || r.cabezas <= 0) continue;
    if (!acumulado[r.rodeo_id]) acumulado[r.rodeo_id] = { rodeoId: r.rodeo_id, rodeo: r.rodeo, categorias: new Set(), cabezas: 0, sumaKg: 0 };
    const acc = acumulado[r.rodeo_id];
    acc.categorias.add(r.categoria);
    acc.cabezas += r.cabezas;
    if (r.kilos_promedio_ponderado != null) acc.sumaKg += r.cabezas * r.kilos_promedio_ponderado;
  }
  return Object.values(acumulado)
    .map((acc) => ({
      rodeo: acc.rodeo,
      categorias: [...acc.categorias].map((id) => CATEGORIAS.find((c) => c.id === id)?.nombre || id).join(', '),
      cabezas: acc.cabezas,
      kilosPromedio: acc.cabezas > 0 ? acc.sumaKg / acc.cabezas : null,
    }))
    .sort((a, b) => (a.rodeo || '').localeCompare(b.rodeo || ''));
}

function poblarSelectRodeosEstablecimiento() {
  const select = el('dash-rodeos-establecimiento');
  select.innerHTML = '<option value="">Elegir establecimiento...</option>';
  for (const e of ESTABLECIMIENTOS) {
    const opt = document.createElement('option');
    opt.value = e.id;
    opt.textContent = e.nombre;
    select.appendChild(opt);
  }
}

function renderRodeosEstablecimiento() {
  const establecimientoId = el('dash-rodeos-establecimiento').value;
  const tabla = el('dash-rodeos-tabla');
  if (!establecimientoId) { tabla.classList.add('oculto'); return; }
  tabla.classList.remove('oculto');
  const rodeos = rodeosDetalladosPorEstablecimiento(ultimasFilasStock, establecimientoId);
  const tbody = tabla.querySelector('tbody');
  tbody.innerHTML = rodeos.length
    ? rodeos.map((r) => `<tr><td>${r.rodeo || ''}</td><td>${r.categorias}</td><td>${r.cabezas}</td><td>${formatearKilos(r.kilosPromedio)}</td></tr>`).join('')
    : '<tr><td colspan="4">Sin rodeos con stock en este establecimiento.</td></tr>';
}

// ─── selectores de vista (AS+DJ / Agro Salado / Doña Julia /
// Capitalizadores / Hotelería / Total) ───

// El mismo desplegable sirve para "Capitalizadores" y para "Hotelería": se
// vuelve a llenar con unos u otros según la vista, en vez de tener dos
// selects casi idénticos en pantalla.
const TIPO_TITULAR_POR_VISTA = { capitalizadores: 'capitalizador', hoteleria: 'cliente' };

function poblarSelectTitulares(idSelect, tipo) {
  const select = el(idSelect);
  select.innerHTML = '<option value="">Todos (suma)</option>';
  if (!tipo) return;
  for (const c of obtenerTitularesCache().filter((t) => t.tipo === tipo)) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.nombre;
    select.appendChild(opt);
  }
}

function inicializarSelectorVista(idGrupo, idCapWrap, idCapSelect, onCambio) {
  crearGrupoBotones(idGrupo, [
    { id: 'grupo', nombre: 'AS + DJ' },
    { id: 'agro_salado', nombre: 'Agro Salado' },
    { id: 'dona_julia', nombre: 'Doña Julia' },
    { id: 'capitalizadores', nombre: 'Capitalizadores' },
    { id: 'hoteleria', nombre: 'Hotelería' },
    { id: 'total', nombre: 'Total' },
  ]);
  poblarSelectTitulares(idCapSelect, 'capitalizador');
  establecerSeleccion(idGrupo, 'grupo');

  el(idGrupo).addEventListener('cambio', () => {
    const vista = obtenerSeleccion(idGrupo);
    const tipo = TIPO_TITULAR_POR_VISTA[vista];
    el(idCapWrap).classList.toggle('oculto', !tipo);
    if (tipo) poblarSelectTitulares(idCapSelect, tipo);
    onCambio();
  });
  el(idCapSelect).addEventListener('change', onCambio);
}

function leerVista(idGrupo, idCapSelect) {
  return { vista: obtenerSeleccion(idGrupo), titularElegido: el(idCapSelect).value || null };
}

let ultimasFilasStock = [];

// Los tres cuadros comparten el mismo selector de titularidad: elegir por
// separado en cada uno era repetir tres veces la misma decisión.
function renderTablasFiltradas() {
  const { vista, titularElegido } = leerVista('dash-vista', 'dash-vista-cap-select');
  const rows = filtrarPorVista(ultimasFilasStock, vista, titularElegido);

  // Solo en "Total" tiene sentido abrir por titular: en cualquier otra
  // vista ya se está mirando a uno solo (o a un grupo puntual).
  renderGlobal(rows, vista === 'total');
  renderPorEstablecimiento(construirMatriz(rows), construirMatrizKilos(rows), rows);
  renderPorCorral(rows.filter((r) => r.establecimiento === 'feed_lot'));
}

function formatearFechaDMY(fecha) {
  const [y, m, d] = fecha.split('-');
  return `${d}/${m}/${y}`;
}

function poblarSelectExportarEstablecimiento() {
  const select = el('dash-exportar-establecimiento');
  select.innerHTML = '<option value="">Todos los establecimientos</option>';
  for (const e of ESTABLECIMIENTOS) {
    const opt = document.createElement('option');
    opt.value = e.id;
    opt.textContent = e.nombre;
    select.appendChild(opt);
  }
}

export async function refrescarDashboard() {
  const fecha = el('dash-fecha').value || hoyISO();
  const hoy = esHoy(fecha);

  let rows;
  let offline = false;
  let fetchedAt = null;
  if (hoy) {
    ({ rows, offline, fetchedAt } = await obtenerStock());
  } else {
    try {
      rows = await obtenerStockAFecha(fecha);
      fetchedAt = new Date().toISOString();
    } catch (error) {
      el('dash-estado').textContent = `No se pudo calcular el stock a esa fecha (¿sin conexión?): ${error.message}`;
      el('dash-estado').className = 'error';
      return;
    }
  }

  ultimasFilasStock = rows;
  renderEstado({ offline, fetchedAt, fecha });
  renderStockNegativo(rows);
  renderResumenTitularidad(rows);
  renderTablasFiltradas();
  renderRodeosEstablecimiento();
}

// Exporta la misma vista (titularidad + fecha) que está en pantalla: un
// establecimiento puntual si se eligió uno en el selector de exportación,
// o todos desagregados + integrados (fila Total) en una sola hoja.
// Filas de la hoja "Detalle por titular": una por cada combinación real de
// establecimiento + categoría + titular + rodeo.
//
// A propósito NO se filtra por la vista de titularidad que esté elegida en
// pantalla: el sentido de esta hoja es ver de quién es cada cosa, así que
// sale completa aunque arriba se esté mirando solo Agro Salado. La hoja de
// resumen sí respeta la vista, como siempre.
//
// Se saltean las filas en cero (ruido) pero NO las negativas: si un rodeo
// quedó en negativo conviene que aparezca en el Excel, no esconderlo.
function filasDetalleParaExcel(establecimientoId) {
  const ordenEst = Object.fromEntries(ESTABLECIMIENTOS.map((e, i) => [e.id, i]));
  const ordenCat = Object.fromEntries(CATEGORIAS.map((c, i) => [c.id, i]));

  return ultimasFilasStock
    .filter((r) => r.cabezas !== 0 && (!establecimientoId || r.establecimiento === establecimientoId))
    .sort((a, b) =>
      (ordenEst[a.establecimiento] ?? 99) - (ordenEst[b.establecimiento] ?? 99)
      || (ordenCat[a.categoria] ?? 99) - (ordenCat[b.categoria] ?? 99)
      || nombreTitular(a.titular).localeCompare(nombreTitular(b.titular)))
    .map((r) => ({
      Establecimiento: ESTABLECIMIENTOS.find((e) => e.id === r.establecimiento)?.nombre || r.establecimiento,
      Categoría: CATEGORIAS.find((c) => c.id === r.categoria)?.nombre || r.categoria,
      Titular: nombreTitular(r.titular),
      Rodeo: r.rodeo || obtenerRodeosCache().find((x) => x.id === r.rodeo_id)?.codigo || '',
      Cabezas: r.cabezas,
      'Kg prom.': r.kilos_promedio_ponderado ?? '',
    }));
}

function exportarStock() {
  const fecha = el('dash-fecha').value || hoyISO();
  const establecimientoId = el('dash-exportar-establecimiento').value || null;
  const { vista, titularElegido } = leerVista('dash-vista', 'dash-vista-cap-select');
  const rows = filtrarPorVista(ultimasFilasStock, vista, titularElegido);
  const detalle = filasDetalleParaExcel(establecimientoId);

  if (establecimientoId) {
    const nombreEst = ESTABLECIMIENTOS.find((e) => e.id === establecimientoId)?.nombre || establecimientoId;
    const totales = {};
    for (const c of CATEGORIAS) totales[c.id] = 0;
    for (const r of rows) {
      if (r.establecimiento === establecimientoId) totales[r.categoria] = (totales[r.categoria] || 0) + r.cabezas;
    }
    exportarStockEstablecimiento(totales, nombreEst, `stock_${establecimientoId}_${fecha}`, detalle);
    return;
  }

  const matriz = construirMatriz(rows);
  exportarMatrizStock(matriz, `stock_${fecha}`, `Stock al ${fecha}`, detalle);
}

export async function initDashboard() {
  await Promise.all([cargarTitulares(), cargarRodeos()]);
  inicializarSelectorVista('dash-vista', 'dash-vista-cap-wrap', 'dash-vista-cap-select', renderTablasFiltradas);
  poblarSelectExportarEstablecimiento();
  poblarSelectRodeosEstablecimiento();
  el('dash-fecha').value = hoyISO();
  el('dash-fecha').addEventListener('change', refrescarDashboard);
  el('dash-actualizar').addEventListener('click', refrescarDashboard);
  el('dash-exportar').addEventListener('click', exportarStock);
  el('dash-rodeos-establecimiento').addEventListener('change', renderRodeosEstablecimiento);
  refrescarDashboard();
}
