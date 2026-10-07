#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
config_root="${XDG_CONFIG_HOME:-${HOME}/.config}/local-lecture-copilot"
data_root="${XDG_DATA_HOME:-${HOME}/.local/share}/local-lecture-copilot/windows-vm"
config_file=""
mode="Full"
skip_installer=0
start_vm=1
prepare_key=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)
      mode="${2:-}"
      shift 2
      ;;
    --skip-installer)
      skip_installer=1
      shift
      ;;
    --no-start)
      start_vm=0
      shift
      ;;
    --prepare-key)
      prepare_key=1
      shift
      ;;
    --config)
      config_file="${2:-}"
      shift 2
      ;;
    -h|--help)
      echo "Usage: scripts/run-windows-validation.sh [--prepare-key] [--mode Quick|Full] [--skip-installer] [--no-start] [--config FILE]"
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [[ "$mode" != "Quick" && "$mode" != "Full" ]]; then
  echo "--mode must be Quick or Full" >&2
  exit 2
fi

if [[ -z "$config_file" ]]; then
  config_file="$config_root/windows-vm.env"
  if [[ ! -f "$config_file" && -f "$repo_root/.windows-vm.env" ]]; then
    config_file="$repo_root/.windows-vm.env"
  fi
fi
if [[ -f "$config_file" ]]; then
  set -a
  # This is a user-owned, ignored configuration file. Do not put passwords or tokens in it.
  # shellcheck disable=SC1090
  source "$config_file"
  set +a
fi

WINDOWS_VM_PORT="${WINDOWS_VM_PORT:-22}"
WINDOWS_VM_BOOT_TIMEOUT="${WINDOWS_VM_BOOT_TIMEOUT:-180}"
WINDOWS_VM_IDENTITY_FILE="${WINDOWS_VM_IDENTITY_FILE:-$data_root/id_ed25519}"

artifact_root="$repo_root/debug-artifacts/windows"
ssh_root="$data_root/ssh"
mkdir -p "$ssh_root"
if [[ ! -f "$WINDOWS_VM_IDENTITY_FILE" ]]; then
  mkdir -p "$(dirname "$WINDOWS_VM_IDENTITY_FILE")"
  ssh-keygen -q -t ed25519 -N '' -C 'local-lecture-copilot-windows-vm' -f "$WINDOWS_VM_IDENTITY_FILE"
  echo "Created a dedicated VM key: $WINDOWS_VM_IDENTITY_FILE.pub"
fi
if [[ $prepare_key -eq 1 ]]; then
  echo "Public key for Windows setup:"
  cat "$WINDOWS_VM_IDENTITY_FILE.pub"
  exit 0
fi

: "${WINDOWS_VM_HOST:?Set WINDOWS_VM_HOST in $config_file or the environment}"
: "${WINDOWS_VM_USER:?Set WINDOWS_VM_USER in $config_file or the environment}"

utmctl=""
if command -v utmctl >/dev/null 2>&1; then
  utmctl="$(command -v utmctl)"
elif [[ -x /Applications/UTM.app/Contents/MacOS/utmctl ]]; then
  utmctl=/Applications/UTM.app/Contents/MacOS/utmctl
fi
if [[ $start_vm -eq 1 && -n "${WINDOWS_VM_NAME:-}" && -n "$utmctl" ]]; then
  "$utmctl" start "$WINDOWS_VM_NAME" >/dev/null 2>&1 || true
fi

target="$WINDOWS_VM_USER@$WINDOWS_VM_HOST"
ssh_options=(
  -p "$WINDOWS_VM_PORT"
  -i "$WINDOWS_VM_IDENTITY_FILE"
  -o BatchMode=yes
  -o ConnectTimeout=5
  -o StrictHostKeyChecking=accept-new
  -o "UserKnownHostsFile=$ssh_root/known_hosts"
)
scp_options=(
  -P "$WINDOWS_VM_PORT"
  -i "$WINDOWS_VM_IDENTITY_FILE"
  -o BatchMode=yes
  -o ConnectTimeout=5
  -o StrictHostKeyChecking=accept-new
  -o "UserKnownHostsFile=$ssh_root/known_hosts"
)

