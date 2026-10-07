[CmdletBinding()]
param(
    [ValidateSet('Quick', 'Full')]
    [string]$Mode = 'Full',
    [string]$ArtifactRoot = 'debug-artifacts\windows',
    [switch]$SkipDependencyInstall,
    [switch]$SkipPackaging,
    [switch]$SkipInstaller,
    [switch]$LiveAudio
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location $repoRoot
$testStartedAt = (Get-Date).ToUniversalTime()
$artifactBase = [System.IO.Path]::GetFullPath((Join-Path $repoRoot $ArtifactRoot))
$runId = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ') + "-$PID"
$runDirectory = Join-Path $artifactBase $runId
$logsDirectory = Join-Path $runDirectory 'logs'
New-Item -ItemType Directory -Force -Path $logsDirectory | Out-Null
$script:Results = New-Object 'System.Collections.Generic.List[object]'
$script:Failed = $false
$script:PackagedExecutable = $null
$script:Installer = $null
$script:SourceProvenance = $null

function Add-Result {
    param([string]$Name, [string]$Status, [datetime]$Started, [string]$Detail)
    $script:Results.Add([pscustomobject][ordered]@{
        name = $Name
        status = $Status
        startedAt = $Started.ToUniversalTime().ToString('o')
        durationSeconds = [Math]::Round(((Get-Date) - $Started).TotalSeconds, 3)
        detail = $Detail
    }) | Out-Null
}

function Invoke-Step {
    param([string]$Name, [scriptblock]$Action)
    $started = Get-Date
    Write-Host "`n=== $Name ==="
    try {
        & $Action
        Add-Result $Name 'passed' $started 'Completed successfully.'
    } catch {
        $script:Failed = $true
        $detail = $_.Exception.Message
        Add-Result $Name 'failed' $started $detail
        Write-Error "$Name failed: $detail" -ErrorAction Continue
    }
}

function Invoke-LoggedCommand {
    param(
        [string]$Name,
        [string]$FilePath,
        [string[]]$Arguments = @()
    )
    $slug = ($Name -replace '[^A-Za-z0-9._-]+', '-').Trim('-').ToLowerInvariant()
    $logPath = Join-Path $logsDirectory "$slug.log"
    Write-Host "> $FilePath $($Arguments -join ' ')"
    # Windows PowerShell 5 wraps native stderr as ErrorRecord, including curl progress.
    # Preserve it in the log and use the native exit code to determine success.
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & $FilePath @Arguments 2>&1 | ForEach-Object { $_.ToString() } | Tee-Object -FilePath $logPath
        $exitCode = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousPreference }
    if ($exitCode -ne 0) { throw "$Name exited with code $exitCode. See $logPath" }
}

function Invoke-LocalPowerShell {
    param([string]$Script, [string[]]$Arguments = @())
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $Script @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$(Split-Path $Script -Leaf) exited with code $LASTEXITCODE" }
}

function Get-ScopedTestProcesses {
    $escapedRoot = $repoRoot.ToLowerInvariant()
    return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $name = [string]$_.Name
        $executable = [string]$_.ExecutablePath
        $commandLine = [string]$_.CommandLine
        $interesting = $name -in @('node.exe', 'electron.exe', 'Local Lecture Copilot.exe', 'whisper-cli.exe')
        $interesting -and (($executable -and $executable.ToLowerInvariant().StartsWith($escapedRoot)) -or ($commandLine -and $commandLine.ToLowerInvariant().Contains($escapedRoot)))
    })
}

function Invoke-DesktopSmoke {
    param([string]$Target, [string]$Executable)
    $arguments = @('-Target', $Target, '-ArtifactDirectory', $runDirectory, '-TimeoutSeconds', '180', '-RequireSttReady')
    if ($Executable) { $arguments += @('-Executable', $Executable) }
    if ($LiveAudio -and $Target -eq 'Packaged') {
        $arguments = @('-Target', $Target, '-Executable', $Executable, '-ArtifactDirectory', $runDirectory, '-TimeoutSeconds', '600', '-RequireSttReady', '-LiveAudioPath', (Join-Path $runDirectory 'jfk.wav'))
    }
    Invoke-LocalPowerShell (Join-Path $PSScriptRoot 'smoke-test-windows.ps1') $arguments
}

