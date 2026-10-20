-- WhatsApp sign-up requests: the e-mail address is required (the business's login).

-- Text is compared without carriage returns (a script pasted on Windows has CRLF line ends).
create or replace function pg_temp.lf(p text) returns text
language sql immutable as $$ select replace(p, E'\r', '') $$;

do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public.public_signup_request(jsonb)'::regprocedure));
  v_from text := pg_temp.lf($a$  if v_email is not null and (length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then$a$);
  v_to text := pg_temp.lf($b$  if v_email is null then
    raise exception 'VALIDATION: enter your e-mail address' using errcode = '22023';
  end if;
  if v_email is not null and (length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then$b$);
  v_from2 text := $a$'VALIDATION: enter a valid e-mail address, or leave it empty'$a$;
  v_to2 text := $b$'VALIDATION: enter a valid e-mail address'$b$;
begin
  if position('enter your e-mail address' in v_old) > 0 then
    return;
  end if;
  if (length(v_old) - length(replace(v_old, v_from, ''))) / length(v_from) <> 1
     or (length(v_old) - length(replace(v_old, v_from2, ''))) / length(v_from2) <> 1 then
    raise exception 'signup request e-mail: public_signup_request has changed';
  end if;
  execute replace(replace(v_old, v_from, v_to), v_from2, v_to2);
end $$;

select public._tenancy_own_functions();
