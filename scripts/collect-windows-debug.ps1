[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ArtifactDirectory,
    [ValidateSet('pre', 'post', 'failure', 'manual')]
    [string]$Phase = 'manual'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$destination = [System.IO.Path]::GetFullPath($ArtifactDirectory)
New-Item -ItemType Directory -Force -Path $destination | Out-Null

function Try-Value {
    param([scriptblock]$Operation)
    try { return & $Operation } catch { return [ordered]@{ error = $_.Exception.Message } }
}

function Command-Version {
    param([string]$Name, [string[]]$Arguments)
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $command) { return $null }
    try { return ((& $command.Source @Arguments 2>&1) -join "`n").Trim() } catch { return $_.Exception.Message }
}

$interestingNames = @('node.exe', 'electron.exe', 'Local Lecture Copilot.exe', 'whisper-cli.exe')
$processes = Try-Value {
    $memoryById = @{}
    Get-Process -ErrorAction SilentlyContinue | ForEach-Object {
        $memoryById[[int]$_.Id] = $_
    }
    Get-CimInstance Win32_Process | Where-Object { $interestingNames -contains $_.Name } | ForEach-Object {
        $memory = $memoryById[[int]$_.ProcessId]
        [ordered]@{
            name = $_.Name
            processId = [int]$_.ProcessId
            parentProcessId = [int]$_.ParentProcessId
            executablePath = $_.ExecutablePath
            created = $_.CreationDate
            workingSetBytes = if ($memory) { [int64]$memory.WorkingSet64 } else { $null }
            privateMemoryBytes = if ($memory) { [int64]$memory.PrivateMemorySize64 } else { $null }
        }
    }
}

$listeners = Try-Value {
    if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
        Get-NetTCPConnection -State Listen -ErrorAction Stop |
            Where-Object { $_.LocalAddress -in @('127.0.0.1', '::1', '0.0.0.0', '::') } |
            Select-Object LocalAddress, LocalPort, OwningProcess
    } else { @() }
}

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimeRoot = Join-Path $repoRoot 'runtime\stt\win32-x64'
$releaseRoot = Join-Path $repoRoot 'release'
$source = Try-Value {
    $manifest = Join-Path $repoRoot '.windows-validation-source.json'
    if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { return $null }
    Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
}
$fileInventory = Try-Value {
    @($runtimeRoot, $releaseRoot) | ForEach-Object {
        if (Test-Path $_) {
            Get-ChildItem -Path $_ -File -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
                [ordered]@{
                    path = $_.FullName.Substring($repoRoot.Length).TrimStart('\')
                    bytes = [int64]$_.Length
                    modified = $_.LastWriteTimeUtc.ToString('o')
                }
            }
        }
    }
}

$crashDumps = Try-Value {
    $crashRoot = Join-Path $env:LOCALAPPDATA 'CrashDumps'
    if (-not (Test-Path $crashRoot)) { return @() }
    Get-ChildItem -Path $crashRoot -File -Filter '*.dmp' -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match 'Local Lecture Copilot|electron|whisper-cli' } |
        Select-Object FullName, Length, LastWriteTimeUtc
}

$git = Try-Value {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { return $null }
    Push-Location $repoRoot
    try {
        return [ordered]@{
            branch = ((& git branch --show-current 2>$null) -join '').Trim()
            commit = ((& git rev-parse HEAD 2>$null) -join '').Trim()
            status = @(& git status --short 2>$null)
        }
    } finally { Pop-Location }
}

$os = Try-Value { Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber, OSArchitecture, LastBootUpTime }
$computer = Try-Value { Get-CimInstance Win32_ComputerSystem | Select-Object Manufacturer, Model, TotalPhysicalMemory, NumberOfLogicalProcessors }
$processor = Try-Value { Get-CimInstance Win32_Processor | Select-Object Name, Architecture, AddressWidth, NumberOfCores, NumberOfLogicalProcessors }

$payload = [ordered]@{
    schemaVersion = 1
    phase = $Phase
    collectedAt = (Get-Date).ToUniversalTime().ToString('o')
    machineName = $env:COMPUTERNAME
    os = $os
    computer = $computer
    processor = $processor
    powershell = $PSVersionTable.PSVersion.ToString()
    processArchitecture = [System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString()
    osArchitecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    node = Command-Version 'node' @('--version')
    npm = Command-Version 'npm.cmd' @('--version')
    gitVersion = Command-Version 'git' @('--version')
    repoRoot = $repoRoot
    source = $source
    git = $git
    processes = $processes
    listeners = $listeners
    files = $fileInventory
    crashDumps = $crashDumps
}

$jsonPath = Join-Path $destination "diagnostics-$Phase.json"
$textPath = Join-Path $destination "diagnostics-$Phase.txt"
$payload | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $jsonPath -Encoding UTF8

@(
    "Windows diagnostics ($Phase)"
    "Collected: $($payload.collectedAt)"
    "OS architecture: $($payload.osArchitecture)"
    "Process architecture: $($payload.processArchitecture)"
    "PowerShell: $($payload.powershell)"
    "Node: $($payload.node)"
    "npm: $($payload.npm)"
    "Interesting processes: $(@($processes).Count)"
    "Loopback/all-interface listeners: $(@($listeners).Count)"
    "Runtime/release files: $(@($fileInventory).Count)"
    "Relevant crash dumps: $(@($crashDumps).Count)"
) | Set-Content -LiteralPath $textPath -Encoding UTF8

Write-Host "Windows diagnostics written to $jsonPath"
