#!/usr/bin/env python3
"""Prepare seven local increments plus an explicitly reviewed optional eighth.

Default: read-only preflight + review plan. Applying never calls migrate deploy,
never resolves unrelated historical migrations and never generates a client.
Each increment's DDL and its Prisma migration receipt commit atomically.
"""
from pathlib import Path
import argparse, hashlib, json, os, re, subprocess, sys, tempfile, urllib.parse, uuid

SERVER = Path(__file__).resolve().parents[1]
MIGRATIONS = (
    '20261012090000_fabric_search_routing',
    '20261012091000_quotation_business_fields',
    '20261012092000_development_physical_versions',
    '20261012093000_development_qc_routing',
    '20261012094000_development_specification',
    '20261012095000_garment_trim_material',
    '20261012100000_trimming_catalog_fields',
)
QC_MEASUREMENTS = '20261012101000_development_qc_measurements'
OLD_TABLES = ('FabricSearchTask', 'Quotation', 'QuotationLine', 'DevelopmentSampleVersion',
              'DevelopmentSampleQualityReview', 'DevelopmentCase', 'TrimmingProfile')
LOCK_SCOPE = ('FabricSearchTask', 'Quotation', 'QuotationLine', 'DevelopmentSampleVersion',
              'DevelopmentSampleQualityReview', 'DevelopmentCase', 'TrimmingProfile',
              'GarmentTrimTask', 'GarmentMaterialUse', '_prisma_migrations')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def connection(path):
    match = re.search(r'^\s*DATABASE_URL\s*=\s*(.+)\s*$', path.read_text(), re.M)
    if not match:
        raise RuntimeError('DATABASE_URL configuration missing; values are never printed')
    try:
        value = urllib.parse.urlparse(match.group(1).strip().strip('\"\''))
        port = value.port or 5432
    except ValueError:
        raise RuntimeError('Invalid local connection configuration') from None
    if value.scheme not in ('postgres', 'postgresql') or value.hostname not in ('localhost', '127.0.0.1', '::1'):
        raise RuntimeError('Refusing non-loopback PostgreSQL target')
    user = urllib.parse.unquote(value.username or '')
    database = urllib.parse.unquote(value.path.lstrip('/'))
    if not user or not database or database in ('postgres', 'template0', 'template1'):
        raise RuntimeError('Refusing missing or administrative target database')
    env = {**os.environ, 'PGPASSWORD': urllib.parse.unquote(value.password or ''), 'PGCONNECT_TIMEOUT': '5'}
    args = ['-h', value.hostname, '-p', str(port), '-U', user, '-d', database]
    fingerprint = digest(json.dumps([value.hostname, port, user, database]).encode())
    return args, env, fingerprint


def run(args, env, output, label, text=None):
    result = subprocess.run(args, env=env, input=text, capture_output=True, text=True)
    for suffix, content in [('stdout', result.stdout), ('stderr', result.stderr)]:
        path = output / f'{label}.{suffix}'
        path.write_text(content)
        path.chmod(0o600)
    if result.returncode:
        raise RuntimeError(f'{label} failed (exit {result.returncode}); stop and retain {output}')
    return result.stdout.strip()


def query(args, env, output, sql, label):
    return run(['psql', '-X', *args, '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', sql], env, output, label)


def history(args, env, output, label):
    return json.loads(query(args, env, output, '''SELECT coalesce(json_agg(json_build_object(
        'id',id,'name',migration_name,'checksum',checksum,'finished_at',finished_at,
        'started_at',started_at,'rolled_back_at',rolled_back_at,'steps',applied_steps_count)
        ORDER BY id),'[]'::json) FROM "_prisma_migrations"''', label))


def old_columns(args, env, output):
    return json.loads(query(args, env, output, '''SELECT json_object_agg(table_name,columns) FROM (
        SELECT table_name,json_agg(column_name ORDER BY ordinal_position) columns
        FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('''
        + ','.join(literal(t) for t in OLD_TABLES) + ') GROUP BY table_name) t', 'old-columns'))


