#!/usr/bin/python3
"""Installed root-owned; SSH key is forced to this narrow development receiver."""
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path('/srv/bambook-dev')
LIMIT = 64 * 1024 * 1024
EXPANDED_LIMIT = 512 * 1024 * 1024
REQUIRED = {'.nvmrc', 'server/package.json', 'server/package-lock.json', 'server/src/mist/standalone.ts', 'scripts/deploy/bambook-dev-release.sh'}

def validate_members(members):
    seen, total = set(), 0
    for member in members:
        path = PurePosixPath(member.name)
        name = str(path)
        if path.is_absolute() or '..' in path.parts or name in seen:
            raise ValueError('unsafe or duplicate archive path')
        allowed = path.parts and path.parts[0] == 'server' or name in {
            '.nvmrc', 'scripts', 'scripts/deploy', 'scripts/deploy/bambook-dev-release.sh'}
        if not allowed or not (member.isdir() or member.isfile()):
            raise ValueError('unsupported archive entry')
        total += member.size
        if total > EXPANDED_LIMIT or len(seen) >= 15000:
            raise ValueError('archive exceeds expansion limits')
        seen.add(name)
    if not REQUIRED.issubset(seen):
        raise ValueError('incomplete backend bundle')

def receive(sha):
    releases = ROOT / 'releases'
    releases.mkdir(exist_ok=True)
    target = releases / sha
    with tempfile.TemporaryDirectory(prefix='.incoming-', dir=ROOT) as temp:
        temp = Path(temp)
        archive = temp / 'bundle.tar.gz'
        total = 0
        digest = hashlib.sha256()
        with archive.open('wb') as output:
            while True:
                chunk = sys.stdin.buffer.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > LIMIT:
                    raise ValueError('bundle exceeds upload limit')
                digest.update(chunk)
                output.write(chunk)
        fingerprint = digest.hexdigest()
        if target.exists():
            receipt = json.loads((target / '.delivery.json').read_text())
            if receipt['sha256'] != fingerprint:
                raise ValueError('revision already received with different bytes')
            print(json.dumps({'received': sha, 'replayed': True}))
            return
        unpacked = temp / 'release'
        unpacked.mkdir()
        with tarfile.open(archive, 'r:gz') as bundle:
            members = bundle.getmembers()
            validate_members(members)
            for member in members:
                output = unpacked / member.name
                if member.isdir():
                    output.mkdir(parents=True, exist_ok=True)
                else:
                    output.parent.mkdir(parents=True, exist_ok=True)
                    with bundle.extractfile(member) as source, output.open('xb') as dest:
                        shutil.copyfileobj(source, dest)
                    output.chmod(0o644)
        (unpacked / '.delivery.json').write_text(json.dumps({'revision': sha, 'sha256': fingerprint}))
        unpacked.rename(target)
        print(json.dumps({'received': sha, 'sha256': fingerprint}))

def main():
    command = os.environ.get('SSH_ORIGINAL_COMMAND', '')
    if command == 'check':
        if not ROOT.is_dir() or not os.access(ROOT, os.W_OK):
            raise ValueError('delivery directory unavailable')
        print(json.dumps({'channel': 'ready', 'scope': 'Bambook development only', 'directory': str(ROOT)}))
        return
    match = re.fullmatch(r'(receive|activate) ([0-9a-f]{40})', command)
    if not match:
        raise ValueError('only check, receive revision, or activate revision are allowed')
    action, sha = match.groups()
    with (ROOT / '.delivery.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if action == 'receive':
            receive(sha)
        else:
            release = ROOT / 'releases' / sha
            if not (release / '.delivery.json').is_file():
                raise ValueError('revision was not received')
            subprocess.run(['/bin/bash', str(release / 'scripts/deploy/bambook-dev-release.sh'), str(release)], check=True, timeout=900)

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Development delivery failed: ' + str(error), file=sys.stderr)
        sys.exit(1)
