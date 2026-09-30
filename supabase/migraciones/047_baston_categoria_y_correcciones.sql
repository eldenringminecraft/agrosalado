-- 047 · Bastón: la categoría del animal en cada sesión, y poder corregir
-- a mano lo que el archivo no trajo.
--
-- POR QUÉ
--
-- 1) El bastón no sabe qué es el animal que está leyendo. En una misma
--    jornada se encierran vacas, vaquillonas y terneros al pie juntos, y
--    el CSV no distingue: son todos EIDs. La categoría es un dato que se
--    sabe en el momento (o después, mirando los pesos) y que se carga a
--    mano, en general de a grupos. Va POR LECTURA y no por animal: una
--    ternera este año es una vaquillona el que viene, y lo que importa es
--    qué era en cada paso por la manga.
--
-- 2) El archivo llega incompleto todo el tiempo por razones de campo: no
--    había balanza, el operario no alcanzó a pesar, la lectura salió en
--    cero. Hasta acá una lectura era intocable una vez subida; ahora se
--    puede corregir el peso y cargar la categoría sin tener que borrar la
--    sesión entera y volver a subirla.
--
-- No borra ni cambia nada de lo que ya está guardado.

-- ─── La categoría de cada lectura ───────────────────────────────────────

alter table lecturas_baston
  add column if not exists categoria_id text references categorias(id);

comment on column lecturas_baston.categoria_id is
  'Qué era el animal en ESA sesión. Se carga a mano (el bastón no lo sabe), en general de a grupos desde la planilla de Datos. Nullable: puede no saberse.';

create index if not exists lecturas_baston_categoria_idx on lecturas_baston (categoria_id);

-- ─── Poder corregir una lectura ─────────────────────────────────────────

-- Hasta acá lecturas_baston solo tenía select/insert/delete: una lectura
-- mal cargada obligaba a borrar la sesión entera. Corrige quien sube
-- sesiones (encargado, administrativo, owner); borrar sigue siendo solo
-- del owner.
drop policy if exists lecturas_baston_update on lecturas_baston;
create policy lecturas_baston_update on lecturas_baston for update to authenticated
  using (rol_actual() in ('encargado', 'administrativo', 'owner'));

-- ─── La vista, con la categoría ─────────────────────────────────────────

drop view if exists historial_lecturas_baston;
create view historial_lecturas_baston with (security_invoker = true) as
  select
    l.id, l.sesion_id, s.nombre as sesion, s.fecha, s.establecimiento_id,
    l.animal_id, a.eid, l.vid, l.leido_at,
    l.categoria_id, c.nombre as categoria_nombre,
    l.peso_kg, l.ganancia_diaria, l.ganancia_total_diaria, l.datos
  from lecturas_baston l
  join sesiones_baston s on s.id = l.sesion_id
  join animales a on a.id = l.animal_id
  left join categorias c on c.id = l.categoria_id
  order by s.fecha desc, l.leido_at asc;