deadline=$((SECONDS + WINDOWS_VM_BOOT_TIMEOUT))
while ! ssh "${ssh_options[@]}" "$target" 'Write-Output ready' >/dev/null 2>&1; do
  if (( SECONDS >= deadline )); then
    public_key="$(<"$WINDOWS_VM_IDENTITY_FILE.pub")"
    echo "Could not reach the Windows VM over key-based SSH." >&2
    echo "Inside an elevated VM PowerShell, run from a copy/shared mount of this repository:" >&2
    echo "powershell -ExecutionPolicy Bypass -File .\\scripts\\setup-windows-vm.ps1 -InstallPrerequisites -EnableOpenSsh -AuthorizedKey '$public_key'" >&2
    exit 1
  fi
  sleep 3
done

temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/local-lecture-windows.XXXXXX")"
cleanup() { rm -rf "$temporary_directory"; }
trap cleanup EXIT
archive="$temporary_directory/source.tar.gz"
tar_archive="$temporary_directory/source.tar"
file_list="$temporary_directory/files"
source_manifest="$temporary_directory/.windows-validation-source.json"

cd "$repo_root"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20 or newer is required to create and verify source provenance." >&2
  exit 1
fi
snapshot_id="$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short=12 HEAD)-$$"
node "$script_dir/windows-source-provenance.js" create \
  --repo "$repo_root" \
  --output "$source_manifest" \
  --file-list "$file_list" \
  --snapshot-id "$snapshot_id"
COPYFILE_DISABLE=1 tar --null -T "$file_list" -cf "$tar_archive"
COPYFILE_DISABLE=1 tar -rf "$tar_archive" -C "$temporary_directory" .windows-validation-source.json
gzip -c "$tar_archive" > "$archive"
archive_sha256="$(shasum -a 256 "$archive" | awk '{print $1}')"
echo "Submitting source snapshot $snapshot_id ($archive_sha256) from $repo_root"

ssh "${ssh_options[@]}" "$target" 'New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\LLCValidation" | Out-Null'
scp "${scp_options[@]}" "$archive" "$target:LLCValidation/source.tar.gz"
scp "${scp_options[@]}" "$repo_root/scripts/remote-windows-validation.ps1" "$target:LLCValidation/remote-run.ps1"

remote_command='powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\LLCValidation\remote-run.ps1" -Archive "$env:USERPROFILE\LLCValidation\source.tar.gz" -Mode '
remote_command+="$mode"
remote_command+=" -ExpectedSnapshotId '$snapshot_id' -ExpectedArchiveSha256 '$archive_sha256'"
if [[ $skip_installer -eq 1 ]]; then remote_command+=' -SkipInstaller'; fi

bridge_log="$artifact_root/vm-bridge-$snapshot_id.log"
set +e
ssh "${ssh_options[@]}" "$target" "$remote_command" 2>&1 | tee "$bridge_log"
remote_exit=${PIPESTATUS[0]}
set -e

local_result="$artifact_root/vm-$snapshot_id"
mkdir -p "$local_result"
if ! scp "${scp_options[@]}" "$target:LLCValidation/windows-results.zip" "$local_result/windows-results.zip"; then
  echo "Windows did not return a result archive for snapshot $snapshot_id. See $bridge_log" >&2
  if [[ $remote_exit -ne 0 ]]; then exit "$remote_exit"; fi
  exit 1
fi
if ! scp "${scp_options[@]}" "$target:LLCValidation/windows-exit-code.txt" "$local_result/windows-exit-code.txt"; then
  echo "Windows did not return an exit-code record for snapshot $snapshot_id. See $bridge_log" >&2
  if [[ $remote_exit -ne 0 ]]; then exit "$remote_exit"; fi
  exit 1
fi
/usr/bin/ditto -x -k "$local_result/windows-results.zip" "$local_result"
node "$script_dir/windows-source-provenance.js" verify-result \
  --result-root "$local_result" \
  --manifest "$source_manifest" \
  --archive-sha256 "$archive_sha256"

guest_exit="$(tr -d '[:space:]' < "$local_result/windows-exit-code.txt")"
if [[ "$guest_exit" != "$remote_exit" ]]; then
  echo "SSH exit code $remote_exit does not match the returned Windows exit code $guest_exit." >&2
  exit 1
fi

echo "Windows VM artifacts: $local_result"
echo "Verified source snapshot: $snapshot_id"
echo "Windows VM exit code: $remote_exit"
exit "$remote_exit"
