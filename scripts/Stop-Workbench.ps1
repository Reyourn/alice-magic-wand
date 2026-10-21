param([switch]$ConfirmRunning)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$receiptPath = Join-Path $projectRoot '.workbench\server-process.json'
if (-not (Test-Path -LiteralPath $receiptPath)) { Write-Output 'No managed server receipt.'; exit 0 }
$receipt = Get-Content -Raw -LiteralPath $receiptPath | ConvertFrom-Json
$receiptPort = 0
try { $receiptPort = ([Uri]$receipt.url).Port } catch { $receiptPort = 0 }
$serverProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$receipt.pid)" -ErrorAction SilentlyContinue
if (-not $serverProcess) {
    # A stale receipt must not be reported as "stopped" while the port is still held.
    $staleListener = if ($receiptPort -gt 0) { Get-NetTCPConnection -LocalPort $receiptPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 } else { $null }
    if ($staleListener) {
        Write-Output ("Process receipt is stale: PID {0} is gone, but port {1} is held by PID {2}. That instance was not started from this receipt, so it was not stopped. Verify its identity before stopping it." -f $receipt.pid, $receiptPort, $staleListener.OwningProcess)
        exit 1
    }
    Write-Output 'Server already stopped; the receipt PID is gone and its port is free.'
    exit 0
}
if ($serverProcess.ExecutablePath -ne $receipt.executable -or -not $serverProcess.CommandLine.Contains($receipt.entry)) { throw 'Process identity changed; refusing to stop it.' }
$serviceUrl = [Uri]$receipt.url
if ($serviceUrl.Scheme -ne 'http' -or $serviceUrl.Host -ne '127.0.0.1') { throw 'Invalid local server URL in process receipt.' }
$health = Invoke-RestMethod "$($receipt.url)/api/health" -TimeoutSec 3
if ($health.app -ne 'agent-workbench' -or [int]$health.pid -ne [int]$receipt.pid) { throw 'Server identity does not match the process receipt.' }
$state = Invoke-RestMethod "$($receipt.url)/api/state" -TimeoutSec 15
$running = @($state.agents | Where-Object { $_.state -in @('starting','running','waiting_approval','interrupting') })
if ($running.Count -gt 0) {
    Write-Warning ("Stopping the backend interrupts {0} active member(s). Code and records remain; uncertain turns require recovery after restart. Closing the browser alone keeps them running." -f $running.Count)
    if (-not $ConfirmRunning) {
        $answer = Read-Host 'Stop the backend now? Type STOP to confirm'
        if ($answer -cne 'STOP') { Write-Output 'Backend remains running.'; exit 0 }
    }
}
$bootstrap = Invoke-RestMethod "$($receipt.url)/api/bootstrap" -TimeoutSec 3
Invoke-RestMethod "$($receipt.url)/api/shutdown" -Method Post -Headers @{ 'X-Workbench-Token' = $bootstrap.token } -ContentType 'application/json' -Body '{}' -TimeoutSec 10 | Out-Null
for ($attempt = 0; $attempt -lt 60; $attempt++) {
    if (-not (Get-Process -Id ([int]$receipt.pid) -ErrorAction SilentlyContinue)) {
        $stillListening = if ($receiptPort -gt 0) { Get-NetTCPConnection -LocalPort $receiptPort -State Listen -ErrorAction SilentlyContinue } else { $null }
        if ($stillListening) { throw "Process $($receipt.pid) exited, but port $receiptPort is still listening. Inspect the server log before starting another instance." }
        Write-Output 'Workbench stopped gracefully; its port is released. Task records, worktrees and native conversation history are preserved.'
        exit 0
    }
    Start-Sleep -Milliseconds 500
}
throw 'Graceful shutdown is still in progress. Inspect the server log; no process was force-killed.'