function Assert-X64Executable {
    param([string]$FilePath)
    $bytes = [System.IO.File]::ReadAllBytes($FilePath)
    if ($bytes.Length -lt 64 -or [BitConverter]::ToUInt16($bytes, 0) -ne 0x5a4d) { throw "Invalid PE executable: $FilePath" }
    $offset = [BitConverter]::ToInt32($bytes, 0x3c)
    if ($offset -lt 0 -or $offset + 6 -gt $bytes.Length -or [BitConverter]::ToUInt32($bytes, $offset) -ne 0x4550) { throw "Invalid PE header: $FilePath" }
    $machine = [BitConverter]::ToUInt16($bytes, $offset + 4)
    if ($machine -ne 0x8664) { throw "Executable is not x64: $FilePath (machine $machine)" }
    return 'AMD64 (0x8664)'
}

function Write-ReleaseManifest {
    $release = Join-Path $repoRoot 'release'
    $paths = @(
        Get-ChildItem -Path $release -File -ErrorAction Stop | Where-Object { $_.Extension -in @('.exe', '.zip', '.yml', '.yaml', '.blockmap') }
        Get-Item -LiteralPath $script:PackagedExecutable -ErrorAction Stop
        Get-Item -LiteralPath (Join-Path $release 'win-unpacked\resources\runtime\stt\win32-x64\bin\whisper-cli.exe') -ErrorAction Stop
        Get-Item -LiteralPath (Join-Path $release 'win-unpacked\resources\runtime\stt\win32-x64\models\ggml-base.bin') -ErrorAction Stop
    ) | Sort-Object FullName -Unique
    $manifest = $paths | ForEach-Object {
        [ordered]@{
            path = $_.FullName.Substring($repoRoot.Length).TrimStart('\')
            bytes = [int64]$_.Length
            sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    }
    $manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $runDirectory 'release-manifest.json') -Encoding UTF8
}

function Get-DirectCheckoutProvenance {
    $branch = $null
    $commit = $null
    $status = @()
    $clean = $null
    if (Get-Command git.exe -ErrorAction SilentlyContinue) {
        $branch = ((& git.exe branch --show-current 2>$null) -join '').Trim()
        $commit = ((& git.exe rev-parse HEAD 2>$null) -join '').Trim()
        $status = @(& git.exe status --short --branch --untracked-files=all 2>$null)
        $porcelain = @(& git.exe status --porcelain=v1 --untracked-files=all 2>$null)
        $clean = $porcelain.Count -eq 0
    }
    if (-not $branch) {
        $branch = if ($env:GITHUB_HEAD_REF) { $env:GITHUB_HEAD_REF } elseif ($env:GITHUB_REF_NAME) { $env:GITHUB_REF_NAME } else { '(detached)' }
    }
    return [pscustomobject][ordered]@{
        schemaVersion = 1
        snapshotId = "direct-$runId"
        createdAt = $testStartedAt.ToString('o')
        transport = 'direct-windows-checkout'
        sourceWorktree = $repoRoot
        branch = $branch
        commit = $commit
        clean = $clean
        gitStatus = $status
        fileCount = $null
        workingTreeSha256 = $null
        archiveSha256 = $null
        windowsWorkspace = $repoRoot
    }
}

Invoke-Step 'Bind validation to source provenance' {
    $transportManifest = Join-Path $repoRoot '.windows-validation-source.json'
    $script:SourceProvenance = if (Test-Path -LiteralPath $transportManifest -PathType Leaf) {
        Get-Content -LiteralPath $transportManifest -Raw | ConvertFrom-Json
    } else {
        Get-DirectCheckoutProvenance
    }
    if (-not $script:SourceProvenance.snapshotId) { throw 'Source provenance has no snapshot ID.' }
    if (-not $script:SourceProvenance.branch) { throw 'Source provenance has no branch identity.' }
    if (-not $script:SourceProvenance.commit) { throw 'Source provenance has no commit SHA.' }
    $script:SourceProvenance | ConvertTo-Json -Depth 10 |
        Set-Content -LiteralPath (Join-Path $runDirectory 'source-provenance.json') -Encoding UTF8
    Write-Host "Source branch: $($script:SourceProvenance.branch)"
    Write-Host "Source commit: $($script:SourceProvenance.commit)"
    Write-Host "Snapshot: $($script:SourceProvenance.snapshotId)"
    Write-Host "Clean worktree: $($script:SourceProvenance.clean)"
}

try {
    Invoke-LocalPowerShell (Join-Path $PSScriptRoot 'collect-windows-debug.ps1') @('-ArtifactDirectory', $runDirectory, '-Phase', 'pre')
} catch {
    Write-Warning "Pre-run diagnostics failed: $($_.Exception.Message)"
}

Invoke-Step 'Windows and toolchain prerequisites' {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'This harness must run inside Windows.' }
    foreach ($command in @('node.exe', 'npm.cmd', 'tar.exe')) {
        if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "$command is not available on PATH." }
    }
    $nodeVersion = (& node.exe --version).Trim().TrimStart('v')
    if ([int]$nodeVersion.Split('.')[0] -lt 20) { throw "Node.js 20 or newer is required; found $nodeVersion." }
    Write-Host "OS architecture: $([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture)"
    Write-Host "PowerShell architecture: $([System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture)"
    Write-Host "Node: $(& node.exe --version); npm: $(& npm.cmd --version)"
}

