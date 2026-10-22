-- =============================================================================
-- Security audit (run 5), follow-up: store phone patterns.
--
-- The check read a {m,n} quantifier one character at a time, so the digits inside
-- a{0} or \d{0,2} counted as fixed characters and reset the "three open-ended
-- repeats in a row" counter: '^\d*a{0}\d*a{0}\d*a{0}\d*x$' passed. The whole
-- quantifier is now skipped with its atom (the same as nestedQuantifier() in
-- worker/db/pg/builtins.ts). Safe to re-run.
-- =============================================================================

create or replace function public._regex_nested_repetition(p text)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  n int := length(coalesce(p, ''));
  i int := 1;
  e int;
  c text;
  inner_q boolean[] := '{}';
  alt boolean[] := '{}';
  depth int := 0;
  g_inner boolean;
  g_alt boolean;
  q_present boolean;
  q_unbounded boolean;
  q_min numeric;
  q_max numeric;
  q_len int;
  m text[];
  run int := 0;
  variable int := 0;
begin
  while i <= n loop
    c := substr(p, i, 1);
    if c = '(' then
      depth := depth + 1;
      inner_q[depth] := false;
      alt[depth] := false;
      i := i + 1;
      continue;
    end if;
    if c = '|' then
      if depth > 0 then alt[depth] := true; end if;
      i := i + 1;
      continue;
    end if;
    if c in ('*', '+', '?', '{') and (c <> '{' or substr(p, i) ~ '^\{\d*,?\d*\}') then
      i := i + 1; -- read with its atom
      continue;
    end if;
    if c in ('^', '$') then
      run := 0;
      i := i + 1;
      continue;
    end if;
    -- One atom (an escape, a class, a character, or a closing parenthesis), then its quantifier.
    e := i;
    if c = '\' then
      e := i + 1;
    elsif c = '[' then
      e := i + 1;
      if substr(p, e, 1) = '^' then e := e + 1; end if;
      if substr(p, e, 1) = ']' then e := e + 1; end if;
      while e <= n and substr(p, e, 1) <> ']' loop
        e := e + case when substr(p, e, 1) = '\' then 2 else 1 end;
      end loop;
    end if;
    q_present := false;
    q_unbounded := false;
    q_min := null;
    q_max := null;
    q_len := 0;
    c := substr(p, e + 1, 1);
    if c in ('*', '+') then
      q_present := true; q_unbounded := true; q_min := case when c = '+' then 1 else 0 end; q_max := 'Infinity'::numeric; q_len := 1;
    elsif c = '?' then
      q_present := true; q_min := 0; q_max := 1; q_len := 1;
    elsif c = '{' then
      m := regexp_match(substr(p, e + 1), '^\{(\d*)(,?)(\d*)\}');
      if m is not null then
        q_present := true;
        q_len := length(m[1]) + length(m[2]) + length(m[3]) + 2;
        q_min := coalesce(nullif(m[1], ''), '0')::numeric;
        q_unbounded := m[2] = ',' and m[3] = '';
        q_max := case when q_unbounded then 'Infinity'::numeric when m[2] = ',' then m[3]::numeric else q_min end;
      end if;
    end if;
    if substr(p, i, 1) = ')' then
      if depth > 0 then
        g_inner := inner_q[depth];
        g_alt := alt[depth];
        depth := depth - 1;
        if q_present and g_inner and (q_unbounded or q_max > 1) then return true; end if;
        if g_alt and q_unbounded then return true; end if;
        if depth > 0 and (g_inner or q_unbounded) then inner_q[depth] := true; end if;
      end if;
    elsif q_unbounded and depth > 0 then
      inner_q[depth] := true;
    end if;
    -- Repeats in a row: a{0} matches nothing (neither a repeat nor a separator); a variable
    -- repeat counts; only a fixed-width atom (no quantifier, or {n} with n >= 1) separates.
    -- (A closing parenthesis without a quantifier is neither: its inside was counted already.)
    if not (q_present and q_max = 0) and (q_present or substr(p, i, 1) <> ')') then
      if q_present and q_max > q_min then
        variable := variable + 1;
        if variable > 8 then return true; end if;
      end if;
      if q_unbounded then
        run := run + 1;
        if run > 3 then return true; end if;
      elsif not q_present or q_min = q_max then
        run := 0;
      end if;
    end if;
    -- Past the atom and its whole quantifier: the digits of {0,2} are not atoms.
    i := e + 1 + q_len;
  end loop;
  return false;
end;
$$;
