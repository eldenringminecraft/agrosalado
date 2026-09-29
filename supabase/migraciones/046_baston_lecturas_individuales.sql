-- 046 · Hacienda: seguimiento individual por caravana electrónica (bastón)
--
-- Todo lo que hay hasta acá mide hacienda AGREGADA: cuántas cabezas hay en
-- cada bolsillo (establecimiento + categoría + titular + rodeo). Esto es
-- otra cosa: el animal de a uno, identificado por su caravana electrónica.
-- Las dos capas conviven y no se tocan — el stock se sigue moviendo con
-- movimientos, nunca con esto.
--
-- El bastón exporta un CSV por sesión de trabajo. Trae columnas fijas (la
-- caravana visual y la electrónica, fecha, hora, peso, ganancia diaria) y
-- además las que se hayan configurado para ESA jornada: en el primer
-- archivo real fue "GESTACION", con los códigos "P IATF" y "V/RE SINCRO".
--
-- Decisiones que explican la forma de estas tablas:
--
-- 1) La identidad es la caravana ELECTRÓNICA, no la visual. La visual se
--    cae, se despinta y se reutiliza (en el primer archivo ya viene un
--    animal sin visual). Guardarla como identidad sería quedarse sin forma
--    de reconstruir la historia el día que se recaravanea.
--
-- 2) Las columnas variables NO son columnas de la base. Van a un jsonb.
--    Si cada columna que alguien configura en el bastón fuera una columna
--    real, en un año hay una tabla con 40 columnas, 35 siempre vacías, y
--    cada jornada nueva necesita una migración.
--
-- 3) El historial de caravanas visuales tampoco es una tabla: cada lectura
--    guarda la visual que el animal tenía ESE día, así que la historia
--    queda sola.
--
-- 4) Establecimiento, rodeo y trabajo de manga son OPCIONALES en la sesión:
--    los animales no necesariamente están asignados a un rodeo.
--
-- No toca nada de lo que ya existe.

-- ─── El animal ──────────────────────────────────────────────────────────

create table animales (
  id uuid primary key default gen_random_uuid(),
  -- Normalizada, sin espacios ni separadores: el bastón exporta
  -- "032 010012348838" pero podría exportarlo distinto, y el mismo animal
  -- no puede entrar dos veces por un espacio de diferencia.
  eid text not null unique,
  eid_original text,
  -- La caravana visual de HOY. Nullable: hay animales que la perdieron.
  vid text,
  primera_lectura_at timestamptz,
  ultima_lectura_at timestamptz,
  creado_at timestamptz not null default now()
);

create index on animales (vid);

-- ─── La sesión: un CSV subido ───────────────────────────────────────────

create table sesiones_baston (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  archivo text,
  -- La fecha del TRABAJO (la que trae el CSV), no la de la subida: se
  -- puede trabajar el lunes y subir el jueves.
  fecha date not null,
  establecimiento_id text references establecimientos(id),
  rodeo_id uuid references rodeos(id),
  trabajo_manga_id uuid references trabajos_manga(id),
  observaciones text,
  cantidad_lecturas int not null default 0,
  subido_por uuid not null references auth.users(id),
  creado_at timestamptz not null default now(),
  -- El nombre del archivo se repite todos los años ("ECO 1ERA SERVICIO"),
  -- así que lo que no se puede repetir es nombre + fecha. Subir dos veces
  -- el mismo archivo avisa en vez de duplicar 112 lecturas.
  unique (nombre, fecha)
);

create index on sesiones_baston (fecha desc);

-- ─── La lectura: un animal en una sesión ────────────────────────────────

create table lecturas_baston (
  id uuid primary key default gen_random_uuid(),
  sesion_id uuid not null references sesiones_baston(id) on delete cascade,
  animal_id uuid not null references animales(id),
  -- La visual que tenía ESE día (puede diferir de animales.vid si después
  -- se recaravaneó). Acá vive el historial de caravanas.
  vid text,
  leido_at timestamptz not null,
  -- Columnas fijas del bastón: la app ya sabe qué son, nunca las pregunta.
  peso_kg numeric,
  ganancia_diaria numeric,
  ganancia_total_diaria numeric,
  -- Todo lo demás que haya traído el CSV: {"GESTACION": "P IATF"}.
  datos jsonb not null default '{}'::jsonb,
  creado_at timestamptz not null default now(),
  -- Un animal aparece una sola vez por sesión.
  unique (sesion_id, animal_id)
);

