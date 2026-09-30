-- Defence in depth for hosted Postgres (e.g. Supabase), where tables in the "public" schema
-- are reachable through the auto-generated Data API (PostgREST) with the public "anon" key.
-- Enabling Row Level Security with NO policies denies that API all access, while the app's own
-- database user (the table owner) is unaffected. On plain Postgres this is harmless.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'Customer', 'ChannelUser', 'Conversation', 'Message', 'ProcessedEvent', 'DraftOrder', 'Order',
    'Handoff', 'ToolCallLog', 'Setting', 'KnowledgeEntry', 'AdminUser', 'AuditLog', 'AnalyticsEvent',
    'RateLimit', '_prisma_migrations'
  ]
  LOOP
    IF to_regclass(format('%I', t)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    END IF;
  END LOOP;

  -- Supabase API roles: remove any table privileges they received by default.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon';
    EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated';
    EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM authenticated';
  END IF;
END $$;
