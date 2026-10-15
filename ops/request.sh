set -euo pipefail
echo install-receiver-1
tmp=$(mktemp)
cat > "$tmp" <<'BAMBOOK_RECV_EOF'
#!/usr/bin/python3
"""Installed root-owned; SSH key is forced to this narrow development receiver."""
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path('/srv/bambook-dev')
LIMIT = 64 * 1024 * 1024
EXPANDED_LIMIT = 512 * 1024 * 1024
# Time budget (keep in sync with bambook-dev-deploy.yml): release script <= ACTIVATE_TIMEOUT
# < ssh `timeout` on the runner < delivery job timeout-minutes.
ACTIVATE_TIMEOUT = 2100
KILL_GRACE = 30
# Written by bambook-dev-release.sh right before it switches `current`; removed once the
# switch is healthy or rolled back. Present after a kill = interrupted switch to undo here.
MARKER = ROOT / '.activation.json'
SERVICES = ('bambook-dev.service', 'bambook-dev-mist.service')
REQUIRED = {'.nvmrc', 'server/package.json', 'server/package-lock.json', 'server/src/index.ts', 'server/src/mist/standalone.ts', 'scripts/deploy/bambook-dev-release.sh', 'web/index.html'}

def validate_members(members):
    seen, total = set(), 0
    for member in members:
        path = PurePosixPath(member.name)
        name = str(path)
        if path.is_absolute() or '..' in path.parts or name in seen:
            raise ValueError('unsafe or duplicate archive path')
        allowed = path.parts and path.parts[0] in ('server', 'web') or name in {
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

def recover_interrupted(reason):
    """Undo a half-finished switch: point `current` back to the recorded previous release."""
    if not MARKER.is_file():
        return
    state = json.loads(MARKER.read_text())
    previous = state.get('previous') or ''
    current = ROOT / 'current'
    if previous and re.fullmatch(str(ROOT / 'releases') + r'/[0-9a-f]{40}', previous) and Path(previous).is_dir():
        staging = ROOT / '.current-recover'
        if staging.is_symlink() or staging.exists():
            staging.unlink()
        staging.symlink_to(previous)
        os.replace(staging, current)
        restored = previous
    else:
        if current.is_symlink():
            current.unlink()
        restored = None
    for unit in SERVICES:
        subprocess.run(['sudo', '-n', '/usr/bin/systemctl', 'restart' if restored else 'stop', unit], check=False, timeout=120)
    MARKER.unlink()
    print(f'Recovered ({reason}): current -> {restored or "none"}', file=sys.stderr)

def activate(release):
    # Own process group, so a timeout stops npm / prisma / tsc grandchildren too, not just bash.
    child = subprocess.Popen(['/bin/bash', str(release / 'scripts/deploy/bambook-dev-release.sh'), str(release)], start_new_session=True)
    try:
        code = child.wait(timeout=ACTIVATE_TIMEOUT)
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGTERM)
        try:
            child.wait(timeout=KILL_GRACE)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
        recover_interrupted('activation timed out')
        raise ValueError(f'activation exceeded {ACTIVATE_TIMEOUT}s and was stopped; the previous release stays active')
    if code != 0:
        recover_interrupted('release script failed')
        raise ValueError(f'release script exited with {code}')

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
            recover_interrupted('a previous activation was interrupted')
            activate(release)

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Development delivery failed: ' + str(error), file=sys.stderr)
        sys.exit(1)
BAMBOOK_RECV_EOF
python3 -c "import ast,sys;ast.parse(open(sys.argv[1]).read())" "$tmp"
sudo cp -a /usr/local/libexec/bambook-dev-receiver.py /usr/local/libexec/bambook-dev-receiver.py.bak-$(date +%Y%m%d%H%M%S)
sudo install -m 0755 -o root -g root "$tmp" /usr/local/libexec/bambook-dev-receiver.py
rm -f "$tmp"
sha256sum /usr/local/libexec/bambook-dev-receiver.py
grep -n 'ACTIVATE_TIMEOUT =' /usr/local/libexec/bambook-dev-receiver.py
sudo -u bambook-deploy env SSH_ORIGINAL_COMMAND=check /usr/bin/python3 /usr/local/libexec/bambook-dev-receiver.py
ls -la /srv/bambook-dev/.activation.json 2>/dev/null || echo no-marker
readlink -f /srv/bambook-dev/current
