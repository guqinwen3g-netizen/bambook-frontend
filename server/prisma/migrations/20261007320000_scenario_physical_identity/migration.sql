-- Dev-only physical anchor. No tables, rows or role memberships are changed.
-- The actual application/migration role is intentionally not privileged enough
-- to install this helper. A trusted existing cluster administrator first runs
-- this exact file in the independently verified panda_hub_dev instance; the
-- normal application-role migration then re-runs and asserts the installed
-- definition, owner and ACLs. A missing/unsafe helper never silently passes.
-- Other databases have no helper/schema/ACL side effects.
DO $migration$
DECLARE
  application_owner oid;
  application_is_super boolean;
  installer_is_super boolean;
  protected_schema record;
  protected_function record;
  observed_fingerprint text;
  expected_body CONSTANT text := $function$
    SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.current_setting('data_directory') OPERATOR(pg_catalog.||) ':' OPERATOR(pg_catalog.||)
        (SELECT system_identifier::pg_catalog.text FROM pg_catalog.pg_control_system()),
      'UTF8')), 'hex')
    WHERE pg_catalog.current_database() = 'panda_hub_dev'
  $function$;
BEGIN
  IF pg_catalog.current_database() <> 'panda_hub_dev' THEN
    RETURN;
  END IF;

  SELECT datdba INTO STRICT application_owner FROM pg_catalog.pg_database
    WHERE datname = pg_catalog.current_database();
  SELECT rolsuper INTO STRICT application_is_super FROM pg_catalog.pg_roles WHERE oid = application_owner;
  SELECT rolsuper INTO STRICT installer_is_super FROM pg_catalog.pg_roles WHERE rolname = CURRENT_USER;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'bambook_runtime_identity') THEN
    IF NOT installer_is_super THEN
      RAISE EXCEPTION 'SCENARIO_PHYSICAL_IDENTITY_ADMIN_INSTALL_REQUIRED' USING ERRCODE = '42501';
    END IF;
    EXECUTE 'CREATE SCHEMA bambook_runtime_identity AUTHORIZATION CURRENT_USER';
    EXECUTE pg_catalog.format(
      'CREATE FUNCTION bambook_runtime_identity.physical_fingerprint() RETURNS pg_catalog.text '
      'LANGUAGE sql STABLE PARALLEL RESTRICTED SECURITY DEFINER SET search_path = pg_catalog AS %L', expected_body);
    EXECUTE 'REVOKE ALL ON SCHEMA bambook_runtime_identity FROM PUBLIC';
    EXECUTE 'REVOKE ALL ON FUNCTION bambook_runtime_identity.physical_fingerprint() FROM PUBLIC';
    EXECUTE pg_catalog.format('GRANT USAGE ON SCHEMA bambook_runtime_identity TO %I', pg_catalog.pg_get_userbyid(application_owner));
    EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION bambook_runtime_identity.physical_fingerprint() TO %I', pg_catalog.pg_get_userbyid(application_owner));
  END IF;

  SELECT n.oid, n.nspowner, n.nspacl, r.rolsuper INTO protected_schema
    FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_roles r ON r.oid = n.nspowner
    WHERE n.nspname = 'bambook_runtime_identity';
  SELECT p.*, r.rolsuper AS owner_is_super INTO protected_function
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
    WHERE p.pronamespace = protected_schema.oid AND p.proname = 'physical_fingerprint' AND p.pronargs = 0;

  IF protected_schema.oid IS NULL OR protected_schema.rolsuper IS DISTINCT FROM true
    OR protected_function.oid IS NULL OR protected_function.owner_is_super IS DISTINCT FROM true
    OR protected_function.proowner IS DISTINCT FROM protected_schema.nspowner
    OR protected_function.prokind <> 'f' OR protected_function.prosecdef IS DISTINCT FROM true
    OR protected_function.proretset IS DISTINCT FROM false
    OR protected_function.prorettype <> 'pg_catalog.text'::pg_catalog.regtype
    OR protected_function.prolang <> (SELECT oid FROM pg_catalog.pg_language WHERE lanname = 'sql')
    OR protected_function.provolatile <> 's' OR protected_function.proparallel <> 'r'
    OR protected_function.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']::pg_catalog.text[]
    OR protected_function.prosrc IS DISTINCT FROM expected_body
    OR protected_function.probin IS NOT NULL OR protected_function.proallargtypes IS NOT NULL
    OR NOT pg_catalog.has_schema_privilege(application_owner, protected_schema.oid, 'USAGE')
    OR NOT pg_catalog.has_function_privilege(application_owner, protected_function.oid, 'EXECUTE')
    OR (NOT application_is_super AND pg_catalog.has_schema_privilege(application_owner, protected_schema.oid, 'CREATE'))
    OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(protected_schema.nspacl, pg_catalog.acldefault('n', protected_schema.nspowner)))
      WHERE grantee NOT IN (protected_schema.nspowner, application_owner)
        OR (grantee = application_owner AND application_owner <> protected_schema.nspowner AND (privilege_type <> 'USAGE' OR is_grantable)))
    OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(protected_function.proacl, pg_catalog.acldefault('f', protected_function.proowner)))
      WHERE grantee NOT IN (protected_function.proowner, application_owner)
        OR (grantee = application_owner AND application_owner <> protected_function.proowner AND (privilege_type <> 'EXECUTE' OR is_grantable)))
  THEN
    RAISE EXCEPTION 'SCENARIO_PHYSICAL_IDENTITY_INSTALLATION_INVALID' USING ERRCODE = '42501';
  END IF;

  EXECUTE 'SELECT bambook_runtime_identity.physical_fingerprint()' INTO observed_fingerprint;
  IF observed_fingerprint IS NULL OR observed_fingerprint !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'SCENARIO_PHYSICAL_IDENTITY_HASH_UNAVAILABLE' USING ERRCODE = '42501';
  END IF;
END;
$migration$;
