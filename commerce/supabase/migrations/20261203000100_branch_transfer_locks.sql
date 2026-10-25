-- =============================================================================
-- Stock moved between branches at the same moment.
--
-- Found by the round-4 audit (branch-races.test.ts):
--   * A transfer out of the central branch checked what the central branch holds (the store's
--     stock less what the other branches hold) without locking anything. Two managers moving
--     8 of 10 units to two stores at the same moment both passed the check: the stores got 16,
--     and the central branch showed -6.
--   * A transfer of several products locked the source branch's rows in the order the items were
--     listed, so two transfers of the same products in a different order could wait on each other
--     in a circle; Postgres then aborts one ("deadlock detected").
--
-- branch_transfer now locks the rows it takes from first, by variant id (the order every other
-- stock function uses): the store's stock rows for the central branch, the branch's own rows
-- otherwise. The second transfer waits for the first and then sees what it moved.
--
-- branch_transfer is patched in place (CREATE OR REPLACE keeps owner and grants). Safe to re-run.
-- =============================================================================

do $$
declare
  v_old text := replace(pg_get_functiondef('public.branch_transfer(uuid, uuid, jsonb, text, text)'::regprocedure), E'\r', '');
  v_from text := E'  for it in select (e ->> ''variant_id'')::uuid as variant_id, (e ->> ''quantity'')::int as qty from jsonb_array_elements(p_items) e loop';
  v_hits int;
begin
  if position('fixed lock order' in v_old) > 0 then
    return; -- already patched
  end if;
  v_hits := (length(v_old) - length(replace(v_old, v_from, ''))) / length(v_from);
  if v_hits <> 1 then
    raise exception 'branch transfer locks: branch_transfer has changed (% matches)', v_hits;
  end if;
  execute replace(v_old, v_from,
    E'  -- Lock what this transfer takes from, in a fixed lock order (by variant), before checking it:\n'
    || E'  -- a transfer at the same moment waits and then sees what this one moved, and two transfers\n'
    || E'  -- of the same products never wait on each other in a circle.\n'
    || E'  if p_from = v_central then\n'
    || E'    perform 1 from public.inventory\n'
    || E'    where variant_id in (select (e ->> ''variant_id'')::uuid from jsonb_array_elements(p_items) e)\n'
    || E'    order by variant_id\n'
    || E'    for update;\n'
    || E'  else\n'
    || E'    perform 1 from public.branch_stock\n'
    || E'    where branch_id = p_from and variant_id in (select (e ->> ''variant_id'')::uuid from jsonb_array_elements(p_items) e)\n'
    || E'    order by variant_id\n'
    || E'    for update;\n'
    || E'  end if;\n\n'
    || v_from);
end $$;

select public._tenancy_own_functions();
