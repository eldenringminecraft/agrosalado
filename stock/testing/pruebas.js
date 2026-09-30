// Pruebas automáticas de Hacienda.
//
// Corren LA APP DE VERDAD dentro de un iframe, contra el mock de Supabase
// (?mocksupabase=1). No hay librerías ni build: se abre pruebas.html en
// localhost y se toca "Correr todas".
//
// POR QUÉ ASÍ Y NO CON NODE: probando los módulos sueltos fuera del
// navegador se pierde justo lo que rompe. Un ejemplo real: `node --check`
// dio verde sobre un dashboard.js con una función declarada dos veces —
// como script suelto eso es válido, como módulo ES revienta el archivo
// entero y la pantalla de Stock no cargaba nada. Acá eso se cae en la
// primera prueba.
//
// CÓMO AGREGAR UNA PRUEBA: prueba('lo que tiene que pasar', async (app) => {
//   ... }), donde `app` trae el document de la app, su window y helpers.
// Cada prueba arranca con la app recién cargada y la base en el estado que
// le sembraste: no se pisan entre ellas ni importa el orden.

const pruebas = [];
function prueba(nombre, fn) {
  pruebas.push({ nombre, fn });
}

// ─── Aserciones ─────────────────────────────────────────────────────────

class FallaDePrueba extends Error {}

function ok(condicion, mensaje) {
  if (!condicion) throw new FallaDePrueba(mensaje || 'Se esperaba que fuera cierto.');
}

function igual(actual, esperado, mensaje) {
  if (actual !== esperado) {
    throw new FallaDePrueba(`${mensaje || 'No coinciden'}\n  esperaba: ${JSON.stringify(esperado)}\n  y fue:    ${JSON.stringify(actual)}`);
  }
}

function contiene(texto, buscado, mensaje) {
  if (!String(texto).includes(buscado)) {
    throw new FallaDePrueba(`${mensaje || 'No contiene lo buscado'}\n  buscaba:  ${JSON.stringify(buscado)}\n  y decía:  ${JSON.stringify(String(texto).slice(0, 300))}`);
  }
}

// ─── Manejo de la app dentro del iframe ─────────────────────────────────

const demora = (ms) => new Promise((r) => setTimeout(r, ms));

// Espera a que algo se cumpla en vez de dormir un rato fijo: las pruebas
// terminan apenas pueden y no se vuelven inestables cuando la máquina está
// lenta.
async function esperarA(condicion, queEspera, limiteMs = 6000) {
  const hasta = Date.now() + limiteMs;
  while (Date.now() < hasta) {
    let valor;
    try { valor = condicion(); } catch { valor = null; }
    if (valor) return valor;
    await demora(50);
  }
  throw new FallaDePrueba(`Se acabó el tiempo esperando: ${queEspera}`);
}

