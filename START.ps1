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
if (-not $env:PORT) { $env:PORT = '3000' }
if (-not $env:OLLAMA_URL) { $env:OLLAMA_URL = 'http://localhost:11434' }
if (-not $env:OLLAMA_MODEL) { $env:OLLAMA_MODEL = 'medis-nlg' }

Start-Process "http://localhost:$env:PORT" | Out-Null

# Run in current console so logs are visible
node server.js
