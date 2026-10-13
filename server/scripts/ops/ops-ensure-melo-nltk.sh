#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_common.sh"
load_env

MELO_VENV="${BAMBOOK_MELO_VENV:-$SERVER_ROOT/.venv-melo}"
MELO_PYTHON="${BAMBOOK_MELO_PYTHON:-$MELO_VENV/bin/python}"
BUNDLED_NLTK_DATA="$SCRIPT_DIR/assets/nltk_data"

if [[ ! -x "$MELO_PYTHON" ]]; then
  echo "Melo python not found: $MELO_PYTHON" >&2
  exit 1
fi

if [[ -d "$BUNDLED_NLTK_DATA" ]]; then
  log "Installing bundled NLTK resources from $BUNDLED_NLTK_DATA"
  mkdir -p "$HOME/nltk_data"
  rsync -a "$BUNDLED_NLTK_DATA"/ "$HOME/nltk_data"/
fi

"$MELO_PYTHON" <<'PY'
from pathlib import Path
import os
import shutil
import sys
import tempfile
import urllib.request
import zipfile

import nltk

download_dir = Path.home() / "nltk_data"
download_dir.mkdir(parents=True, exist_ok=True)

packages = [
    ("corpora/cmudict.zip", "cmudict", "corpora"),
    ("taggers/averaged_perceptron_tagger.zip", "averaged_perceptron_tagger", "taggers"),
    ("taggers/averaged_perceptron_tagger_eng", "averaged_perceptron_tagger_eng", "taggers"),
]


def exists(resource_path: str) -> bool:
    try:
        nltk.data.find(resource_path)
        return True
    except LookupError:
        return False
    except Exception as error:
        zip_path = download_dir / f"{resource_path}.zip"
        if zip_path.exists():
            print(f"removing corrupt NLTK zip {zip_path}: {error}", flush=True)
            zip_path.unlink()
        else:
            print(f"NLTK lookup failed for {resource_path}: {error}", flush=True)
        return False


def direct_download(package_name: str, category: str) -> None:
    url = f"https://raw.githubusercontent.com/nltk/nltk_data/gh-pages/packages/{category}/{package_name}.zip"
    target_parent = download_dir / category
    target_parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as temp_dir:
        zip_path = Path(temp_dir) / f"{package_name}.zip"
        print(f"direct download {package_name} from {url}", flush=True)
        urllib.request.urlretrieve(url, zip_path)
        with zipfile.ZipFile(zip_path) as archive:
            archive.extractall(target_parent)

    nested = target_parent / package_name / package_name
    if nested.exists():
        final = target_parent / package_name
        backup = target_parent / f"{package_name}.nested"
        if backup.exists():
            shutil.rmtree(backup)
        final.rename(backup)
        nested.rename(final)
        shutil.rmtree(backup)


failed = []
for resource_path, package_name, category in packages:
    if exists(resource_path):
        print(f"ok {package_name}", flush=True)
        continue

    print(f"missing {package_name}; trying nltk downloader", flush=True)
    downloaded = nltk.download(package_name, download_dir=str(download_dir), quiet=False)
    if not downloaded or not exists(resource_path):
        try:
            direct_download(package_name, category)
        except Exception as error:
            print(f"direct download failed for {package_name}: {error}", flush=True)

    if exists(resource_path):
        print(f"ok {package_name}", flush=True)
    else:
        failed.append(package_name)
        print(f"failed {package_name}", flush=True)

if failed:
    print(f"missing resources after download: {', '.join(failed)}", file=sys.stderr)
    sys.exit(1)

print(f"NLTK_DATA={download_dir}", flush=True)
PY