Invoke-Step 'Detect and stop stale project processes' {
    $stale = Get-ScopedTestProcesses
    $stale | Select-Object Name, ProcessId, ParentProcessId, ExecutablePath |
        ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $runDirectory 'stale-processes.json') -Encoding UTF8
    foreach ($process in $stale) {
        Write-Host "Stopping stale project process $($process.Name) ($($process.ProcessId))"
        & taskkill.exe /PID $process.ProcessId /T /F | Out-Null
    }
    if (@(Get-ScopedTestProcesses).Count -ne 0) { throw 'One or more stale project processes survived cleanup.' }
}

if (-not $SkipDependencyInstall) {
    Invoke-Step 'Install locked npm dependencies' { Invoke-LoggedCommand 'npm-ci' 'npm.cmd' @('ci', '--no-audit', '--no-fund') }
}

Invoke-Step 'JavaScript syntax checks' { Invoke-LoggedCommand 'typecheck' 'npm.cmd' @('run', 'typecheck') }
Invoke-Step 'Repository lint checks' { Invoke-LoggedCommand 'lint' 'npm.cmd' @('run', 'lint') }
Invoke-Step 'Windows path, process, and model tests' {
    Invoke-LoggedCommand 'windows-focused-tests' 'node.exe' @('--test', 'test/desktop-runtime-paths.test.js', 'test/windows-source-provenance.test.js', 'test/storage.test.js', 'test/stt.test.js', 'test/whisper-models.test.js')
}
Invoke-Step 'Full automated test suite' { Invoke-LoggedCommand 'full-tests' 'npm.cmd' @('test') }
Invoke-Step 'Production bundle configuration' { Invoke-LoggedCommand 'production-bundle' 'npm.cmd' @('run', 'build') }
Invoke-Step 'Application server loopback smoke test' {
    Invoke-LocalPowerShell (Join-Path $PSScriptRoot 'smoke-test-windows.ps1') @('-Target', 'Server', '-ArtifactDirectory', $runDirectory, '-TimeoutSeconds', '120')
}

Invoke-Step '.gitignore contract' {
    if (-not (Test-Path (Join-Path $repoRoot '.git'))) {
        Write-Host 'Source was transferred without Git metadata; .gitignore behavior is validated on the macOS source worktree and in CI.'
        return
    }
    & git.exe check-ignore -q 'debug-artifacts/windows/probe.log'
    if ($LASTEXITCODE -ne 0) { throw 'debug-artifacts/windows is not ignored.' }
    & git.exe check-ignore -q '.windows-validation-source.json'
    if ($LASTEXITCODE -ne 0) { throw 'The generated source transport manifest is not ignored.' }
    & git.exe check-ignore -q 'scripts/test-windows.ps1'
    if ($LASTEXITCODE -eq 0) { throw 'The source-controlled Windows harness is unexpectedly ignored.' }
}