def snapshot(args, env, output, columns, label):
    parts = []
    for table in OLD_TABLES:
        if table not in columns:
            raise RuntimeError(f'Required existing table missing: {table}')
        keep = 'ARRAY[' + ','.join(literal(c) for c in columns[table]) + ']::text[]'
        row = '(SELECT jsonb_object_agg(e.key,e.value) FROM jsonb_each(to_jsonb(t)) e WHERE e.key=ANY(' + keep + '))'
        parts.append(literal(table) + ',(SELECT json_build_object(\'count\',count(*),\'hash\','
                     + 'md5(coalesce(string_agg(' + row
                     + '::text,\',\' ORDER BY id),\'\'))) FROM "' + table + '" t)')
    return json.loads(query(args, env, output, 'SELECT json_build_object(' + ','.join(parts) + ')', label))


def preflight(records, manifests):
    for row in records:
        if row['finished_at'] is None and row['rolled_back_at'] is None:
            raise RuntimeError('Existing unfinished migration requires separate review; no writes performed')
    for item in manifests:
        active = [r for r in records if r['name'] == item['name'] and r['rolled_back_at'] is None]
        if len(active) > 1 or any(r['checksum'] != item['sha256'] or r['finished_at'] is None for r in active):
            raise RuntimeError('Target increment has conflicting migration history: ' + item['name'])


def transaction_script(manifests):
    chunks = ["\\set ON_ERROR_STOP on", "SET lock_timeout='10s';", "SET statement_timeout='120s';",
              "SELECT pg_advisory_lock(hashtextextended('bambook-reviewed-seven-increments-20261012',0));"]
    for item in manifests:
        name, checksum = item['name'], item['sha256']
        body = (SERVER / 'prisma/migrations' / name / 'migration.sql').read_text()
        chunks += ['BEGIN;', "SET LOCAL lock_timeout='10s';", "SET LOCAL statement_timeout='120s';",
                   "DO $$ BEGIN IF EXISTS (SELECT 1 FROM \"_prisma_migrations\" WHERE migration_name=" + literal(name)
                   + " AND rolled_back_at IS NULL AND (finished_at IS NULL OR checksum<>" + literal(checksum)
                   + ")) THEN RAISE EXCEPTION 'Conflicting increment receipt'; END IF; END $$;",
                   'SELECT NOT EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name=' + literal(name)
                   + ' AND rolled_back_at IS NULL AND finished_at IS NOT NULL) AS needs_apply \\gset',
                   '\\if :needs_apply', 'SELECT clock_timestamp() AS increment_started_at \\gset', body,
                   'INSERT INTO "_prisma_migrations" (id,checksum,migration_name,started_at,finished_at,applied_steps_count) VALUES ('
                   + ','.join([literal(str(uuid.uuid4())), literal(checksum), literal(name), ":'increment_started_at'::timestamptz", 'clock_timestamp()', '1']) + ');',
                   '\\endif', 'COMMIT;']
    chunks += ["SELECT pg_advisory_unlock(hashtextextended('bambook-reviewed-seven-increments-20261012',0));"]
    return '\n'.join(chunks) + '\n'


