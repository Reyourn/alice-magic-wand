param([ValidateRange(1024,65535)][int]$Port = 4310, [switch]$NoBrowser, [switch]$SkipBuild, [string]$DataDir, [string]$BuildDirectory)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
function Resolve-ProjectPath([string]$Value) {
    if ([IO.Path]::IsPathRooted($Value)) { return [IO.Path]::GetFullPath($Value) }
    return [IO.Path]::GetFullPath((Join-Path $projectRoot $Value))
}
$requestedDataDir = -not [string]::IsNullOrWhiteSpace($DataDir)
$requestedBuild = -not [string]::IsNullOrWhiteSpace($BuildDirectory)
$effectiveDataDir = if ($requestedDataDir) { Resolve-ProjectPath $DataDir } elseif ($env:WORKBENCH_DATA_DIR) { Resolve-ProjectPath $env:WORKBENCH_DATA_DIR } else { Join-Path $env:USERPROFILE '.agent-workbench' }
$buildRoot = if ($requestedBuild) { Resolve-ProjectPath $BuildDirectory } else { Join-Path $projectRoot 'dist' }
# Vite's output cleanup must never target the source checkout or arbitrary user folders.
if (-not $SkipBuild -and $requestedBuild -and -not $buildRoot.StartsWith((Join-Path $projectRoot '.workbench') + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'A custom build output must be inside this project''s .workbench directory. Use -SkipBuild for an existing build elsewhere.'
}
$stateDirectory = Join-Path $projectRoot '.workbench'
New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
$serviceUrl = "http://127.0.0.1:$Port"
try { $health = Invoke-RestMethod "$serviceUrl/api/health" -TimeoutSec 2 } catch { $health = $null }
if ($health -and $health.app -eq 'agent-workbench') {
    if ($requestedDataDir -or $requestedBuild) {
        $receiptPath = Join-Path $stateDirectory 'server-process.json'
        $receipt = if (Test-Path -LiteralPath $receiptPath) { Get-Content -Raw -LiteralPath $receiptPath | ConvertFrom-Json } else { $null }
        if (-not $receipt -or [int]$receipt.pid -ne [int]$health.pid) { throw 'Cannot verify the running instance configuration. Use another port or stop the existing instance explicitly.' }
        if ($requestedDataDir -and $receipt.dataDir -ne $effectiveDataDir) { throw 'The running instance uses a different data directory. Use another port or stop it explicitly.' }
        if ($requestedBuild -and $receipt.entry -ne (Join-Path $buildRoot 'server\index.js')) { throw 'The running instance uses a different build. Stop it explicitly before switching versions.' }
    }
    Write-Output "Agent Workbench is already available at $serviceUrl"
    if (-not $NoBrowser) { Start-Process $serviceUrl }
    exit 0
}
$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listener) { throw "Port $Port belongs to another service. Select a different -Port." }
$nodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
& $nodeExecutable --input-type=module -e "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(':memory:'); db.close();"
if ($LASTEXITCODE -ne 0) { throw 'Node.js with node:sqlite support is required (Node 22.13+). Please install a current supported Node release.' }
if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) { throw 'Git was not found. Install Git for Windows and open a new terminal.' }
$beadsFallback = Join-Path $env:LOCALAPPDATA 'Programs\beads-v1.3.0\bd.exe'
if (-not (Get-Command bd -ErrorAction SilentlyContinue) -and -not (Test-Path -LiteralPath $beadsFallback) -and -not ($env:WORKBENCH_BD_PATH -and (Test-Path -LiteralPath $env:WORKBENCH_BD_PATH))) { Write-Warning 'Beads (bd) was not found. Project task operations require Beads.' }
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw 'npm.cmd was not found. Check the Node.js installation.' }
Push-Location $projectRoot
try {
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules'))) {
        & npm.cmd ci
        if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
    }
    if (-not $SkipBuild) {
        if ($requestedBuild) {
            & $nodeExecutable (Join-Path $projectRoot 'node_modules\typescript\bin\tsc') -p tsconfig.server.json --outDir $buildRoot
            if ($LASTEXITCODE -ne 0) { throw 'Server build failed.' }
            & $nodeExecutable (Join-Path $projectRoot 'node_modules\vite\bin\vite.js') build --outDir (Join-Path $buildRoot 'public')
        } else { & npm.cmd run build }
        if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
    }
    $serverEntry = Join-Path $buildRoot 'server\index.js'
    if (-not (Test-Path -LiteralPath $serverEntry)) { throw 'Server build missing.' }
    $oldPort = $env:WORKBENCH_PORT
    $oldDataDir = $env:WORKBENCH_DATA_DIR
    $env:WORKBENCH_PORT = "$Port"
    $env:WORKBENCH_DATA_DIR = $effectiveDataDir
    try {
        $process = Start-Process -FilePath $nodeExecutable -ArgumentList @('"' + $serverEntry + '"') -WorkingDirectory $projectRoot -RedirectStandardOutput (Join-Path $stateDirectory 'server.stdout.log') -RedirectStandardError (Join-Path $stateDirectory 'server.stderr.log') -WindowStyle Hidden -PassThru
    } finally { $env:WORKBENCH_PORT = $oldPort; $env:WORKBENCH_DATA_DIR = $oldDataDir }
    @{ pid = $process.Id; executable = $nodeExecutable; nodeVersion = (& $nodeExecutable -v); entry = $serverEntry; dataDir = $effectiveDataDir; buildDirectory = $buildRoot; url = $serviceUrl; startedAt = [DateTimeOffset]::Now.ToString('o'); launchedByPid = $PID } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stateDirectory 'server-process.json') -Encoding utf8
    $started = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Milliseconds 500
        if ($process.HasExited) { throw "Server exited. Inspect $stateDirectory\server.stderr.log." }
        try { $health = Invoke-RestMethod "$serviceUrl/api/health" -TimeoutSec 2; if ($health.app -eq 'agent-workbench') { $started = $true; break } } catch { }
    }
    if (-not $started) { throw "Server is not ready. Inspect $stateDirectory\server.stderr.log." }
    Write-Output "Agent Workbench: $serviceUrl"
    if (-not $NoBrowser) { Start-Process $serviceUrl }
} finally { Pop-Location }