if ($Mode -eq 'Full') {
    if ($LiveAudio) {
        Invoke-Step 'Download and verify real speech fixture' {
            Invoke-LoggedCommand 'speech-fixture' 'node.exe' @('scripts/prepare-speech-fixture.js', (Join-Path $runDirectory 'jfk.wav'))
        }
    }
    Invoke-Step 'Prepare managed Windows x64 Whisper runtime' {
        Invoke-LoggedCommand 'prepare-windows-runtime' 'node.exe' @('scripts/prepare-stt-runtime.js', '--platform=win32', '--arch=x64')
    }

    Invoke-Step 'Verify Whisper executable, DLLs, model, and child process' {
        $runtimeRoot = Join-Path $repoRoot 'runtime\stt\win32-x64'
        $binary = Join-Path $runtimeRoot 'bin\whisper-cli.exe'
        $model = Join-Path $runtimeRoot 'models\ggml-base.bin'
        $manifestPath = Join-Path $runtimeRoot 'manifest.json'
        foreach ($required in @($binary, $model, $manifestPath, (Join-Path $runtimeRoot 'LICENSE.whisper.cpp'))) {
            if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Required runtime file is missing: $required" }
        }
        $binaryDirectory = Split-Path $binary
        $dlls = @(Get-ChildItem -Path $binaryDirectory -Filter '*.dll' -File)
        foreach ($requiredDll in @('whisper.dll', 'ggml.dll', 'ggml-base.dll')) {
            if (-not (Test-Path -LiteralPath (Join-Path $binaryDirectory $requiredDll) -PathType Leaf)) { throw "Required Whisper DLL is missing: $requiredDll" }
        }
        if (@($dlls | Where-Object { $_.Name -like 'ggml-cpu*.dll' }).Count -lt 1) { throw 'No ggml-cpu Windows backend DLL was found beside whisper-cli.exe.' }
        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
        if ($manifest.platform -ne 'win32' -or $manifest.arch -ne 'x64') { throw 'Whisper runtime manifest does not describe win32-x64.' }
        $hash = (Get-FileHash -LiteralPath $model -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($hash -ne '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe') { throw "Bundled Base model checksum mismatch: $hash" }
        $whisperMachine = Assert-X64Executable $binary
        Invoke-LoggedCommand 'whisper-child-process' $binary @('--help')
        [ordered]@{ binary = $binary; peMachine = $whisperMachine; dlls = @($dlls.Name); model = $model; modelSha256 = $hash; manifest = $manifest } |
            ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $runDirectory 'whisper-runtime.json') -Encoding UTF8
    }

    Invoke-Step 'Development Electron startup and shutdown' { Invoke-DesktopSmoke 'Development' $null }

    if (-not $SkipPackaging) {
        Invoke-Step 'Production Windows x64 package build' { Invoke-LoggedCommand 'windows-package' 'npm.cmd' @('run', 'desktop:build:win') }

        Invoke-Step 'Packaged resource and installer verification' {
            $unpacked = Join-Path $repoRoot 'release\win-unpacked'
            $script:PackagedExecutable = Join-Path $unpacked 'Local Lecture Copilot.exe'
            $resources = Join-Path $unpacked 'resources'
            $runtime = Join-Path $resources 'runtime\stt\win32-x64'
            $required = @(
                $script:PackagedExecutable,
                (Join-Path $resources 'app.asar'),
                (Join-Path $runtime 'bin\whisper-cli.exe'),
                (Join-Path $runtime 'models\ggml-base.bin'),
                (Join-Path $runtime 'manifest.json')
            )
            foreach ($file in $required) {
                if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Packaged resource is missing: $file" }
            }
            Assert-X64Executable $script:PackagedExecutable | Out-Null
            Assert-X64Executable (Join-Path $runtime 'bin\whisper-cli.exe') | Out-Null
            $packagedBinaryDirectory = Join-Path $runtime 'bin'
            $packagedDlls = @(Get-ChildItem -Path $packagedBinaryDirectory -Filter '*.dll' -File)
            foreach ($requiredDll in @('whisper.dll', 'ggml.dll', 'ggml-base.dll')) {
                if (-not (Test-Path -LiteralPath (Join-Path $packagedBinaryDirectory $requiredDll) -PathType Leaf)) { throw "Packaged Whisper DLL is missing: $requiredDll" }
            }
            if (@($packagedDlls | Where-Object { $_.Name -like 'ggml-cpu*.dll' }).Count -lt 1) { throw 'Packaged Whisper runtime has no ggml-cpu backend DLL.' }
            $script:Installer = Get-ChildItem -Path (Join-Path $repoRoot 'release') -File -Filter '*.exe' |
                Where-Object { $_.Name -match 'Setup' } | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1 -ExpandProperty FullName
            if (-not $script:Installer) { throw 'electron-builder did not produce an NSIS Setup executable.' }
            $zip = Get-ChildItem -Path (Join-Path $repoRoot 'release') -File -Filter '*.zip' | Select-Object -First 1
            if (-not $zip) { throw 'electron-builder did not produce the configured Windows ZIP.' }
            Write-ReleaseManifest
        }

        Invoke-Step 'Packaged Electron startup and shutdown' { Invoke-DesktopSmoke 'Packaged' $script:PackagedExecutable }

        if (-not $SkipInstaller) {
            Invoke-Step 'Silent install, installed launch, and uninstall' {
                $installDirectory = Join-Path $env:TEMP "LLCInstall-$runId"
                if (Test-Path -LiteralPath $installDirectory) { Remove-Item -LiteralPath $installDirectory -Recurse -Force }
                $installerProcess = Start-Process -FilePath $script:Installer -ArgumentList @('/S', "/D=$installDirectory") -Wait -PassThru
                if ($installerProcess.ExitCode -ne 0) { throw "NSIS installer exited with code $($installerProcess.ExitCode)." }
                $installedExecutable = Get-ChildItem -Path $installDirectory -File -Recurse -Filter 'Local Lecture Copilot.exe' | Select-Object -First 1 -ExpandProperty FullName
                if (-not $installedExecutable) { throw "Installed application executable was not found below $installDirectory" }
                try {
                    Invoke-DesktopSmoke 'Installed' $installedExecutable
                } finally {
                    $uninstaller = Get-ChildItem -Path $installDirectory -File -Recurse -Filter 'Uninstall*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
                    if ($uninstaller) {
                        $uninstallProcess = Start-Process -FilePath $uninstaller -ArgumentList @('/S') -Wait -PassThru
                        if ($uninstallProcess.ExitCode -ne 0) { Write-Warning "Uninstaller exited with code $($uninstallProcess.ExitCode)." }
                    } else { Write-Warning 'Uninstaller was not found; the isolated test installation may require manual removal.' }
                }
            }
        }
    }
}