// Arranca la app con la base en el estado que se le pida. La semilla viaja
// por sessionStorage (mismo origen, así que el iframe la comparte) porque
// el mock la lee ANTES de que la app arranque — los grupos de botones y
// los catálogos se arman una sola vez al iniciar.
async function abrirApp(semilla, pantalla = 'cargar') {
  const iframe = document.getElementById('app');
  sessionStorage.setItem('__mock_seed', JSON.stringify(semilla || {}));

  await new Promise((resolve) => {
    iframe.onload = resolve;
    iframe.src = `../index.html?mocksupabase=1&t=${Date.now()}#${pantalla}`;
  });

  const ventana = iframe.contentWindow;
  try {
    await esperarA(() => ventana.__MOCK, 'que arranque el mock', 5000);
    await esperarA(() => ventana.document.querySelector('[data-ir="cargar"]'), 'que se dibuje la barra');
    // Los grupos de botones se llenan después de las consultas iniciales.
    await esperarA(() => ventana.document.querySelector('#mov-tipo .boton-opcion'), 'que se arme el formulario');
  } catch (error) {
    throw new FallaDePrueba(`La app no arrancó.
  ${await porQueNoArranca()}`);
  }

  const doc = ventana.document;
  const app = {
    ventana,
    doc,
    tablas: ventana.__MOCK.TABLAS,
    stock: () => ventana.__MOCK.stockActual(),
    $: (id) => doc.getElementById(id),
    texto: (id) => (doc.getElementById(id)?.textContent || '').replace(/\s+/g, ' ').trim(),
    visible: (id) => {
      const e = doc.getElementById(id);
      return !!e && !e.classList.contains('oculto');
    },
    // Un botón de un grupo "tap-to-select" (tipo de movimiento, categoría,
    // titular, establecimiento...).
    tocar: (grupoId, valor) => {
      const boton = doc.querySelector(`#${grupoId} .boton-opcion[data-value="${valor}"]`);
      if (!boton) throw new FallaDePrueba(`No existe la opción "${valor}" en ${grupoId}`);
      if (boton.disabled) throw new FallaDePrueba(`La opción "${valor}" de ${grupoId} está deshabilitada`);
      boton.click();
    },
    opciones: (grupoId) => [...doc.querySelectorAll(`#${grupoId} .boton-opcion`)]
      .filter((b) => !b.classList.contains('oculto'))
      .map((b) => ({ valor: b.dataset.value, habilitada: !b.disabled })),
    elegir: (selectId, valor) => {
      const select = doc.getElementById(selectId);
      select.value = valor;
      select.dispatchEvent(new ventana.Event('change'));
    },
    // Con bubbles: varios listeners de la app están puestos en el <form>,
    // no en cada campo (mov-form escucha 'input' para rehacer el resumen y
    // las ayudas). Un evento que no burbujea no los despierta, y la prueba
    // mediría una pantalla que en el uso real sí se habría actualizado.
    escribir: (id, valor) => {
      const campo = doc.getElementById(id);
      campo.value = valor;
      campo.dispatchEvent(new ventana.Event('input', { bubbles: true }));
      campo.dispatchEvent(new ventana.Event('change', { bubbles: true }));
    },
    enviar: (formId) => doc.getElementById(formId)
      .dispatchEvent(new ventana.Event('submit', { cancelable: true })),
    ir: async (pantalla) => {
      ventana.location.hash = pantalla;
      await esperarA(() => app.visible(`pantalla-${pantalla}`), `que se abra ${pantalla}`);
      await demora(400); // las pantallas cargan sus datos al abrirse
    },
    esperarA,
    demora,
    // Responde que sí a los confirm() sin frenar la prueba.
    confirmarTodo: () => { ventana.confirm = () => true; },
  };
  return app;
}

// Cuando la app no arranca, el "se acabó el tiempo esperando" no dice nada
// útil: la causa casi siempre es un error de JavaScript al cargar algún
// módulo. Importarlos de nuevo desde acá hace que ese error aparezca, con
// su mensaje y su archivo. (No se hace siempre: solo cuando ya falló.)
async function porQueNoArranca() {
  // app.js va último a propósito: importa a todos los demás, así que si el
  // error está en uno de ellos igual aparece, pero atribuido al archivo
  // equivocado. Revisando las hojas primero, el mensaje nombra el archivo
  // que hay que abrir.
  const modulos = ['movimientos.js', 'trabajoManga.js', 'dashboard.js', 'historial.js',
    'reportes.js', 'baston.js', 'configPanel.js', 'router.js', 'app.js'];
  for (const modulo of modulos) {
    try {
      await import(`../js/${modulo}?prueba=${Date.now()}`);
    } catch (error) {
      return `js/${modulo}: ${error.message}`;
    }
  }
  return 'No pude identificar el error. Abrí ../index.html?mocksupabase=1 y mirá la consola.';
}

// ─── Semillas ───────────────────────────────────────────────────────────

const TITULARES = [
  { id: 'agro_salado', nombre: 'Agro Salado', tipo: 'propio', orden: 1, activo: true },
  { id: 'dona_julia', nombre: 'Doña Julia', tipo: 'propio', orden: 2, activo: true },
];

