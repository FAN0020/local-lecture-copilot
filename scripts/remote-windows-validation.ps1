[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Archive,
    [Parameter(Mandatory = $true)]
    [string]$ExpectedSnapshotId,
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-fA-F0-9]{64}$')]
    [string]$ExpectedArchiveSha256,
    [ValidateSet('Quick', 'Full')]
    [string]$Mode = 'Full',
    [switch]$SkipInstaller
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$archivePath = [System.IO.Path]::GetFullPath($Archive)
if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) { throw "Source archive not found: $archivePath" }
$bridgeRoot = Split-Path $archivePath
$repoRoot = Join-Path $bridgeRoot 'repo'
$resultZip = Join-Path $bridgeRoot 'windows-results.zip'
$exitCodeFile = Join-Path $bridgeRoot 'windows-exit-code.txt'

foreach ($staleResult in @($resultZip, $exitCodeFile)) {
    if (Test-Path -LiteralPath $staleResult) { Remove-Item -LiteralPath $staleResult -Force }
}
$archiveSha256 = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($archiveSha256 -ne $ExpectedArchiveSha256.ToLowerInvariant()) {
    throw "Source archive checksum mismatch: expected $ExpectedArchiveSha256, received $archiveSha256"
}

if (Test-Path -LiteralPath $repoRoot) { Remove-Item -LiteralPath $repoRoot -Recurse -Force }
New-Item -ItemType Directory -Force -Path $repoRoot | Out-Null
& tar.exe -xzf $archivePath -C $repoRoot
if ($LASTEXITCODE -ne 0) { throw "tar.exe could not extract the source archive (exit $LASTEXITCODE)." }

$sourceManifestPath = Join-Path $repoRoot '.windows-validation-source.json'
if (-not (Test-Path -LiteralPath $sourceManifestPath -PathType Leaf)) { throw 'The source archive has no provenance manifest.' }
$sourceManifest = Get-Content -LiteralPath $sourceManifestPath -Raw | ConvertFrom-Json
if ($sourceManifest.snapshotId -ne $ExpectedSnapshotId) {
    throw "Source snapshot mismatch: expected $ExpectedSnapshotId, received $($sourceManifest.snapshotId)"
}
& node.exe (Join-Path $repoRoot 'scripts\windows-source-provenance.js') verify-source --repo $repoRoot --manifest $sourceManifestPath
if ($LASTEXITCODE -ne 0) { throw "Extracted source verification failed with exit code $LASTEXITCODE." }
$sourceManifest.archiveSha256 = $archiveSha256
$sourceManifest | Add-Member -NotePropertyName receivedAt -NotePropertyValue ((Get-Date).ToUniversalTime().ToString('o')) -Force
$sourceManifest | Add-Member -NotePropertyName windowsWorkspace -NotePropertyValue $repoRoot -Force
$sourceManifest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $sourceManifestPath -Encoding UTF8

$harness = Join-Path $repoRoot 'scripts\test-windows.ps1'
if (-not (Test-Path -LiteralPath $harness -PathType Leaf)) { throw 'The transferred source does not contain scripts\test-windows.ps1.' }

$arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $harness, '-Mode', $Mode)
if ($SkipInstaller) { $arguments += '-SkipInstaller' }
& powershell.exe @arguments
$validationExitCode = $LASTEXITCODE

$artifacts = Join-Path $repoRoot 'debug-artifacts\windows'
if (-not (Test-Path -LiteralPath $artifacts)) {
    New-Item -ItemType Directory -Force -Path $artifacts | Out-Null
    "Windows harness exited with $validationExitCode before creating diagnostics." | Set-Content -LiteralPath (Join-Path $artifacts 'bridge-failure.txt') -Encoding UTF8
}
Compress-Archive -Path (Join-Path $artifacts '*') -DestinationPath $resultZip -CompressionLevel Optimal -Force
$validationExitCode | Set-Content -LiteralPath $exitCodeFile -Encoding ascii
Write-Host "REMOTE_WINDOWS_RESULTS=$resultZip"
Write-Host "REMOTE_WINDOWS_EXIT_CODE=$validationExitCode"
Write-Host "REMOTE_WINDOWS_SNAPSHOT=$ExpectedSnapshotId"
exit $validationExitCode
