# One-button bootstrap + run (Windows PowerShell)
# - Creates .venv (Python)
# - Installs requirements.txt
# - Installs npm dependencies
# - Starts Node server
# - Opens browser to http://localhost:3000

$ErrorActionPreference = 'Stop'

function Write-Step($msg) {
  Write-Host "`n==> $msg" -ForegroundColor Cyan
}

function Require-Command($name) {
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if (-not $cmd) {
    throw "Missing required command '$name'. Please install it and retry."
  }
}

function Get-PortOwnerInfo([int]$port) {
  try {
    $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop | Select-Object -First 1
    if ($c -and $c.OwningProcess) {
      $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
      if ($p) {
        return "PID $($p.Id) ($($p.ProcessName))"
      }
      return "PID $($c.OwningProcess)"
    }
  } catch {
    # ignore; cmdlet may not exist on older Windows or insufficient perms
  }
  return $null
}

function Test-PortFree([int]$port) {
  # Node/Express on Windows commonly binds to IPv6 (::). A port can look free on
  # 127.0.0.1 but still be in use on ::. So we test both stacks.
  try {
    $l4 = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, $port)
    $l4.Start()
    $l4.Stop()
  } catch {
    return $false
  }

  try {
    $l6 = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::IPv6Any, $port)
    # DualMode may not exist / be supported everywhere; best-effort only.
    try { $l6.Server.DualMode = $true } catch { }
    $l6.Start()
    $l6.Stop()
  } catch {
    # If IPv6 isn't supported, ignore. If it is supported and the port is in use,
    # this will throw and we correctly return $false.
    $msg = "$_"
    if ($msg -match 'Address family not supported') { return $true }
    return $false
  }

  return $true
}

function Pick-FreePort([int]$preferredPort, [int]$maxTries = 20) {
  for ($i = 0; $i -lt $maxTries; $i++) {
    $p = $preferredPort + $i
    if (Test-PortFree $p) { return $p }
  }
  throw "Could not find a free port starting from $preferredPort (tries=$maxTries)."
}

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

Write-Step "Checking prerequisites"
Require-Command node
Require-Command npm
Require-Command python

Write-Step "Python venv + requirements"
if (-not (Test-Path -Path ".\.venv\Scripts\python.exe")) {
  python -m venv .venv
}

& .\.venv\Scripts\python.exe -m pip install --upgrade pip
& .\.venv\Scripts\python.exe -m pip install -r requirements.txt

Write-Step "Node dependencies"
if (-not (Test-Path -Path ".\node_modules")) {
  npm install
} else {
  # Keep it simple; user can run npm install manually if needed.
  Write-Host "node_modules already exists; skipping npm install" -ForegroundColor DarkGray
}

Write-Step "Starting server"
$env:PORT = $env:PORT -as [string]
$preferredPort = 3000
if ($env:PORT) {
  try { $preferredPort = [int]$env:PORT } catch { $preferredPort = 3000 }
}

if (-not (Test-PortFree $preferredPort)) {
  $owner = Get-PortOwnerInfo $preferredPort
  $ownerMsg = if ($owner) { " ($owner)" } else { "" }
  Write-Host "Port $preferredPort is already in use$ownerMsg. Picking another port..." -ForegroundColor Yellow
  $preferredPort = Pick-FreePort -preferredPort ($preferredPort + 1) -maxTries 30
}

$env:PORT = "$preferredPort"
if (-not $env:OLLAMA_URL) { $env:OLLAMA_URL = 'http://localhost:11434' }
if (-not $env:OLLAMA_MODEL) { $env:OLLAMA_MODEL = 'medis-nlg' }

Start-Process "http://localhost:$env:PORT" | Out-Null

# Run in current console so logs are visible
node server.js