// Una venta no se puede guardar sin comprador, así que toda semilla que
// vaya a vender necesita al menos uno.
const COMPRADORES = [{ id: 'brosa', nombre: 'Brosa', orden: 1, activo: true }];

function rodeo(id, codigo, establecimiento = 'san_miguel', corral = null) {
  return { id, codigo, nombre: codigo, categoria_id: null, establecimiento_id: establecimiento, activo: true, corral };
}

// Una apertura de stock, que es como la app misma carga stock inicial.
function apertura(id, { rodeo_id, establecimiento = 'san_miguel', categoria, cabezas, titular = 'agro_salado', kilos = 300 }) {
  return {
    id, tipo_movimiento: 'apertura_stock', fecha: '2026-01-10',
    establecimiento_origen: null, establecimiento_destino: establecimiento,
    categoria_origen: null, categoria_destino: categoria,
    titular_origen: null, titular_destino: titular,
    cantidad_cabezas: cabezas, kilos_promedio: kilos, usuario_id: 'u1',
    rodeo_id, rodeo_destino_id: null, anulado: false, reemplazado_por: null,
  };
}

// El campo como está de verdad: un rodeo con las vacas y sus terneros al
// pie adentro, de dos titulares, más uno de novillitos y uno vacío.
function campoTipico() {
  return {
    titulares: TITULARES,
    compradores_hacienda: COMPRADORES,
    rodeos: [
      rodeo('r1', 'Rodeo de vacas'),
      rodeo('r2', 'Rodeo de novillos'),
      rodeo('r3', 'Rodeo vacío'),
      rodeo('c3', 'Corral n°3', 'feed_lot', '3'),
    ],
    movimientos: [
      apertura('a1', { rodeo_id: 'r1', categoria: 'vaca', cabezas: 120, kilos: 420 }),
      apertura('a2', { rodeo_id: 'r1', categoria: 'vaca', cabezas: 25, titular: 'dona_julia', kilos: 415 }),
      apertura('a3', { rodeo_id: 'r1', categoria: 'ternero_al_pie', cabezas: 38, kilos: 150 }),
      apertura('a4', { rodeo_id: 'r2', categoria: 'novillito', cabezas: 60, kilos: 280 }),
    ],
  };
}

function csvBaston(filas, columnas = 'GESTACION') {
  const cabecera = `VID,EID,Date,Time,Draft,Notes,Live Weight (kg),Average Daily Gain (kg/d),Overall Daily Gain (kg/d),${columnas},Status`;
  return [cabecera, ...filas].join('\n');
}

async function subirCsv(app, texto, nombre) {
  const dt = new app.ventana.DataTransfer();
  dt.items.add(new app.ventana.File([texto], nombre, { type: 'text/csv' }));
  const input = app.$('baston-archivo');
  input.files = dt.files;
  input.dispatchEvent(new app.ventana.Event('change'));
  await esperarA(() => app.visible('baston-previo'), 'que lea el archivo');
}

// ═══ LAS PRUEBAS ════════════════════════════════════════════════════════

// ─── Cargar movimiento ──────────────────────────────────────────────────

prueba('una venta descuenta del stock del titular que vendió', async () => {
  const app = await abrirApp(campoTipico());
  app.tocar('mov-tipo', 'venta');
  app.tocar('mov-establecimiento-origen', 'san_miguel');
  await demora(300);
  app.elegir('mov-rodeo', 'r1');
  await demora(400);
  app.tocar('mov-categoria-origen', 'vaca');
  await demora(300);
  app.tocar('mov-titular-origen-tipo', 'dona_julia');
  app.tocar('mov-destino-venta', 'faena');
  app.$('mov-cabezas').value = '10';
  app.$('mov-kilos').value = '430';
  app.elegir('mov-comprador', 'brosa');
  await demora(200);

  app.enviar('mov-form');
  await esperarA(() => app.tablas.movimientos.length > 4, 'que entre la venta');

  const deDonaJulia = app.stock().find((s) => s.rodeo_id === 'r1' && s.categoria === 'vaca' && s.titular === 'dona_julia');
  igual(deDonaJulia.cabezas, 15, 'Doña Julia tenía 25 vacas y vendió 10');
  const deAgro = app.stock().find((s) => s.rodeo_id === 'r1' && s.categoria === 'vaca' && s.titular === 'agro_salado');
  igual(deAgro.cabezas, 120, 'las de Agro Salado no se tocan');
});

