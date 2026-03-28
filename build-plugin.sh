#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-build}"

case "$MODE" in
  build|validate|--validate)
    ;;
  *)
    echo "Usage: ./build-plugin.sh [build|validate|--validate]" >&2
    exit 1
    ;;
esac

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: required command not found: $1" >&2
    exit 1
  fi
}

need_cmd python3
need_cmd zip
need_cmd npm
need_cmd node

validate_source_tree() {
python3 <<'PY'
import json
import re
import sys
from pathlib import Path

root = Path(".").resolve()
manifest_path = root / "manifest.json"
package_path = root / "package.json"

errors = []

def add_error(message: str) -> None:
    errors.append(message)

if not manifest_path.exists():
    add_error("manifest.json fehlt")
if not package_path.exists():
    add_error("package.json fehlt")

if errors:
    for error in errors:
        print(f"ERROR: {error}", file=sys.stderr)
    sys.exit(1)

manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
package = json.loads(package_path.read_text(encoding="utf-8"))

manifest_version = str(manifest.get("Version", "")).strip()
package_version = str(package.get("version", "")).strip()
manifest_name = str(manifest.get("Name", "")).strip()
package_name = str(package.get("name", "")).strip()
package_main = str(package.get("main", "")).strip()

if not manifest_name:
    add_error("manifest.json Name fehlt")
if not manifest_version:
    add_error("manifest.json Version fehlt")
if not package_name:
    add_error("package.json name fehlt")
if not package_version:
    add_error("package.json version fehlt")
if manifest_version and package_version and manifest_version != package_version:
    add_error(f"Versionskonflikt: manifest={manifest_version}, package={package_version}")
if not package_main:
    add_error("package.json main fehlt")

dependencies = package.get("dependencies", {})
for dep in ("ws", "systeminformation"):
    if dep not in dependencies:
        add_error(f"package.json dependency fehlt: {dep}")

actions = manifest.get("Actions", [])
if not isinstance(actions, list) or not actions:
    add_error("manifest.json Actions fehlt oder ist leer")

required_paths = set()

def add_required(rel_path: str) -> None:
    rel_path = str(rel_path or "").strip()
    if rel_path:
        required_paths.add(rel_path)

add_required("manifest.json")
add_required("package.json")
add_required(package_main)
add_required(manifest.get("CodePath", ""))
add_required(manifest.get("Icon", ""))
add_required(manifest.get("CategoryIcon", ""))

for action in actions:
    add_required(action.get("Icon", ""))
    add_required(action.get("PropertyInspectorPath", ""))

    for state in action.get("States", []) or []:
        add_required(state.get("Image", ""))

asset_pattern = re.compile(r'''(?:src|href)\s*=\s*["']([^"']+)["']''', re.IGNORECASE)

html_files = [path for path in sorted(required_paths) if path.lower().endswith(".html")]
for rel_path in html_files:
    full_path = root / rel_path
    if not full_path.exists():
        continue

    text = full_path.read_text(encoding="utf-8", errors="ignore")
    for match in asset_pattern.finditer(text):
        ref = match.group(1).strip()
        if (
            not ref
            or ref.startswith(("http://", "https://", "data:", "//", "#", "javascript:", "mailto:"))
        ):
            continue
        add_required((Path(rel_path).parent / ref).as_posix())

missing = [path for path in sorted(required_paths) if not (root / path).exists()]
for path in missing:
    add_error(f"referenzierte Datei fehlt: {path}")

if errors:
    for error in errors:
        print(f"ERROR: {error}", file=sys.stderr)
    sys.exit(1)

print("Source tree validation OK")
PY
}

read_metadata() {
readarray -t BUILD_META < <(
python3 <<'PY'
import json
import re
import sys
from pathlib import Path

manifest = json.loads(Path("manifest.json").read_text(encoding="utf-8"))
package = json.loads(Path("package.json").read_text(encoding="utf-8"))

manifest_version = str(manifest.get("Version", "")).strip()
manifest_name = str(manifest.get("Name", "")).strip()
package_name = str(package.get("name", "")).strip()

slug = manifest_name.lower()
slug = re.sub(r"[^a-z0-9]+", "-", slug).strip("-")

if not manifest_version or not manifest_name or not slug or not package_name:
    print("ERROR: unvollständige Build Metadaten", file=sys.stderr)
    sys.exit(1)

print(manifest_version)
print(manifest_name)
print(slug)
print(package_name)
PY
)

VERSION="${BUILD_META[0]}"
PLUGIN_NAME="${BUILD_META[1]}"
PLUGIN_SLUG="${BUILD_META[2]}"
PACKAGE_NAME="${BUILD_META[3]}"
}

