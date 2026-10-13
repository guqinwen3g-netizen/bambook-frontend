#!/usr/bin/env python3
"""Freeze a schema and prepare a private client/typecheck/build; never install it.

Default only prepares. Explicit --run-isolated generates into the private output
and maps TypeScript @prisma/client to it. No database is connected or migrated.
Root must apply every schema increment before installing any resulting client.
"""
from pathlib import Path
import argparse, hashlib, json, os, re, shutil, subprocess, sys, tempfile
SERVER = Path(__file__).resolve().parents[1]


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--schema-file', type=Path, default=SERVER / 'prisma/schema.prisma')
    parser.add_argument('--run-isolated', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    output = Path(tempfile.mkdtemp(prefix='bambook-isolated-client-build-'))
    frozen = output / 'schema.prisma'
    frozen.write_bytes(args.schema_file.read_bytes())
    original_hash = sha(frozen)
    client = output / 'client'
    source = frozen.read_text()
    source, count = re.subn(r'generator client\s*\{[^}]*\}',
                           'generator client {\n  provider = "prisma-client-js"\n  output = ' + json.dumps(str(client)) + '\n}', source, count=1)
    if count != 1:
        raise RuntimeError('Expected exactly one client generator block')
    frozen.write_text(source)
    config = output / 'tsconfig.json'
    config.write_text(json.dumps({'extends': str(SERVER / 'tsconfig.json'), 'compilerOptions': {
        'baseUrl': str(SERVER), 'paths': {'@prisma/client': [str(client)]},
        'outDir': str(output / 'server-dist'), 'rootDir': str(SERVER / 'src'), 'incremental': False,
    }}, indent=2))
    guarded = [SERVER / 'node_modules/.prisma/client/schema.prisma', SERVER / 'node_modules/.prisma/client/index.js',
               SERVER / 'node_modules/.prisma/client/index.d.ts', SERVER / 'node_modules/@prisma/client/index.js',
               SERVER / 'node_modules/@prisma/client/index.d.ts']
    baseline = {str(p.resolve()): sha(p) for p in guarded}
    plan = {'input_schema_sha256': original_hash, 'private_schema': str(frozen), 'private_client_output': str(client),
            'temporary_tsconfig': str(config), 'private_build_output': str(output / 'server-dist'),
            'database_connected': False, 'shared_client_install': False,
            'install_condition': 'Root must first apply every migration required by the final schema; seven increments alone cannot support later measurements.'}
    (output / 'plan.json').write_text(json.dumps(plan, indent=2))
    if not args.run_isolated:
        print(json.dumps({'mode': 'prepare_only', 'plan': str(output / 'plan.json'), 'generated': False}))
        return
    cli = SERVER / 'node_modules/prisma/build/index.js'
    compiler = SERVER.parent / 'node_modules/typescript/bin/tsc'
    if not cli.exists() or not compiler.exists():
        raise RuntimeError('Installed Prisma/TypeScript runtime missing; do not auto-install')
    # Prisma resolves its generator package from the frozen schema directory.
    # Only private symlinks are added; generation output remains private.
    private_packages = output / 'node_modules/@prisma'
    private_packages.mkdir(parents=True)
    (private_packages / 'client').symlink_to((SERVER / 'node_modules/@prisma/client').resolve(), target_is_directory=True)
    env = {**os.environ, 'DATABASE_URL': 'postgresql://unused:unused@127.0.0.1:5432/schema_generation_only',
           'PRISMA_GENERATE_SKIP_AUTOINSTALL': '1', 'PRISMA_SKIP_POSTINSTALL_GENERATE': '1'}
    commands = [('generate', [shutil.which('node') or 'node', str(cli), 'generate', '--schema', str(frozen)]),
                ('typecheck', [shutil.which('node') or 'node', str(compiler), '--noEmit', '--project', str(config)]),
                ('build', [shutil.which('node') or 'node', str(compiler), '--project', str(config)])]
    for name, command in commands:
        result = subprocess.run(command, cwd=SERVER, env=env, text=True, capture_output=True)
        (output / f'{name}.stdout').write_text(result.stdout)
        (output / f'{name}.stderr').write_text(result.stderr)
        if result.returncode:
            raise RuntimeError(f'{name} failed exit={result.returncode}; evidence={output}')
    if baseline != {str(p.resolve()): sha(p) for p in guarded}:
        raise RuntimeError('Shared client changed unexpectedly; stop and inspect before any install')
    plan.update({'generated': True, 'typecheck': 'passed', 'build': 'passed', 'shared_client_unchanged': True})
    (output / 'result.json').write_text(json.dumps(plan, indent=2))
    print(json.dumps({'success': True, 'evidence': str(output), 'shared_client_unchanged': True}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Stopped: ' + str(error), file=sys.stderr)
        sys.exit(1)