prueba('no se puede vender más de lo que hay (lo frena la base)', async () => {
  const app = await abrirApp(campoTipico());
  app.tocar('mov-tipo', 'venta');
  app.tocar('mov-establecimiento-origen', 'san_miguel');
  await demora(300);
  app.elegir('mov-rodeo', 'r1');
  await demora(400);
  app.tocar('mov-categoria-origen', 'vaca');
  await demora(300);
  app.tocar('mov-titular-origen-tipo', 'dona_julia');
  app.tocar('mov-destino-venta', 'faena');
  app.$('mov-cabezas').value = '99';   // tiene 25
  app.$('mov-kilos').value = '430';
  app.elegir('mov-comprador', 'brosa');
  await demora(200);

  app.enviar('mov-form');
  await demora(1200);
  igual(app.tablas.movimientos.length, 4, 'no tiene que haber entrado ningún movimiento nuevo');
});

prueba('el selector de rodeo muestra lo que cada rodeo tiene adentro', async () => {
  const app = await abrirApp(campoTipico());
  app.tocar('mov-tipo', 'venta');
  app.tocar('mov-establecimiento-origen', 'san_miguel');
  await esperarA(() => app.$('mov-rodeo').options.length > 1, 'que se pueblen los rodeos');

  const textos = [...app.$('mov-rodeo').options].map((o) => o.textContent);
  ok(textos.some((t) => t.includes('Rodeo de vacas') && t.includes('Vaca 145')),
    `el rodeo tiene que decir su composición — decía: ${JSON.stringify(textos)}`);
  ok(!textos.some((t) => t.includes('Rodeo vacío')), 'un rodeo sin stock no se ofrece para sacar animales');
});

prueba('solo se ofrecen las categorías que ese rodeo tiene', async () => {
  const app = await abrirApp(campoTipico());
  app.tocar('mov-tipo', 'venta');
  app.tocar('mov-establecimiento-origen', 'san_miguel');
  await demora(300);
  app.elegir('mov-rodeo', 'r1');
  await esperarA(() => app.opciones('mov-categoria-origen').some((o) => !o.habilitada), 'que se filtren las categorías');

  const porValor = Object.fromEntries(app.opciones('mov-categoria-origen').map((o) => [o.valor, o.habilitada]));
  igual(porValor.vaca, true, 'vaca sí (hay 145)');
  igual(porValor.ternero_al_pie, true, 'ternero al pie sí (hay 38)');
  igual(porValor.novillito, false, 'novillito no: está en el otro rodeo');
  igual(porValor.ternero, true, 'ternero sí: es el paso siguiente de ternero al pie (cambio de categoría express)');
});

prueba('solo se ofrecen los titulares con stock de esa categoría', async () => {
  const app = await abrirApp(campoTipico());
  app.tocar('mov-tipo', 'venta');
  app.tocar('mov-establecimiento-origen', 'san_miguel');
  await demora(300);
  app.elegir('mov-rodeo', 'r1');
  await demora(400);
  // El filtro de titulares sale de una consulta, así que hay que esperar a
  // que se rehaga. Se espera a que CAMBIE respecto de lo de antes, sin dar
  // por sentado cuál va a ser el resultado — si no, la prueba leería el
  // estado viejo y pasaría (o fallaría) por casualidad.
  const antes = JSON.stringify(app.opciones('mov-titular-origen-tipo'));
  app.tocar('mov-categoria-origen', 'ternero_al_pie');  // solo Agro Salado tiene
  await esperarA(() => JSON.stringify(app.opciones('mov-titular-origen-tipo')) !== antes,
    'que se recalculen los titulares disponibles');

  const porValor = Object.fromEntries(app.opciones('mov-titular-origen-tipo').map((o) => [o.valor, o.habilitada]));
  igual(porValor.agro_salado, true, 'Agro Salado tiene los 38 terneros al pie');
  igual(porValor.dona_julia, false, 'Doña Julia solo tiene vacas en ese rodeo');
});