Invoke-Step 'No stale project processes after validation' {
    $remaining = Get-ScopedTestProcesses
    ConvertTo-Json -InputObject @($remaining | Select-Object Name, ProcessId, ParentProcessId, ExecutablePath) -Depth 3 | Set-Content -LiteralPath (Join-Path $runDirectory 'remaining-processes.json') -Encoding UTF8
    if (@($remaining).Count -ne 0) {
        foreach ($process in $remaining) { & taskkill.exe /PID $process.ProcessId /T /F | Out-Null }
        throw "$(@($remaining).Count) project process(es) remained after validation and were terminated."
    }
}

try {
    Invoke-LocalPowerShell (Join-Path $PSScriptRoot 'collect-windows-debug.ps1') @('-ArtifactDirectory', $runDirectory, '-Phase', 'post')
} catch {
    $script:Failed = $true
    Write-Warning "Post-run diagnostics failed: $($_.Exception.Message)"
}

$summaryNode = if (Get-Command node.exe -ErrorAction SilentlyContinue) { (& node.exe --version).Trim() } else { $null }
$windowsInfo = try {
    $windows = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
    [ordered]@{
        caption = $windows.Caption
        version = $windows.Version
        buildNumber = $windows.BuildNumber
        osArchitecture = $windows.OSArchitecture
    }
} catch {
    [ordered]@{ caption = 'Windows'; version = [Environment]::OSVersion.VersionString; buildNumber = $null; osArchitecture = $null }
}
$sourceSummary = if ($script:SourceProvenance) {
    [ordered]@{
        snapshotId = $script:SourceProvenance.snapshotId
        createdAt = $script:SourceProvenance.createdAt
        transport = $script:SourceProvenance.transport
        branch = $script:SourceProvenance.branch
        commit = $script:SourceProvenance.commit
        clean = $script:SourceProvenance.clean
        gitStatus = @($script:SourceProvenance.gitStatus)
        fileCount = $script:SourceProvenance.fileCount
        workingTreeSha256 = $script:SourceProvenance.workingTreeSha256
        archiveSha256 = $script:SourceProvenance.archiveSha256
    }
} else { $null }
$summary = [ordered]@{
    schemaVersion = 2
    runId = $runId
    mode = $Mode
    passed = -not $script:Failed
    startedFrom = $repoRoot
    startedAt = $testStartedAt.ToString('o')
    completedAt = (Get-Date).ToUniversalTime().ToString('o')
    source = $sourceSummary
    windows = $windowsInfo
    osArchitecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    processArchitecture = [System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString()
    node = $summaryNode
    results = @($script:Results | ForEach-Object { $_ })
}
$summary | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath (Join-Path $runDirectory 'summary.json') -Encoding UTF8

$markdown = New-Object 'System.Collections.Generic.List[string]'
$markdown.Add('# Windows validation summary') | Out-Null
$markdown.Add('') | Out-Null
$markdown.Add("- Run: $runId") | Out-Null
$markdown.Add("- Mode: $Mode") | Out-Null
$markdown.Add("- Result: **$(if ($summary.passed) { 'PASS' } else { 'FAIL' })**") | Out-Null
$markdown.Add("- Started: $($summary.startedAt)") | Out-Null
$markdown.Add("- Completed: $($summary.completedAt)") | Out-Null
$markdown.Add("- Source branch: $($summary.source.branch)") | Out-Null
$markdown.Add("- Source commit: $($summary.source.commit)") | Out-Null
$markdown.Add("- Source clean: $($summary.source.clean)") | Out-Null
$markdown.Add("- Snapshot: $($summary.source.snapshotId)") | Out-Null
$markdown.Add("- Working-tree SHA-256: $($summary.source.workingTreeSha256)") | Out-Null
$markdown.Add("- Archive SHA-256: $($summary.source.archiveSha256)") | Out-Null
$markdown.Add("- Windows: $($summary.windows.caption) $($summary.windows.version) (build $($summary.windows.buildNumber))") | Out-Null
$markdown.Add("- OS architecture: $($summary.osArchitecture)") | Out-Null
$markdown.Add("- Process architecture: $($summary.processArchitecture)") | Out-Null
$markdown.Add("- Node: $($summary.node)") | Out-Null
$markdown.Add('') | Out-Null
$markdown.Add('| Check | Result | Seconds | Detail |') | Out-Null
$markdown.Add('|---|---:|---:|---|') | Out-Null
foreach ($result in $script:Results) {
    $detail = ([string]$result.detail).Replace('|', '\|').Replace("`r", ' ').Replace("`n", ' ')
    $markdown.Add("| $($result.name) | $($result.status) | $($result.durationSeconds) | $detail |") | Out-Null
}
$markdown | Set-Content -LiteralPath (Join-Path $runDirectory 'summary.md') -Encoding UTF8
$runId | Set-Content -LiteralPath (Join-Path $artifactBase 'latest-run.txt') -Encoding ascii

Write-Host "`nWindows validation result: $(if ($summary.passed) { 'PASS' } else { 'FAIL' })"
Write-Host "Artifacts: $runDirectory"
Write-Host "WINDOWS_VALIDATION_RUN=$runId"
if ($script:Failed) { exit 1 }