def postconditions(args, env, output):
    expected_indexes = ('DevelopmentSampleVersion_physical_minor_key', 'DevelopmentSampleVersion_legacy_minor_key',
                        'FabricSearchTask_routingTeamId_status_idx', 'DevelopmentSampleQualityReview_routingTeamId_status_idx')
    indexes = json.loads(query(args, env, output, '''SELECT coalesce(json_object_agg(indexname,indexdef),'{}'::json)
        FROM pg_indexes WHERE schemaname='public' AND indexname IN ('''
        + ','.join(literal(n) for n in expected_indexes) + ')', 'post-index-contract'))
    if set(indexes) != set(expected_indexes) or 'WHERE ("physicalSequence" IS NULL)' not in indexes['DevelopmentSampleVersion_legacy_minor_key']:
        raise RuntimeError('Required physical/routing index contract failed after commit; retain backup')
    old_index_count = query(args, env, output, '''SELECT count(*) FROM pg_indexes WHERE schemaname='public'
        AND indexname='DevelopmentSampleVersion_roundId_supplierRelationId_minorVe_key' ''', 'post-old-index-absence')
    if old_index_count != '0':
        raise RuntimeError('Old physical-identity index remains; retain backup')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env-file', type=Path, default=SERVER / '.env.local')
    parser.add_argument('--include-reviewed-qc-measurements', action='store_true', help='Explicitly include reviewed eighth nullable measurement increment in plan/apply')
    parser.add_argument('--plan', type=Path, help='Required reviewed plan when applying')
    parser.add_argument('--apply-reviewed-seven', '--apply-reviewed-increments', dest='apply_reviewed_seven', action='store_true')
    parser.add_argument('--confirm-app-writes-paused', action='store_true')
    opts = parser.parse_args()
    os.umask(0o077)
    output = Path(tempfile.mkdtemp(prefix='bambook-reviewed-incrementals-'))
    args, env, target = connection(opts.env_file)
    selected = MIGRATIONS + ((QC_MEASUREMENTS,) if opts.include_reviewed_qc_measurements else ())
    manifests = [{'name': name, 'sha256': digest((SERVER / 'prisma/migrations' / name / 'migration.sql').read_bytes())} for name in selected]
    current_plan = {'migration_names': list(selected), 'include_reviewed_qc_measurements': opts.include_reviewed_qc_measurements, 'migrations': manifests, 'schema_sha256': digest((SERVER / 'prisma/schema.prisma').read_bytes()),
                    'local_target_fingerprint': target, 'ddl_lock_scope': list(LOCK_SCOPE), 'lock_timeout_seconds': 10,
                    'statement_timeout_seconds': 120, 'application_writes_must_be_paused': True}
    records = history(args, env, output, 'history-before')
    preflight(records, manifests)
    (output / 'plan.json').write_text(json.dumps(current_plan, indent=2))
    if not opts.apply_reviewed_seven:
        print(json.dumps({'mode': 'read_only_plan', 'plan': str(output / 'plan.json'), 'applied': False, 'increments': len(manifests)}))
        return
    if not opts.plan or not opts.confirm_app_writes_paused:
        raise RuntimeError('Apply requires a reviewed --plan and explicit --confirm-app-writes-paused')
    if json.loads(opts.plan.read_text()) != current_plan:
        raise RuntimeError('Reviewed plan differs from current files/target; prepare and review a fresh plan')
    columns = old_columns(args, env, output)
    before = snapshot(args, env, output, columns, 'old-data-before')
    backup = output / 'before-increments.dump'
    run(['pg_dump', *args, '-Fc', '--no-owner', '--no-privileges', '--lock-wait-timeout=10s', '-f', str(backup)], env, output, 'backup')
    backup.chmod(0o600)
    run(['pg_restore', '--list', str(backup)], env, output, 'backup-list-validation')
    if before != snapshot(args, env, output, columns, 'old-data-after-backup'):
        raise RuntimeError('Source changed during backup; no increment applied. Pause writers and review')
    sql = transaction_script(manifests)
    (output / 'reviewed-seven-transactions.sql').write_text(sql)
    run(['psql', '-X', *args, '-v', 'ON_ERROR_STOP=1'], env, output, 'apply-reviewed-seven', text=sql)
    after = snapshot(args, env, output, columns, 'old-data-after')
    if before != after:
        raise RuntimeError('Old data summary differs after commit; stop, preserve backup, investigate writers')
    final = history(args, env, output, 'history-after')
    preflight(final, manifests)
    for item in manifests:
        if not any(r['name'] == item['name'] and r['checksum'] == item['sha256'] and r['finished_at'] is not None and r['rolled_back_at'] is None for r in final):
            raise RuntimeError('Increment receipt missing after commit; retain backup')
    untouched = lambda rows: [r for r in rows if r['name'] not in selected]
    if untouched(records) != untouched(final):
        raise RuntimeError('Unrelated migration history changed; retain backup and investigate')
    postconditions(args, env, output)
    if opts.include_reviewed_qc_measurements:
        measurement = query(args, env, output, "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='DevelopmentSampleQualityReview' AND column_name='measurements' AND data_type='jsonb' AND is_nullable='YES'", 'post-measurements-contract')
        if measurement != '1':
            raise RuntimeError('Nullable measurements contract failed; retain backup')
    (output / 'result.json').write_text(json.dumps({'success': True, 'old_data_unchanged': True, 'unrelated_history_unchanged': True,
                                                 'backup_retained': str(backup), 'increments': len(manifests)}, indent=2))
    print(json.dumps({'success': True, 'evidence': str(output), 'backup_retained': True}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Stopped: ' + str(error), file=sys.stderr)
        sys.exit(1)