prueba('después de una compra ofrece cargar el trabajo de manga', async () => {
  const app = await abrirApp(campoTipico());
  app.tocar('mov-tipo', 'compra_invernada');
  await demora(300);
  app.tocar('mov-establecimiento-destino', 'san_miguel');
  await demora(300);
  app.elegir('mov-rodeo', 'r2');
  app.tocar('mov-categoria-destino', 'novillito');
  await demora(300);
  app.tocar('mov-titular-destino-tipo', 'agro_salado');
  app.$('mov-cabezas').value = '40';
  app.$('mov-kilos').value = '190';
  await demora(200);

  app.enviar('mov-form');
  await esperarA(() => app.visible('mov-sanidad-aviso'), 'el cartel de sanidad');
  contiene(app.texto('mov-sanidad-texto'), '40 Novillito', 'el cartel dice qué entró');

  app.$('mov-sanidad-si').click();
  await esperarA(() => app.visible('pantalla-manga'), 'que lleve a Trabajo de Manga');
  igual(app.$('manga-rodeo').value, 'r2', 'llega con el rodeo puesto');
  ok(app.visible('manga-bloque-sanidad'), 'y con la sección Sanidad abierta');
});

// ─── Trabajo de Manga ───────────────────────────────────────────────────

prueba('el trabajo de manga guarda encerradas y trabajadas por categoría', async () => {
  const app = await abrirApp(campoTipico(), 'manga');
  await app.ir('manga');
  app.tocar('manga-establecimiento', 'san_miguel');
  await demora(300);
  app.elegir('manga-rodeo', 'r1');
  await esperarA(() => app.doc.querySelectorAll('#manga-categorias input[data-categoria]').length > 0,
    'que aparezcan las categorías del rodeo');

  app.doc.querySelector('#manga-propietarios .boton-opcion[data-value="agro_salado"]').click();
  await demora(300);
  const poner = (cat, campo, valor) => {
    const input = app.doc.querySelector(`#manga-categorias input[data-categoria="${cat}"][data-campo="${campo}"]`);
    input.value = valor;
    input.dispatchEvent(new app.ventana.Event('input'));
  };
  poner('vaca', 'encerradas', '120');
  poner('vaca', 'trabajadas', '115');
  poner('ternero_al_pie', 'encerradas', '38');
  poner('ternero_al_pie', 'trabajadas', '38');

  app.enviar('manga-form');
  await esperarA(() => app.tablas.trabajos_manga.length === 1, 'que entre el trabajo');

  const trabajo = app.tablas.trabajos_manga[0];
  igual(trabajo.cantidad_encerrada, 158, 'total encerradas');
  igual(trabajo.cantidad_trabajada, 153, 'total trabajadas');
  igual(trabajo.diferencia_pendiente, false, 'ya no existen las alertas de diferencia');
  igual(app.tablas.trabajo_manga_categorias.length, 2, 'una fila por categoría');
});

prueba('no deja trabajar más animales de los que se encerraron', async () => {
  const app = await abrirApp(campoTipico(), 'manga');
  await app.ir('manga');
  app.tocar('manga-establecimiento', 'san_miguel');
  await demora(300);
  app.elegir('manga-rodeo', 'r1');
  await esperarA(() => app.doc.querySelectorAll('#manga-categorias input[data-categoria]').length > 0, 'las categorías');
  app.doc.querySelector('#manga-propietarios .boton-opcion[data-value="agro_salado"]').click();
  await demora(300);
  const poner = (campo, valor) => {
    const input = app.doc.querySelector(`#manga-categorias input[data-categoria="vaca"][data-campo="${campo}"]`);
    input.value = valor;
    input.dispatchEvent(new app.ventana.Event('input'));
  };
  poner('encerradas', '50');
  poner('trabajadas', '60');

  app.enviar('manga-form');
  await demora(900);
  igual(app.tablas.trabajos_manga.length, 0, 'no tiene que guardar');
  contiene(app.texto('manga-mensaje'), 'no se pueden trabajar más', 'y tiene que avisar por qué');
});