create index on lecturas_baston (animal_id);
create index on lecturas_baston (sesion_id);

-- ─── El diccionario ─────────────────────────────────────────────────────

-- Qué es cada columna que no trae el bastón de fábrica. `tipo` evita el
-- disparate de preguntar "¿qué significa 3.5?" por cada valor distinto de
-- una columna numérica: solo las de tipo 'codigo' piden traducción.
create table columnas_baston (
  columna text primary key,
  descripcion text not null,
  tipo text not null default 'codigo' check (tipo in ('codigo', 'medida')),
  creado_at timestamptz not null default now()
);

-- Qué quiere decir cada código. `cuenta_como` es lo único que el sistema
-- necesita entender por su cuenta: sin eso puede informar "70 P IATF",
-- pero no "62,5% de preñez".
create table codigos_baston (
  columna text not null references columnas_baston(columna) on delete cascade,
  codigo text not null,
  significado text not null,
  cuenta_como text check (cuenta_como in ('prenada', 'vacia')),
  creado_at timestamptz not null default now(),
  primary key (columna, codigo)
);

-- ─── RLS ────────────────────────────────────────────────────────────────

alter table animales enable row level security;
alter table sesiones_baston enable row level security;
alter table lecturas_baston enable row level security;
alter table columnas_baston enable row level security;
alter table codigos_baston enable row level security;

-- Sube quien carga trabajos (encargado, administrativo, owner). Un puestero
-- no: no tiene acceso a las pantallas de consulta, y esto es análisis.
-- Borra solo el owner, igual que anular un movimiento.

create policy animales_select on animales for select to authenticated using (rol_actual() is not null);
create policy animales_insert on animales for insert to authenticated
  with check (rol_actual() in ('encargado', 'administrativo', 'owner'));
create policy animales_update on animales for update to authenticated
  using (rol_actual() in ('encargado', 'administrativo', 'owner'));

create policy sesiones_baston_select on sesiones_baston for select to authenticated using (rol_actual() is not null);
create policy sesiones_baston_insert on sesiones_baston for insert to authenticated
  with check (rol_actual() in ('encargado', 'administrativo', 'owner') and subido_por = auth.uid());
create policy sesiones_baston_update on sesiones_baston for update to authenticated
  using (rol_actual() in ('encargado', 'administrativo', 'owner'));
-- Borrar una sesión se lleva sus lecturas (on delete cascade), que es
-- justamente lo que hace falta para volver a subir un archivo corregido.
create policy sesiones_baston_delete on sesiones_baston for delete to authenticated
  using (rol_actual() = 'owner');

create policy lecturas_baston_select on lecturas_baston for select to authenticated using (rol_actual() is not null);
create policy lecturas_baston_insert on lecturas_baston for insert to authenticated
  with check (rol_actual() in ('encargado', 'administrativo', 'owner'));
create policy lecturas_baston_delete on lecturas_baston for delete to authenticated
  using (rol_actual() = 'owner');

create policy columnas_baston_select on columnas_baston for select to authenticated using (rol_actual() is not null);
create policy columnas_baston_insert on columnas_baston for insert to authenticated
  with check (rol_actual() in ('encargado', 'administrativo', 'owner'));
create policy columnas_baston_update on columnas_baston for update to authenticated
  using (rol_actual() in ('encargado', 'administrativo', 'owner'));

create policy codigos_baston_select on codigos_baston for select to authenticated using (rol_actual() is not null);
create policy codigos_baston_insert on codigos_baston for insert to authenticated
  with check (rol_actual() in ('encargado', 'administrativo', 'owner'));
create policy codigos_baston_update on codigos_baston for update to authenticated
  using (rol_actual() in ('encargado', 'administrativo', 'owner'));

-- ─── Vista de lectura con los nombres resueltos ─────────────────────────

create view historial_lecturas_baston with (security_invoker = true) as
  select
    l.id, l.sesion_id, s.nombre as sesion, s.fecha, s.establecimiento_id,
    l.animal_id, a.eid, l.vid, l.leido_at,
    l.peso_kg, l.ganancia_diaria, l.ganancia_total_diaria, l.datos
  from lecturas_baston l
  join sesiones_baston s on s.id = l.sesion_id
  join animales a on a.id = l.animal_id
  order by s.fecha desc, l.leido_at asc;
