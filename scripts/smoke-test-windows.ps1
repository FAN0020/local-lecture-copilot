[CmdletBinding()]
param(
    [ValidateSet('Server', 'Development', 'Packaged', 'Installed')]
    [string]$Target = 'Server',
    [string]$Executable,
    [Parameter(Mandatory = $true)]
    [string]$ArtifactDirectory,
    [int]$TimeoutSeconds = 120,
    [switch]$RequireSttReady,
    [string]$LiveAudioPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Windows smoke tests must run inside Windows.' }

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$destination = [System.IO.Path]::GetFullPath($ArtifactDirectory)
New-Item -ItemType Directory -Force -Path $destination | Out-Null
$slug = $Target.ToLowerInvariant()
$resultPath = Join-Path $destination "$slug-smoke.json"
$stdoutPath = Join-Path $destination "$slug-stdout.log"
$stderrPath = Join-Path $destination "$slug-stderr.log"

function Assert-LoopbackPortClosed {
    param([string]$Url)
    $uri = [Uri]$Url
    $client = New-Object System.Net.Sockets.TcpClient
    $connected = $false
    try {
        $client.Connect('127.0.0.1', $uri.Port)
        $connected = $true
    } catch [System.Net.Sockets.SocketException] {
        $connected = $false
    } finally {
        $client.Dispose()
    }
    if ($connected) { throw "Loopback port $($uri.Port) is still accepting connections after $Target shutdown." }
}

if ($Target -eq 'Server') {
    Push-Location $repoRoot
    try {
        & node.exe scripts/smoke-server.js "--output=$resultPath" 2>&1 | Tee-Object -FilePath $stdoutPath
        $exitCode = $LASTEXITCODE
    } finally { Pop-Location }
    if ($exitCode -ne 0) { throw "Server smoke test failed with exit code $exitCode" }
} else {
    if (-not $Executable) {
        if ($Target -ne 'Development') { throw "Executable is required for target $Target" }
        $Executable = Join-Path $repoRoot 'node_modules\electron\dist\electron.exe'
    }
    $Executable = [System.IO.Path]::GetFullPath($Executable)
    if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) { throw "Electron executable not found: $Executable" }

    Remove-Item -LiteralPath $resultPath -Force -ErrorAction SilentlyContinue
    $previousAudio = $env:LECTURE_COPILOT_SMOKE_AUDIO
    $previousOllama = $env:OLLAMA_URL
    if ($LiveAudioPath) {
        $env:LECTURE_COPILOT_SMOKE_AUDIO = [System.IO.Path]::GetFullPath($LiveAudioPath)
        # Port zero is unavailable; exercise the actual provider's connection failure.
        $env:OLLAMA_URL = 'http://127.0.0.1:0'
    }
    $previousResult = $env:LECTURE_COPILOT_SMOKE_RESULT
    $previousUserData = $env:LECTURE_COPILOT_SMOKE_USER_DATA
    $previousDebug = $env:LECTURE_COPILOT_RUNTIME_DEBUG
    $previousTimeout = $env:LECTURE_COPILOT_OLLAMA_TIMEOUT_MS
    $env:LECTURE_COPILOT_SMOKE_RESULT = $resultPath
    $env:LECTURE_COPILOT_SMOKE_USER_DATA = Join-Path $destination "$slug-user-data"
    $env:LECTURE_COPILOT_RUNTIME_DEBUG = '1'
    $env:LECTURE_COPILOT_OLLAMA_TIMEOUT_MS = '3000'
    $process = $null
    try {
        $arguments = @(if ($Target -eq 'Development') { '.' })
        if (@($arguments).Count -gt 0) {
            $process = Start-Process -FilePath $Executable -ArgumentList $arguments -WorkingDirectory $repoRoot -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
        } else {
            $process = Start-Process -FilePath $Executable -WorkingDirectory $repoRoot -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
        }
        # Retain the native handle before a fast process exits (PowerShell 5).
        $null = $process.Handle
        $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
        while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath $resultPath)) {
            if ($process.HasExited) { break }
            Start-Sleep -Milliseconds 250
            $process.Refresh()
        }
        if (-not (Test-Path -LiteralPath $resultPath)) {
            if (-not $process.HasExited) { & taskkill.exe /PID $process.Id /T /F | Out-Null }
            throw "$Target Electron smoke test did not produce a result within $TimeoutSeconds seconds."
        }
        $result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
        if (-not $result.ok) { throw "$Target Electron smoke test reported failure: $($result.error)" }
        if ($LiveAudioPath -and -not $result.liveAudio.ok) { throw 'Real-speech pipeline validation failed.' }
        if (-not $result.stopped) { throw 'Desktop smoke did not confirm shutdown.' }
        if ($result.arch -ne 'x64') { throw "Expected Electron x64, found $($result.arch)." }
        if ($result.platform -ne 'win32') { throw "$Target Electron smoke test ran on $($result.platform), not Windows." }
        $expectedPackaged = $Target -ne 'Development'
        if ([bool]$result.packaged -ne $expectedPackaged) { throw "$Target packaged-state check failed." }
        if ($result.runtimeTarget -ne 'win32-x64') { throw "Unexpected Windows runtime target: $($result.runtimeTarget)" }
        if ($result.serverUrl -notmatch '^http://127\.0\.0\.1:\d+$') { throw "Desktop server did not use an ephemeral loopback port: $($result.serverUrl)" }
        if ($RequireSttReady -and -not $result.health.sttReady) { throw "Managed Whisper was not ready: $($result.health.sttRuntime.message)" }
        if (-not $process.HasExited) { $process.WaitForExit([Math]::Max(1000, $TimeoutSeconds * 1000)) | Out-Null }
        $process.Refresh()
        if (-not $process.HasExited) { & taskkill.exe /PID $process.Id /T /F | Out-Null; throw "$Target Electron process did not shut down after its smoke test." }
        $process.WaitForExit()
        $electronExitCode = $process.ExitCode
        if ($null -eq $electronExitCode) { throw "$Target Electron exit code could not be read." }
        if ($electronExitCode -ne 0) { throw "$Target Electron process exited with code $electronExitCode." }
        Assert-LoopbackPortClosed $result.serverUrl
        [ordered]@{ exited = $true; exitCode = $electronExitCode; loopbackPortClosed = $true; serverUrl = $result.serverUrl } |
            ConvertTo-Json | Set-Content -LiteralPath (Join-Path $destination "$slug-shutdown.json") -Encoding UTF8
    } finally {
        if ($process -and -not $process.HasExited) { & taskkill.exe /PID $process.Id /T /F | Out-Null }
        $env:LECTURE_COPILOT_SMOKE_AUDIO = $previousAudio
        $env:OLLAMA_URL = $previousOllama
        $env:LECTURE_COPILOT_SMOKE_RESULT = $previousResult
        $env:LECTURE_COPILOT_SMOKE_USER_DATA = $previousUserData
        $env:LECTURE_COPILOT_RUNTIME_DEBUG = $previousDebug
        $env:LECTURE_COPILOT_OLLAMA_TIMEOUT_MS = $previousTimeout
    }
}

$saved = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
if (-not $saved.ok) { throw "$Target smoke result is not successful." }
if ($Target -eq 'Server' -and -not $saved.stopped) { throw 'Server smoke result did not confirm shutdown.' }
if ($Target -eq 'Server' -and $RequireSttReady -and -not $saved.health.sttReady) { throw "Server smoke test found Whisper unready: $($saved.health.sttRuntime.message)" }
Write-Host "$Target smoke test passed. Result: $resultPath"