// ─── Stock ──────────────────────────────────────────────────────────────

prueba('en la vista Total, el stock se abre en una columna por titular', async () => {
  const app = await abrirApp(campoTipico(), 'dashboard');
  await app.ir('dashboard');
  app.doc.querySelector('#dash-vista .boton-opcion[data-value="total"]').click();
  await demora(600);

  const encabezados = [...app.doc.querySelectorAll('#dash-global-tabla thead th')].map((t) => t.textContent);
  igual(encabezados[1], 'Total', 'el total va primero');
  ok(encabezados.includes('Agro Salado') && encabezados.includes('Doña Julia'), `faltan titulares: ${encabezados}`);
  ok(!encabezados.includes('Kg prom.'), 'en la vista Total no va el kilaje promedio');

  const filas = [...app.doc.querySelectorAll('#dash-global-tabla tbody tr')]
    .map((tr) => [...tr.cells].map((c) => c.textContent));
  const vaca = filas.find((f) => f[0] === 'Vaca');
  igual(vaca[1], '145', 'total de vacas');
  igual(vaca[encabezados.indexOf('Doña Julia')], '25', 'las de Doña Julia');
});

// ─── Configuración de rodeos ────────────────────────────────────────────

prueba('los rodeos sin stock se listan aparte, y los corrales no se dan de baja', async () => {
  const app = await abrirApp(campoTipico());
  app.doc.querySelector('[data-abrir-config], #boton-config')?.click();
  await demora(300);
  app.doc.querySelector('.panel-menu-item[data-seccion="rodeos"]').click();
  await esperarA(() => app.texto('cfgRodeosSinStockTitulo') !== '', 'la lista de rodeos vacíos');

  contiene(app.texto('cfgRodeosSinStockTitulo'), '1 rodeo sin stock', 'solo "Rodeo vacío" está vacío');
  const enLaLista = [...app.doc.querySelectorAll('#cfgRodeosSinStock .fila-cliente')].map((f) => f.textContent);
  ok(enLaLista.some((t) => t.includes('Rodeo vacío')), 'tiene que estar el rodeo vacío');
  ok(!enLaLista.some((t) => t.includes('Corral')), 'los corrales de Feed Lot no se ofrecen para dar de baja');

  // Y si se intenta igual desde el selector, tiene que frenar.
  app.confirmarTodo();
  app.elegir('cfgListaRodeos', 'c3');
  await demora(400);
  app.$('botonDarDeBajaRodeo').click();
  await esperarA(() => app.texto('cfgRodeoMensaje') !== '', 'el mensaje de error');
  contiene(app.texto('cfgRodeoMensaje'), 'Feed Lot', 'tiene que explicar por qué no se puede');
  igual(app.tablas.rodeos.find((r) => r.id === 'c3').activo, true, 'el corral sigue activo');
});

// ─── Bastón ─────────────────────────────────────────────────────────────

const FILAS_BASTON = Array.from({ length: 20 }, (_, i) => (
  `${i === 19 ? '' : 4801 + i},032 0100123${48838 + i},2026-09-29,08:${String(i).padStart(2, '0')}:00,,,${400 + i},0.8,,${i < 12 ? 'P IATF' : 'V/RE SINCRO'},`
));

