[CmdletBinding()]
param(
    [switch]$InstallPrerequisites,
    [switch]$EnableOpenSsh,
    [string]$AuthorizedKey,
    [string]$AuthorizedKeyFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$artifactRoot = Join-Path $repoRoot 'debug-artifacts\windows'
New-Item -ItemType Directory -Force -Path $artifactRoot | Out-Null

function Test-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Refresh-Path {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machine;$user"
}

function Invoke-WingetInstall {
    param([string]$Id)
    & winget.exe install --id $Id --exact --silent --accept-package-agreements --accept-source-agreements --disable-interactivity
    if ($LASTEXITCODE -ne 0) { throw "winget failed to install $Id (exit $LASTEXITCODE)" }
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'This setup script must run inside Windows.'
}

if ($InstallPrerequisites) {
    if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
        throw 'winget is required for unattended prerequisite installation. Install App Installer from Microsoft, then rerun.'
    }
    $nodeMajor = 0
    if (Get-Command node.exe -ErrorAction SilentlyContinue) {
        $nodeMajor = [int]((& node.exe --version).TrimStart('v').Split('.')[0])
    }
    if ($nodeMajor -lt 20) { Invoke-WingetInstall 'OpenJS.NodeJS.LTS' }
    if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) { Invoke-WingetInstall 'Git.Git' }
    Refresh-Path
}

if ($EnableOpenSsh) {
    if (-not (Test-Administrator)) { throw 'EnableOpenSsh requires an elevated PowerShell window (Run as administrator).' }
    $capability = Get-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0'
    if ($capability.State -ne 'Installed') {
        Add-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0' | Out-Null
    }
    Set-Service -Name sshd -StartupType Automatic
    Start-Service sshd
    if (-not (Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH Server (sshd)' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 -Profile Any -RemoteAddress LocalSubnet | Out-Null
    } else {
        Set-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -Enabled True -Profile Any -RemoteAddress LocalSubnet
    }
    New-Item -Path 'HKLM:\SOFTWARE\OpenSSH' -Force | Out-Null
    New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -Value 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -PropertyType String -Force | Out-Null
}

if ($AuthorizedKeyFile) {
    $AuthorizedKey = (Get-Content -LiteralPath $AuthorizedKeyFile -Raw).Trim()
}
if ($AuthorizedKey) {
    if (-not (Test-Administrator)) { throw 'Installing an SSH key requires an elevated PowerShell window.' }
    if ($AuthorizedKey -notmatch '^ssh-(ed25519|rsa|ecdsa)\s+\S+') { throw 'The supplied SSH public key is not in OpenSSH public-key format.' }
    $administratorsKey = Join-Path $env:ProgramData 'ssh\administrators_authorized_keys'
    New-Item -ItemType Directory -Force -Path (Split-Path $administratorsKey) | Out-Null
    $existing = if (Test-Path $administratorsKey) { @(Get-Content -LiteralPath $administratorsKey) } else { @() }
    if ($existing -notcontains $AuthorizedKey) { Add-Content -LiteralPath $administratorsKey -Value $AuthorizedKey -Encoding ascii }
    & icacls.exe $administratorsKey /inheritance:r /grant '*S-1-5-32-544:F' /grant '*S-1-5-18:F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Unable to secure administrators_authorized_keys permissions.' }
    if (Get-Service sshd -ErrorAction SilentlyContinue) { Restart-Service sshd }
}

Refresh-Path
$nodeVersion = if (Get-Command node.exe -ErrorAction SilentlyContinue) { (& node.exe --version).Trim() } else { $null }
$npmVersion = if (Get-Command npm.cmd -ErrorAction SilentlyContinue) { (& npm.cmd --version).Trim() } else { $null }
$gitVersion = if (Get-Command git.exe -ErrorAction SilentlyContinue) { (& git.exe --version).Trim() } else { $null }
$tarVersion = if (Get-Command tar.exe -ErrorAction SilentlyContinue) { ((& tar.exe --version 2>&1) | Select-Object -First 1) } else { $null }
$sshd = Get-Service sshd -ErrorAction SilentlyContinue
$addresses = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '127.*' -and $_.AddressState -eq 'Preferred' } | Select-Object -ExpandProperty IPAddress)

if (-not $nodeVersion -or [int]($nodeVersion.TrimStart('v').Split('.')[0]) -lt 20) { throw 'Node.js 20 or newer is required.' }
if (-not $npmVersion) { throw 'npm is required.' }
if (-not $tarVersion) { throw 'Windows tar.exe is required for the macOS-to-Windows source bridge.' }

$result = [ordered]@{
    schemaVersion = 1
    configuredAt = (Get-Date).ToUniversalTime().ToString('o')
    computerName = $env:COMPUTERNAME
    userName = $env:USERNAME
    osArchitecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    processArchitecture = [System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString()
    node = $nodeVersion
    npm = $npmVersion
    git = $gitVersion
    tar = $tarVersion
    sshd = if ($sshd) { $sshd.Status.ToString() } else { 'NotInstalled' }
    ipv4 = $addresses
}
$result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $artifactRoot 'vm-setup.json') -Encoding UTF8
$result | Format-List
Write-Host "VM setup verification passed. Use one of these IP addresses for WINDOWS_VM_HOST: $($addresses -join ', ')"