ensure_runtime_deps() {
  local missing=0

  for dep in ws systeminformation; do
    if [[ ! -f "$SCRIPT_DIR/node_modules/$dep/package.json" ]]; then
      missing=1
    fi
  done

  if [[ "$missing" -eq 1 ]]; then
    echo "Installing runtime dependencies with npm ci --omit=dev"
    npm ci --omit=dev
  else
    echo "Runtime dependencies already present"
  fi
}

copy_optional() {
  local src="$1"
  local dst="$2"

  if [[ -e "$src" ]]; then
    cp -a "$src" "$dst"
  fi
}

validate_zip() {
  local zip_path="$1"
  local package_name="$2"

python3 - "$zip_path" "$package_name" <<'PY'
import json
import re
import sys
import zipfile
from pathlib import PurePosixPath

zip_path = sys.argv[1]
package_name = sys.argv[2]

with zipfile.ZipFile(zip_path, "r") as zf:
    names = set(zf.namelist())

    def zip_exists(rel_path: str) -> bool:
        return f"{package_name}/{rel_path}" in names

    def read_json(rel_path: str):
        with zf.open(f"{package_name}/{rel_path}") as fh:
            return json.load(fh)

    def read_text(rel_path: str) -> str:
        with zf.open(f"{package_name}/{rel_path}") as fh:
            return fh.read().decode("utf-8", errors="ignore")

    required_paths = {
        "manifest.json",
        "package.json",
        "index.js",
        "start.sh",
        "node_modules/ws/package.json",
        "node_modules/systeminformation/package.json",
    }

    manifest = read_json("manifest.json")
    package = read_json("package.json")

    def add_required(rel_path: str) -> None:
        rel_path = str(rel_path or "").strip()
        if rel_path:
            required_paths.add(rel_path)

    add_required(package.get("main", ""))
    add_required(manifest.get("CodePath", ""))
    add_required(manifest.get("Icon", ""))
    add_required(manifest.get("CategoryIcon", ""))

    for action in manifest.get("Actions", []) or []:
        add_required(action.get("Icon", ""))
        add_required(action.get("PropertyInspectorPath", ""))
        for state in action.get("States", []) or []:
            add_required(state.get("Image", ""))

    asset_pattern = re.compile(r'''(?:src|href)\s*=\s*["']([^"']+)["']''', re.IGNORECASE)

    html_files = [path for path in sorted(required_paths) if path.lower().endswith(".html")]
    for rel_path in html_files:
        if not zip_exists(rel_path):
            continue
        text = read_text(rel_path)
        for match in asset_pattern.finditer(text):
            ref = match.group(1).strip()
            if (
                not ref
                or ref.startswith(("http://", "https://", "data:", "//", "#", "javascript:", "mailto:"))
            ):
                continue
            add_required((PurePosixPath(rel_path).parent / ref).as_posix())

    missing = [path for path in sorted(required_paths) if not zip_exists(path)]
    if missing:
        for path in missing:
            print(f"ERROR: ZIP Inhalt fehlt: {package_name}/{path}", file=sys.stderr)
        sys.exit(1)

print("ZIP validation OK")
PY
}

validate_source_tree
read_metadata
ensure_runtime_deps

if [[ "$MODE" == "validate" || "$MODE" == "--validate" ]]; then
  echo "Validation finished successfully"
  exit 0
fi

OUT_DIR="$SCRIPT_DIR/dist"
STAGE_DIR="$OUT_DIR/$PACKAGE_NAME"
ZIP_NAME="$PLUGIN_SLUG-v$VERSION.zip"
ZIP_PATH="$OUT_DIR/$ZIP_NAME"

echo "Building $PLUGIN_NAME"
echo "Version: $VERSION"
echo "Package: $PACKAGE_NAME"

rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"

cp manifest.json "$STAGE_DIR/"
cp package.json "$STAGE_DIR/"
cp index.js "$STAGE_DIR/"
cp start.sh "$STAGE_DIR/"

copy_optional package-lock.json "$STAGE_DIR/"
copy_optional LICENSE "$STAGE_DIR/"
copy_optional icons "$STAGE_DIR/"
copy_optional pi "$STAGE_DIR/"
copy_optional assets "$STAGE_DIR/"
copy_optional node_modules "$STAGE_DIR/"

chmod +x "$STAGE_DIR/start.sh"

rm -f "$ZIP_PATH"
(
  cd "$OUT_DIR"
  zip -qr "$ZIP_NAME" "$PACKAGE_NAME"
)

validate_zip "$ZIP_PATH" "$PACKAGE_NAME"

echo "Built: $ZIP_PATH"