prueba('el bastón pregunta solo los códigos que no conoce, y guarda', async () => {
  const app = await abrirApp({ titulares: TITULARES }, 'baston');
  await app.ir('baston');
  await subirCsv(app, csvBaston(FILAS_BASTON), 'ECO 1ERA SERVICIO.csv');

  const preguntas = [...app.doc.querySelectorAll('#baston-desconocidos-lista input[data-codigo]')]
    .map((i) => i.dataset.codigo);
  igual(preguntas.length, 2, `tiene que preguntar los 2 códigos y nada más — preguntó ${JSON.stringify(preguntas)}`);
  ok(preguntas.includes('P IATF') && preguntas.includes('V/RE SINCRO'), 'los códigos de GESTACION');

  app.doc.querySelector('input[data-codigo="P IATF"]').value = 'Preñada por IATF';
  app.doc.querySelector('input[data-codigo="V/RE SINCRO"]').value = 'Vacía';
  app.$('baston-guardar').click();
  await esperarA(() => app.tablas.lecturas_baston.length === 20, 'que entren las lecturas');

  igual(app.tablas.animales.length, 20, 'un animal por caravana electrónica');
  igual(app.tablas.sesiones_baston.length, 1, 'una sesión');
  const animal = app.tablas.animales[0];
  igual(animal.eid, '032010012348838', 'la electrónica se guarda sin separadores');
});

prueba('una columna de puros números no dispara ninguna pregunta', async () => {
  const app = await abrirApp({ titulares: TITULARES }, 'baston');
  await app.ir('baston');
  const filas = FILAS_BASTON.map((f, i) => f.replace(/,$/, `,${(3 + (i % 5) * 0.25).toFixed(2)},`));
  await subirCsv(app, csvBaston(filas, 'GESTACION,CONDICION CORPORAL'), 'TACTO.csv');

  const preguntas = [...app.doc.querySelectorAll('#baston-desconocidos-lista input[data-codigo]')]
    .map((i) => `${i.dataset.columna}·${i.dataset.codigo}`);
  igual(preguntas.length, 2, `condición corporal es una medida, no se pregunta — preguntó ${JSON.stringify(preguntas)}`);
  ok(preguntas.every((p) => p.startsWith('GESTACION')), 'solo se preguntan los códigos de GESTACION');
});

prueba('subir dos veces el mismo archivo no duplica nada', async () => {
  const app = await abrirApp({ titulares: TITULARES }, 'baston');
  await app.ir('baston');
  await subirCsv(app, csvBaston(FILAS_BASTON), 'ECO 1ERA SERVICIO.csv');
  for (const input of app.doc.querySelectorAll('#baston-desconocidos-lista input[data-codigo]')) input.value = 'x';
  app.$('baston-guardar').click();
  await esperarA(() => app.tablas.lecturas_baston.length === 20, 'la primera subida');

  await subirCsv(app, csvBaston(FILAS_BASTON), 'ECO 1ERA SERVICIO.csv');
  app.$('baston-guardar').click();
  await esperarA(() => app.texto('baston-guardar-mensaje').includes('Ya hay una sesión'), 'el aviso de repetida');
  igual(app.tablas.sesiones_baston.length, 1, 'sigue habiendo una sola sesión');
  igual(app.tablas.lecturas_baston.length, 20, 'y 20 lecturas');
});

prueba('borrar una sesión se lleva sus lecturas y deja los animales', async () => {
  const app = await abrirApp({ titulares: TITULARES }, 'baston');
  await app.ir('baston');
  await subirCsv(app, csvBaston(FILAS_BASTON), 'SESION A.csv');
  for (const input of app.doc.querySelectorAll('#baston-desconocidos-lista input[data-codigo]')) input.value = 'x';
  app.$('baston-guardar').click();
  await esperarA(() => app.tablas.lecturas_baston.length === 20, 'la sesión');

  app.doc.querySelector('.baston-tab[data-subseccion="datos"]').click();
  await esperarA(() => app.$('baston-datos-sesion').options.length > 1, 'la lista de sesiones');
  app.confirmarTodo();
  app.elegir('baston-datos-sesion', app.tablas.sesiones_baston[0].id);
  await demora(300);
  ok(app.visible('baston-borrar-sesion') !== false, 'el botón de borrar tiene que estar visible para un owner');
  app.$('baston-borrar-sesion').click();
  await esperarA(() => app.tablas.sesiones_baston.length === 0, 'que se borre la sesión');

  igual(app.tablas.lecturas_baston.length, 0, 'las lecturas se van con la sesión');
  igual(app.tablas.animales.length, 20, 'los animales quedan');
});

