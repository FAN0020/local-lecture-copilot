# Windows development and testing

This project uses two complementary Windows layers:

1. A local **Windows 11 ARM VM in UTM** for fast interactive and automated checks from an Apple Silicon Mac.
2. A **GitHub Actions `windows-latest` x64 runner** for independent Windows x64 tests and package validation.

UTM is the selected local hypervisor because its direct download is free and open source, it virtualizes ARM64 guests efficiently on Apple Silicon, and it provides a supported `utmctl` start/stop interface. Wine is not part of this workflow. The repository scripts use SSH for guest command execution because it is explicit, inspectable, and independent of shared-folder drive-letter behavior.

The VM is machine-local infrastructure, not a branch environment. It has no permanent repository checkout and can validate any Local Dictator worktree that contains these repository scripts. Run the command from the worktree to be tested; the bridge snapshots that worktree, records its source identity, and replaces the disposable Windows staging directory.

Official references:

- [UTM download and licensing](https://mac.getutm.app/)
- [UTM Windows 11 setup](https://docs.getutm.app/guides/windows/)
- [UTM scripting and `utmctl`](https://docs.getutm.app/scripting/scripting/)
- [Microsoft Windows 11 Arm64 ISO](https://www.microsoft.com/software-download/windows11arm64)
- [Microsoft OpenSSH Server setup](https://learn.microsoft.com/windows-server/administration/openssh/openssh_install_firstuse)
- [GitHub-hosted runner architectures](https://docs.github.com/actions/how-tos/write-workflows/choose-where-workflows-run/choose-the-runner-for-a-job)

## Architecture

```text
selected macOS worktree (tracked + untracked, non-ignored source)
    │
    ├── optional utmctl start "Windows 11 ARM"
    ├── branch + commit + git status + per-file SHA-256 manifest
    ├── tar source snapshot + archive SHA-256
    └── SCP over a dedicated SSH key
             │
             ▼
Windows 11 ARM VM, local NTFS staging directory
    │
    ├── reject a wrong archive/snapshot/file set
    ├── npm ci / syntax / lint / tests
    ├── loopback server smoke test
    ├── prepare and execute x64 whisper.cpp runtime
    ├── launch/stop development Electron
    ├── build NSIS + ZIP x64 packages
    ├── launch/stop unpacked packaged Electron
    ├── optionally install, launch, and uninstall NSIS package
    └── JSON, Markdown, process, port, memory, runtime, and package diagnostics
             │
             └── source-bound ZIP + SCP back to the selected worktree

GitHub checkout
    └── windows-latest (x64)
            └── same Full harness, excluding the silent installer step
```

The bridge stages a fresh source snapshot under `%USERPROFILE%\LLCValidation\repo` for every run. It does not execute npm from a UTM WebDAV/shared folder, where path, file-locking, and `node_modules` behavior can differ from NTFS. The snapshot includes current tracked and untracked non-ignored files, while tracked deletions remain deleted, so Codex can validate edits before committing. Git metadata, secrets, ignored models, dependencies, packages, and prior diagnostics are not transferred.

For a clean worktree, `branch` and `commit` identify the exact revision. For a dirty worktree, the same base commit is recorded together with full short Git status, a per-file manifest, a working-tree SHA-256, and an archive SHA-256. Windows verifies the archive and every extracted file before running. macOS verifies those identifiers again when results return, so a stale result from another branch or earlier edit cannot be accepted.

## Machine-local versus repository infrastructure

Machine-local VM state stays outside Git: the UTM bundle and snapshots, Windows ISO, global SSH key/known-hosts state, global VM connection file, Windows staging directory, downloaded runtimes/models, packages, logs, crash dumps, and `debug-artifacts/windows/` results. A repo-local `.windows-vm.env` remains supported only as an ignored fallback.

Reusable project infrastructure stays tracked: `scripts/run-windows-validation.sh`, the bridge and setup scripts, PowerShell validation/smoke/debug scripts, source-provenance helper and tests, `.windows-vm.env.example`, the GitHub Actions workflow, and this document. Do not copy these files into an untracked tools folder; cherry-pick their commits into every branch that needs Windows validation.

## Important ARM64 versus x64 limitation

The production package and managed Windows Whisper runtime are **x64**. Windows 11 ARM can run them using Microsoft's x64 emulation, which is useful for development, installer, startup, resource-path, and functional testing. It does **not** replace release validation on Windows x64. Timing, CPU features, DLL loading, audio devices/drivers, security software, and installer behavior may differ.

The GitHub workflow supplies an x64 Windows environment and catches x64 dependency, test, startup, and packaging failures. Before a release, also perform the final manual audio/microphone check on a physical or virtual Windows x64 system representative of users.

## Prerequisites

On macOS:

- Apple Silicon Mac.
- UTM from the free direct download.
- `ssh`, `scp`, `ssh-keygen`, `tar`, `git`, and `ditto` (provided by macOS/Xcode command-line tools).
- Enough storage for the VM, npm dependencies, a roughly 150 MB bundled Whisper Base model, and build outputs.

Inside Windows:

- Windows 11 ARM with current Windows Updates.
- PowerShell 5.1 or newer.
- Node.js 20 or newer and npm.
- Windows `tar.exe`.
- OpenSSH Server for automatic Mac-to-VM runs.
- Internet access for npm, Electron/electron-builder, whisper.cpp, and the model on a cold run.

UTM itself is free. Microsoft provides the Arm64 ISO download, but Windows use remains subject to Microsoft's licensing terms.

## One-time UTM and Windows 11 ARM setup

1. Install UTM from its official direct download. Do not commit UTM bundles, disks, snapshots, or ISO files to this repository.
2. Download the current Windows 11 Arm64 ISO from Microsoft.
3. In UTM choose **Create a New Virtual Machine → Virtualize → Windows**.
4. Use the Arm64 ISO, enable **Install drivers and SPICE tools**, and name the VM `Windows 11 ARM` (or record another name in `.windows-vm.env`).
5. A practical starting allocation is 4 CPU cores, 8 GB RAM, and an 80 GB dynamically allocated disk. Larger Whisper models need more disk and memory.
6. Select any checkout containing the tracked setup script as the temporary UTM shared directory. This is needed only for initial setup and emergency/manual use; it does not select what later validation runs test.
7. Complete Windows setup, Windows Update, and SPICE guest-tools installation. Take a clean VM snapshot in UTM after this step if desired; keep snapshots outside the repository.
8. In Windows Explorer, open the UTM shared repository folder, then open **PowerShell as Administrator** in that folder.

On macOS, create the machine-level bridge key and copy its public half to the clipboard:

```sh
./scripts/run-windows-validation.sh --prepare-key | tail -n 1 | pbcopy
```

Then run this exact initialization command in the elevated Windows PowerShell from the shared repository folder:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-windows-vm.ps1 -InstallPrerequisites -EnableOpenSsh -AuthorizedKey (Get-Clipboard)
```

The setup script installs Node LTS and Git with `winget` only when needed, enables the Windows OpenSSH capability and firewall rule, selects Windows PowerShell as the SSH shell, installs the dedicated public key, and writes a non-secret verification record. It prints usable VM IPv4 addresses. It does not install Ollama or download optional Whisper models.

Copy the example connection file to the machine-level configuration directory on macOS and edit its host/user values:

```sh
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/local-lecture-copilot"
cp .windows-vm.env.example "${XDG_CONFIG_HOME:-$HOME/.config}/local-lecture-copilot/windows-vm.env"
```

The global file is shared by all worktrees. It must contain only host, username, port, UTM VM name, and optionally the private-key path. Never store a Windows password, token, private-key contents, or other credential in it. The generated key defaults to `~/.local/share/local-lecture-copilot/windows-vm/id_ed25519`, outside every repository. A repo-local ignored `.windows-vm.env` or explicit `--config FILE` can override the machine-level file when necessary.

Confirm the bridge without building a package:

```sh
./scripts/run-windows-validation.sh --mode Quick --no-start
```

If UTM networking changes the guest IP after reboot, update `WINDOWS_VM_HOST`. A DHCP reservation or UTM host-to-guest port forward can make the address stable.

## Windows validation commands

Run directly inside Windows from a repository checkout or staged source:

```powershell
# Fast checks: dependencies, syntax, lint, tests, build config, server smoke.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-windows.ps1 -Mode Quick

# Complete VM validation: runtime, Electron, package, install, launch, uninstall.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-windows.ps1 -Mode Full
```

Run from macOS after the one-time setup:

```sh
./scripts/run-windows-validation.sh --mode Full
```

That is the standard command Codex should use from the worktree it wants Windows to validate. The script derives its source root from its own location; it does not use the infrastructure branch or a hard-coded checkout. If `WINDOWS_VM_NAME` is configured and UTM/`utmctl` is installed, it starts the VM and waits for SSH. Use `--no-start` when the VM is already running. Use `--skip-installer` when only tests, runtime, build, and unpacked package startup are needed.

All failures return a non-zero exit code. The bridge returns the guest harness exit code to macOS.

## What the Full harness validates

- Submitted branch, base commit, Git status, snapshot ID, per-file digest, and archive digest before accepting the source or returned result.
- Windows OS, PowerShell, Node 20+, npm, `tar.exe`, process and OS architecture.
- Locked dependency installation with `npm ci`.
- JavaScript syntax, repository lint, focused path/process/model tests, and the full Node test suite.
- Windows paths with spaces and non-ASCII characters.
- Loopback-only application server startup on an ephemeral port, HTTP health/settings/static responses, and shutdown.
- Writable workspace, settings, and model-install locations.
- Managed `win32-x64` Whisper discovery, manifest, Base model SHA-256, adjacent DLL discovery, and an actual `whisper-cli.exe --help` child-process launch.
- Development Electron startup, renderer load, embedded server health, resource/model paths, memory record, and clean shutdown.
- Production x64 NSIS and ZIP generation.
- `app.asar`, packaged Whisper executable/DLL/model/manifest resolution, and package hashes.
- Unpacked packaged Electron startup and shutdown.
- By default in the local VM: silent NSIS install to an isolated temporary path, installed executable startup, shutdown, and uninstall.
- Project-scoped stale process detection/cleanup before the run and a no-stale-process assertion afterward.
- Relevant processes, memory, listening ports, runtime/package inventory, and matching Windows crash dumps.

Without `-LiveAudio`, the harness checks startup and packaging only. With `-LiveAudio` (enabled in GitHub Actions), it also exercises the packaged real-speech pipeline described below. Neither mode downloads optional multi-gigabyte Whisper models or requires a running Ollama service. Model-manager unit/integration tests validate the writable installation path and atomic model install behavior; the packaged health smoke verifies that the application resolves that writable path separately from read-only packaged resources.

## Selecting a branch or worktree

There is no branch setting in the VM. The macOS worktree containing the command is the source of truth:

```sh
cd /absolute/path/to/the/worktree-to-test
git branch --show-current
git status --short
./scripts/run-windows-validation.sh --mode Full
```

The bridge does not run `git checkout` in Windows. Instead, it transfers the exact current tracked and untracked non-ignored contents to a fresh Windows-local directory. This supports committed revisions and in-progress Version C edits without pushing or committing them first. Results identify a clean revision by branch and commit; dirty results additionally require the Git status, file count, working-tree digest, archive digest, and unique snapshot ID to match.

To adopt the infrastructure on another branch without merging unrelated history, first make sure that branch's worktree is clean, then cherry-pick the infrastructure commit followed by the documentation commit reported in the implementation handoff:

```sh
git status --short
git cherry-pick <windows-testing-infrastructure-commit>
git cherry-pick <windows-testing-documentation-commit>
```

Resolve conflicts rather than overwriting branch work. After the cherry-picks, the same global VM configuration and key work immediately; no new VM or VM checkout is needed.

## Development and production testing

For a source-only iteration, use `Quick`. For any change involving Electron, paths, child processes, runtime downloads, models, packaging, or release behavior, use `Full`.

The Full run downloads/prepares `runtime/stt/win32-x64` on first use. The active target then feeds `npm run build`, and electron-builder creates:

- `release/win-unpacked/Local Lecture Copilot.exe`
- an NSIS Setup executable
- a Windows ZIP package

Generated runtime, package, install, and diagnostic files are ignored. Source PowerShell/shell scripts, workflow YAML, docs, fixtures, icons, and required source-controlled runtime documentation remain tracked.

## Codex Windows Debugging Loop

For every Windows-sensitive change, a future Codex session should:

1. Inspect the macOS worktree and preserve unrelated changes.
2. Edit and run appropriate macOS checks.
3. Confirm `git branch --show-current`, `git rev-parse HEAD`, and `git status --short`, then run `./scripts/run-windows-validation.sh --mode Full` from that same intended worktree.
4. Use the exact `debug-artifacts/windows/vm-<snapshot-id>/` path printed by the bridge. Read `latest-run.txt`, then the corresponding `summary.md`, `summary.json`, and `source-provenance.json`.
5. Inspect the failed step's file under `logs/`, plus `diagnostics-pre.json`, `diagnostics-post.json`, Electron smoke JSON, server smoke JSON, `whisper-runtime.json`, and `release-manifest.json` as relevant.
6. Confirm the result's `source.branch`, `source.commit`, `source.gitStatus`, and `source.workingTreeSha256`. The bridge already rejects the result if they do not match the submitted source.
7. Fix on macOS and repeat. Each run replaces only the dedicated guest staging directory and returns a new snapshot-specific artifact set to the invoking worktree.
8. State explicitly whether evidence came from Windows ARM emulation, GitHub's x64 runner, macOS only, or a native x64 release machine. Never infer a Windows pass from macOS results.

## Logs and result interpretation

Guest results are written under:

```text
debug-artifacts/windows/<UTC-run-id>/
```

Mac bridge results are returned under:

```text
debug-artifacts/windows/vm-<snapshot-id>/
```

Key files:

- `summary.md`: concise human-readable pass/fail table.
- `summary.json`: machine-readable overall result, every check, source identity, test timestamps, Windows version, architecture, and Node version.
- `source-provenance.json`: full submitted branch/commit/status and source file manifest.
- `logs/*.log`: command output for npm, tests, runtime preparation, child launch, and packaging.
- `server-smoke.json`: port, host, paths, health, memory, and runtime snapshot.
- `development-smoke.json`, `packaged-smoke.json`, `installed-smoke.json`: actual Electron launch evidence.
- `whisper-runtime.json`: executable, DLL, model, checksum, and manifest evidence.
- `release-manifest.json`: package file sizes and SHA-256 hashes.
- `diagnostics-pre.json` / `diagnostics-post.json`: OS, architecture, processes, ports, memory, runtime/package inventory, and crash-dump references.
- `windows-exit-code.txt`: guest result returned by the bridge.

The source of truth is `summary.json` plus the per-check evidence. A missing result is not a pass. Before returning success, the macOS bridge checks the result's snapshot ID, branch, commit, status, clean/dirty state, file count, working-tree SHA-256, and archive SHA-256 against the submitted manifest. The Windows bridge deletes the previous ZIP and exit-code record before accepting a new archive, so an interrupted run cannot return old evidence. A `passed: true` result generated on Windows records `platform: win32`/architecture in the smoke evidence.

## Resetting a broken test environment

Try the least destructive reset first:

1. Reboot the Windows VM and rerun Full validation. The harness terminates only project-scoped stale processes.
2. Remove `%USERPROFILE%\LLCValidation` inside the VM. The next macOS bridge run recreates it from source.
3. Remove the repository's ignored `node_modules`, `runtime\stt\win32-x64`, `dist`, and `release` directories inside the staged VM copy, then rerun Full. Do not remove source-controlled `runtime\stt\README.md`.
4. Rerun `setup-windows-vm.ps1` if Node/OpenSSH/firewall/key configuration was damaged.
5. Restore the clean post-install UTM snapshot only if Windows itself or guest tools are broken. Copy out any wanted `debug-artifacts/windows` results first.

To rotate the bridge key, move the machine-level `~/.local/share/local-lecture-copilot/windows-vm/id_ed25519` and `.pub` files to a safe backup, run `--prepare-key`, and rerun setup with the new public key. Remove the old line from `%ProgramData%\ssh\administrators_authorized_keys` after the new key works.

## GitHub Actions x64 validation

`.github/workflows/windows-validation.yml` runs on `windows-latest`, whose standard runner architecture is x64. It uses the same Full harness with `-SkipInstaller -LiveAudio`, performs actual development and unpacked-package Electron smoke launches, builds NSIS and ZIP packages, and uploads diagnostics on success or failure. Validated packages are uploaded only on success.

CI runs directly from GitHub's checkout rather than the VM bridge. The harness records the checkout commit, branch (using GitHub's ref metadata when the checkout is detached), Git status, test timestamps, Windows version, architecture, and Node version in the same summary schema.

The workflow runs for pull requests, pushes to `main`/`version-c-completed`, and manual dispatch. Public repositories receive standard hosted runners without usage charges; private repositories consume the account's included minutes and may incur charges after the allowance. No repository secrets are required.

## Final release verification

Before publishing a Windows release:

1. Obtain a passing macOS `npm run check` result.
2. Obtain a passing Windows 11 ARM VM Full result, including the installer step.
3. Obtain a passing `Windows x64 validation` GitHub Actions run for the exact release commit.
4. Compare the CI package names/hashes with `release-manifest.json` for the artifacts being evaluated.
5. On a Windows x64 release machine, run `scripts\test-windows.ps1 -Mode Full` and manually verify install/uninstall, first launch, microphone permission/capture, audio upload, one short Whisper transcription, optional model installation, workspace selection, restart persistence, and clean application exit.
6. Preserve the final `summary.json`, smoke results, package hashes, and any manual observations with the release record.

The ARM VM and x64 CI substantially reduce regressions, but the final x64 audio/device exercise is the release gate for the x64 production package.

## Packaged real-speech validation

The GitHub-hosted `windows-latest` job runs `scripts/test-windows.ps1 -Mode Full -SkipInstaller -LiveAudio` after the application checks. `-LiveAudio` downloads the real JFK recording from whisper.cpp commit `371b5a7561823ab2bb32142d2751e35e7534727b` and verifies SHA-256 `59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e`. The fixture and provenance JSON are included in diagnostics. This is real recorded speech, not silence, synthetic noise, or mocked ASR.

The built x64 Electron application launches its actual server and submits the WAV through the dictation HTTP API. With only Base installed, it checks separate provisional and revised Whisper versions, recognized speech, audio preservation, and the absence of an automatic HQ pass. It uploads a reference text and exercises the C6 lexical retrieval function against the real Raw transcript. Ollama is deliberately pointed at an unavailable loopback endpoint: live translation must fail once per eligible sentence, repeated triggers must not resubmit failed sentences, and the cleanup API must preserve Raw/audio and report a retryable provider error. Successful model-generated correction is covered by application tests, not claimed by this unavailable-provider scenario.

`packaged-smoke.json` contains the transcript versions, retrieval evidence, translation attempt counts, saved-audio hashes, job/process/temp counts, and the post-shutdown snapshot. `packaged-shutdown.json` independently records Electron exit and the closed loopback port. `remaining-processes.json` records the harness's final Windows process inventory; `release-manifest.json` hashes the installer, ZIP, packaged executable, Whisper executable, and Base model. PE headers are checked for AMD64, in addition to Electron's reported architecture.

PowerShell 5 native stderr is captured as text and commands are judged by their exit codes; a curl progress line or Whisper help text must not abort preparation. Empty/single-element collections are normalized before counting and serializing.

This validates the packaged Windows audio pipeline using WAV input. It does not test microphone hardware, Windows microphone permission prompts, or acoustic capture. CI builds the NSIS installer but skips installing it; packaged execution uses `release/win-unpacked`.