prueba('la planilla del bastón ordena y filtra', async () => {
  const app = await abrirApp({ titulares: TITULARES }, 'baston');
  await app.ir('baston');
  await subirCsv(app, csvBaston(FILAS_BASTON), 'SESION A.csv');
  app.doc.querySelector('input[data-codigo="P IATF"]').value = 'Preñada por IATF';
  app.doc.querySelector('input[data-codigo="V/RE SINCRO"]').value = 'Vacía';
  app.$('baston-guardar').click();
  await esperarA(() => app.tablas.lecturas_baston.length === 20, 'la sesión');

  app.doc.querySelector('.baston-tab[data-subseccion="datos"]').click();
  await esperarA(() => app.doc.querySelector('#baston-datos-tabla tbody tr'), 'la tabla');

  const pesos = () => [...app.doc.querySelectorAll('#baston-datos-tabla tbody tr')]
    .map((tr) => Number(tr.cells[5].textContent));
  app.doc.querySelector('.baston-th[data-campo="peso_kg"]').click();
  await demora(200);
  const asc = pesos();
  igual(asc[0], 400, 'ordenado por peso, el más liviano primero');
  app.doc.querySelector('.baston-th[data-campo="peso_kg"]').click();
  await demora(200);
  igual(pesos()[0], 419, 'y al revés, el más pesado');

  app.escribir('baston-datos-filtro', 'Vacía');
  await demora(300);
  contiene(app.texto('baston-datos-cuenta'), '8 de 20', 'el filtro cuenta lo que quedó');
});

// ═══ Correr y mostrar ═══════════════════════════════════════════════════

async function correrTodas() {
  const contenedor = document.getElementById('resultados');
  const resumen = document.getElementById('resumen');
  contenedor.innerHTML = '';
  resumen.textContent = 'Corriendo...';
  resumen.className = '';

  const resultados = [];
  let appCaida = false;
  for (const { nombre, fn } of pruebas) {
    // Si la app no arranca, todas las pruebas van a fallar igual y por lo
    // mismo: 15 esperas de 6 segundos que no aportan nada. Se corta.
    if (appCaida) {
      const div = document.createElement('div');
      div.className = 'prueba';
      div.textContent = `⏭️ ${nombre} (no se corrió: la app no arranca)`;
      contenedor.appendChild(div);
      resultados.push({ nombre, ok: false, ms: 0, error: 'no se corrió: la app no arranca' });
      continue;
    }
    const div = document.createElement('div');
    div.className = 'prueba corriendo';
    div.textContent = `⏳ ${nombre}`;
    contenedor.appendChild(div);

    const arranque = Date.now();
    try {
      await fn();
      const ms = Date.now() - arranque;
      div.className = 'prueba ok';
      div.innerHTML = `<span class="duracion">${ms} ms</span>✅ ${nombre}`;
      resultados.push({ nombre, ok: true, ms });
    } catch (error) {
      const ms = Date.now() - arranque;
      div.className = 'prueba falla';
      div.innerHTML = `<span class="duracion">${ms} ms</span>❌ ${nombre}`;
      const detalle = document.createElement('div');
      detalle.className = 'detalle';
      detalle.textContent = error instanceof FallaDePrueba ? error.message : `${error.name}: ${error.message}`;
      div.appendChild(detalle);
      resultados.push({ nombre, ok: false, ms, error: error.message });
      if (error.message.startsWith('La app no arrancó')) appCaida = true;
    }
  }

  const fallaron = resultados.filter((r) => !r.ok);
  resumen.textContent = fallaron.length
    ? `${fallaron.length} de ${resultados.length} fallaron`
    : `${resultados.length} pruebas, todas bien`;
  resumen.className = fallaron.length ? 'falla' : 'ok';
  // Para poder leer el resultado desde afuera (consola o herramientas).
  window.__RESULTADOS = resultados;
  return resultados;
}

document.getElementById('correr').addEventListener('click', correrTodas);
window.__CORRER_PRUEBAS = correrTodas;
