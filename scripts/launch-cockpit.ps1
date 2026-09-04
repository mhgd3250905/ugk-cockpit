param(
  [string]$RepoDirectory = '',
  [string]$LogDirectory = '',
  [string]$DataDirectory = '',
  [switch]$SkipBuild = $false,
  [switch]$NoPause = $false,
  [int]$TimeoutSeconds = 30,
  [int]$TestPort = 0,
  [string]$TestMainEntry = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Status {
  param(
    [string]$Tag,
    [string]$Message
  )
  Write-Output "[$Tag] $Message"
}

function Get-ListeningProcessId {
  param([int]$TargetPort)

  # Method 1: netstat.exe is available on every supported Windows host and
  # avoids a slow WMI query when the port is not listening.
  $netstatSucceeded = $false
  try {
    $lines = @(netstat.exe -ano -p tcp 2>$null)
    $netstatSucceeded = $true
    foreach ($line in $lines) {
      if ($line -match '^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$') {
        $p = [int]$matches[1]
        $candidatePid = [int]$matches[2]
        if ($p -eq $TargetPort -and $candidatePid -gt 0) {
          return $candidatePid
        }
      }
    }
  } catch {}

  if ($netstatSucceeded) {
    return $null
  }

  # Method 2: Get-NetTCPConnection (PowerShell 5.1+ NetTCPIP module)
  try {
    $connections = @(Get-NetTCPConnection -LocalPort $TargetPort -State Listen -ErrorAction SilentlyContinue)
    if ($connections.Count -gt 0) {
      $candidatePid = [int]$connections[0].OwningProcess
      if ($candidatePid -gt 0) {
        return $candidatePid
      }
    }
  } catch {}

  return $null
}

function Get-LockProcessId {
  param([string]$LockFilePath)

  if (-not (Test-Path -LiteralPath $LockFilePath)) {
    return $null
  }

  try {
    $lockText = (Get-Content -LiteralPath $LockFilePath -Raw -ErrorAction Stop)
    if ([string]::IsNullOrWhiteSpace($lockText)) {
      return $null
    }
    $lockJson = (ConvertFrom-Json $lockText -ErrorAction Stop)
    if ($null -eq $lockJson -or $null -eq $lockJson.pid) {
      return $null
    }
    $lockPid = 0
    if (-not [int]::TryParse([string]$lockJson.pid, [ref]$lockPid)) {
      return $null
    }
    if ($lockPid -le 0) {
      return $null
    }
    return $lockPid
  } catch {
    return $null
  }
}

function Test-ProcessIdAlive {
  param([int]$ProcessId)

  if ($ProcessId -le 0) {
    return $false
  }
  return $null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

function Stop-ExactProcessTree {
  param([int]$RootProcessId)

  try {
    Stop-Process -Id $RootProcessId -Force -ErrorAction SilentlyContinue
  } catch {}

  # Node's console host exits with the root process. Avoid a blocking recursive
  # WMI walk here; the root PID remains the only process we are authorized to stop.
}

function Invoke-HttpGet {
  param(
    [string]$Uri,
    [int]$TimeoutMs = 3000
  )
  try {
    $request = [System.Net.HttpWebRequest]::Create($Uri)
    $request.Timeout = $TimeoutMs
    $request.Method = 'GET'
    $request.KeepAlive = $false
    $response = $request.GetResponse()
    try {
      $stream = $response.GetResponseStream()
      $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
      try {
        $body = $reader.ReadToEnd()
        return @{
          Success = $true
          StatusCode = [int]$response.StatusCode
          Body = $body
        }
      } finally {
        $reader.Close()
      }
    } finally {
      $response.Close()
    }
  } catch [System.Net.WebException] {
    if ($null -ne $_.Exception.Response) {
      $httpResp = [System.Net.HttpWebResponse]$_.Exception.Response
      try {
        $stream = $httpResp.GetResponseStream()
        $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
        try {
          $body = $reader.ReadToEnd()
          return @{
            Success = $false
            StatusCode = [int]$httpResp.StatusCode
            Body = $body
          }
        } finally {
          $reader.Close()
        }
      } finally {
        $httpResp.Close()
      }
    }
    return @{
      Success = $false
      StatusCode = 0
      Body = ''
    }
  } catch {
    return @{
      Success = $false
      StatusCode = 0
      Body = ''
    }
  }
}

function Test-IsUgkCockpit {
  param(
    [int]$ProcessId,
    [int]$TargetPort,
    [string]$TargetHost,
    [string]$DataDir
  )

  $lockFilePath = Join-Path $DataDir 'service.lock'
  $maxAttempts = 4

  for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
    # Re-check the listener and lock together on every attempt. This tolerates
    # a short startup transition without weakening the PID binding.
    $currentListeningPid = (Get-ListeningProcessId -TargetPort $TargetPort)
    $lockPid = (Get-LockProcessId -LockFilePath $lockFilePath)

    if (($currentListeningPid -eq $ProcessId) -and ($lockPid -eq $ProcessId)) {
      $httpVerified = $false
      $healthUrl = "http://${TargetHost}:${TargetPort}/health"
      $healthResult = (Invoke-HttpGet -Uri $healthUrl -TimeoutMs 2500)
      if ($healthResult.Success -and $healthResult.StatusCode -eq 200) {
        try {
          $healthJson = (ConvertFrom-Json $healthResult.Body -ErrorAction SilentlyContinue)
          if ($null -ne $healthJson -and $healthJson.status -eq 'ok' -and (-not [string]::IsNullOrWhiteSpace($healthJson.version))) {
            $httpVerified = $true
          }
        } catch {}
      }

      if (-not $httpVerified) {
        $rootUrl = "http://${TargetHost}:${TargetPort}/"
        $rootResult = (Invoke-HttpGet -Uri $rootUrl -TimeoutMs 2500)
        if ($rootResult.StatusCode -eq 200 -and $rootResult.Body -match 'UGK Cockpit') {
          $httpVerified = $true
        } elseif ($rootResult.StatusCode -eq 503 -and $rootResult.Body -match 'SERVICE_UNAVAILABLE') {
          $httpVerified = $true
        }
      }

      if ($httpVerified) {
        return $true
      }
    }

    if ($attempt -lt $maxAttempts) {
      Start-Sleep -Milliseconds 250
    }
  }

  return $false
}

function Stop-UgkCockpitService {
  param(
    [int]$ProcessId,
    [int]$TargetPort,
    [string]$DataDir
  )

  Write-Status 'INFO' "Stopping verified UGK Cockpit service on port $TargetPort (PID: $ProcessId)..."

  # Terminate only this PID and its descendants. Never kill by image name.
  Stop-ExactProcessTree -RootProcessId $ProcessId

  # Wait for process to exit and port to be released
  $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
  $stopSucceeded = $false
  while ($stopwatch.ElapsedMilliseconds -lt 10000) {
    $procStillAlive = (Test-ProcessIdAlive -ProcessId $ProcessId)
    $portStillBusy = (Get-ListeningProcessId -TargetPort $TargetPort)
    if ((-not $procStillAlive) -and ($null -eq $portStillBusy)) {
      $stopSucceeded = $true
      break
    }
    Start-Sleep -Milliseconds 150
  }

  if (-not $stopSucceeded) {
    Write-Status 'ERROR' "Verified UGK Cockpit service (PID: $ProcessId) did not stop cleanly."
    Write-Status 'WHAT' 'The verified process or target listener is still present after the stop timeout.'
    Write-Status 'IMPACT' 'The existing service was not replaced. No other process was stopped.'
    Write-Status 'ACTION' "Inspect PID $ProcessId and port $TargetPort, then retry the launcher."
    throw "Unable to stop verified UGK Cockpit service PID $ProcessId."
  }

  # Clean up the lock file only after this exact PID is confirmed dead.
  $lockFilePath = Join-Path $DataDir 'service.lock'
  $lockPid = (Get-LockProcessId -LockFilePath $lockFilePath)
  if (($lockPid -eq $ProcessId) -and (-not (Test-ProcessIdAlive -ProcessId $ProcessId))) {
    Remove-Item -LiteralPath $lockFilePath -Force -ErrorAction SilentlyContinue
  }

  Write-Status 'OK' "Previous UGK Cockpit service (PID: $ProcessId) stopped successfully."
}

# --- Main Flow ---

# 1. Resolve repository directory
if ([string]::IsNullOrWhiteSpace($RepoDirectory)) {
  $RepoDirectory = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
} else {
  $RepoDirectory = (Resolve-Path -LiteralPath $RepoDirectory).Path
}

# 2. Resolve target port and host address
$defaultPort = 41737
$Port = if ($TestPort -ne 0) { $TestPort } else { $defaultPort }
if (($Port -lt 1) -or ($Port -gt 65535)) {
  Write-Status 'ERROR' "Invalid test port: $Port. The port must be between 1 and 65535."
  exit 1
}
$HostAddress = '127.0.0.1'

# 3. Resolve local data directory and log directory
if ([string]::IsNullOrWhiteSpace($DataDirectory)) {
  $localAppData = [Environment]::GetEnvironmentVariable('LOCALAPPDATA')
  if ([string]::IsNullOrWhiteSpace($localAppData)) {
    $localAppData = (Join-Path $env:USERPROFILE 'AppData\Local')
  }
  $DataDirectory = Join-Path $localAppData 'UGK Cockpit'
} else {
  $DataDirectory = [System.IO.Path]::GetFullPath($DataDirectory)
}

if (-not (Test-Path -LiteralPath $DataDirectory)) {
  $null = New-Item -ItemType Directory -Path $DataDirectory -Force
}

if ([string]::IsNullOrWhiteSpace($LogDirectory)) {
  $LogDirectory = Join-Path $DataDirectory 'logs'
} else {
  $LogDirectory = [System.IO.Path]::GetFullPath($LogDirectory)
}

if (-not (Test-Path -LiteralPath $LogDirectory)) {
  $null = New-Item -ItemType Directory -Path $LogDirectory -Force
}

# 4. Verify Node.js environment
if ($null -eq (Get-Command 'node' -ErrorAction SilentlyContinue)) {
  Write-Status 'ERROR' 'Node.js is not found in system PATH.'
  Write-Status 'WHAT' 'The "node" executable could not be resolved from PATH.'
  Write-Status 'IMPACT' 'Cannot start UGK Cockpit service.'
  Write-Status 'ACTION' 'Please install Node.js (version 24.15 recommended) and verify PATH.'
  exit 1
}

# 5. Synchronous frontend build BEFORE stopping existing verified service
if (-not $SkipBuild) {
  if ($null -eq (Get-Command 'npm' -ErrorAction SilentlyContinue)) {
    Write-Status 'ERROR' 'npm is not found in system PATH.'
    Write-Status 'WHAT' 'The "npm" command could not be resolved from PATH.'
    Write-Status 'IMPACT' 'Frontend assets cannot be built. Service was not started.'
    Write-Status 'ACTION' 'Please ensure npm is installed and accessible in PATH.'
    exit 1
  }

  Write-Status 'BUILD' 'Building frontend assets (npm run build:web)...'
  $buildExitCode = 0
  try {
    $buildProc = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/d', '/s', '/c', 'npm run build:web') -WorkingDirectory $RepoDirectory -NoNewWindow -Wait -PassThru
    $buildExitCode = $buildProc.ExitCode
  } catch {
    $buildExitCode = 1
  }

  if ($buildExitCode -ne 0) {
    Write-Status 'ERROR' "Frontend build failed with exit code $buildExitCode."
    Write-Status 'WHAT' 'Execution of "npm run build:web" failed.'
    Write-Status 'IMPACT' 'Existing service continues running. Workspace code and database are unaffected.'
    Write-Status 'ACTION' 'Run "npm run build:web" manually to inspect and resolve Vite build errors.'
    exit $buildExitCode
  }
  Write-Status 'OK' 'Frontend assets built successfully.'
}

# 6. Check port occupancy, identity verification, and stale lock cleanup
$existingPid = (Get-ListeningProcessId -TargetPort $Port)
if ($null -ne $existingPid) {
  $isUgk = (Test-IsUgkCockpit -ProcessId $existingPid -TargetPort $Port -TargetHost $HostAddress -DataDir $DataDirectory)
  if ($isUgk) {
    Stop-UgkCockpitService -ProcessId $existingPid -TargetPort $Port -DataDir $DataDirectory
  } else {
    $procName = 'Unknown'
    try {
      $pInfo = (Get-Process -Id $existingPid -ErrorAction SilentlyContinue)
      if ($null -ne $pInfo) {
        $procName = $pInfo.ProcessName
      }
    } catch {}

    Write-Status 'ERROR' "Port $Port is occupied by an unverified process."
    Write-Status 'WHAT' "Process $procName (PID: $existingPid) is listening on port $Port, but process info or HTTP response could not be verified as UGK Cockpit."
    Write-Status 'IMPACT' "The foreign process was not stopped. Workspace code and database are unaffected."
    Write-Status 'ACTION' "Please close the application using port $Port, or configure UGK Cockpit to use a different port."
    exit 1
  }
} else {
  # Port is not listening. Check for stale lock file.
  $lockFilePath = Join-Path $DataDirectory 'service.lock'
  if (Test-Path -LiteralPath $lockFilePath) {
    $stalePid = (Get-LockProcessId -LockFilePath $lockFilePath)

    if ($null -ne $stalePid) {
      $aliveProc = (Test-ProcessIdAlive -ProcessId $stalePid)
      if (-not $aliveProc) {
        Remove-Item -LiteralPath $lockFilePath -Force -ErrorAction SilentlyContinue
        Write-Status 'INFO' "Cleaned up stale service lock file (dead PID: $stalePid)."
      }
    } else {
      Write-Status 'INFO' 'Retained service lock file because no dead PID could be proven.'
    }
  }
}

# 7. Start service in background with Hidden window
$mainEntry = if (-not [string]::IsNullOrWhiteSpace($TestMainEntry)) {
  if ([System.IO.Path]::IsPathRooted($TestMainEntry)) {
    [System.IO.Path]::GetFullPath($TestMainEntry)
  } else {
    [System.IO.Path]::GetFullPath((Join-Path $RepoDirectory $TestMainEntry))
  }
} else {
  Join-Path (Join-Path $RepoDirectory 'src') 'main.mjs'
}

if (-not (Test-Path -LiteralPath $mainEntry)) {
  Write-Status 'ERROR' "Main entry point not found: $mainEntry"
  Write-Status 'WHAT' "The service file $mainEntry does not exist."
  Write-Status 'IMPACT' 'Service was not started.'
  Write-Status 'ACTION' 'Verify the repository structure and ensure src/main.mjs is present.'
  exit 1
}

$mainEntry = (Resolve-Path -LiteralPath $mainEntry).Path

$stdOutLog = Join-Path $LogDirectory 'service.log'
$stdErrLog = Join-Path $LogDirectory 'service.err.log'
$timestamp = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
Add-Content -LiteralPath $stdOutLog -Value "`r`n=== [${timestamp}] UGK Cockpit launcher starting (repo: ${RepoDirectory}) ==="

Write-Status 'START' 'Starting UGK Cockpit background service...'

$startParams = @{
  FilePath = 'node.exe'
  ArgumentList = @($mainEntry)
  WorkingDirectory = $RepoDirectory
  WindowStyle = 'Hidden'
  RedirectStandardOutput = $stdOutLog
  RedirectStandardError = $stdErrLog
  PassThru = $true
}

$serviceProc = Start-Process @startParams
$newPid = $serviceProc.Id

Write-Status 'INFO' "Service spawned in background (PID: $newPid, WindowStyle: Hidden)."
Write-Status 'WAIT' "Waiting for service to become ready at http://${HostAddress}:${Port}/..."

# 8. Wait for HTTP 200
$serviceUrl = "http://${HostAddress}:${Port}/"
$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$timeoutMs = $TimeoutSeconds * 1000
$isHealthy = $false

while ($stopwatch.ElapsedMilliseconds -lt $timeoutMs) {
  if ($serviceProc.HasExited) {
    $exitCode = $serviceProc.ExitCode
    $errSnippet = ''
    if (Test-Path -LiteralPath $stdErrLog) {
      $errSnippet = (Get-Content -LiteralPath $stdErrLog -Raw -ErrorAction SilentlyContinue)
    }
    if ([string]::IsNullOrWhiteSpace($errSnippet) -and (Test-Path -LiteralPath $stdOutLog)) {
      $errSnippet = (Get-Content -LiteralPath $stdOutLog -Tail 15 -ErrorAction SilentlyContinue | Out-String)
    }
    Write-Status 'ERROR' "UGK Cockpit service process exited unexpectedly with code $exitCode."
    Write-Status 'WHAT' 'Background Node.js process crashed during startup.'
    if (-not [string]::IsNullOrWhiteSpace($errSnippet)) {
      Write-Status 'DETAILS' $errSnippet.Trim()
    }
    Write-Status 'IMPACT' 'Service is not running. Workspace code and database are unaffected.'
    Write-Status 'ACTION' "Check logs at $stdOutLog and $stdErrLog for crash details."
    exit 1
  }

  $check = (Invoke-HttpGet -Uri $serviceUrl -TimeoutMs 1500)
  if ($check.Success -and $check.StatusCode -eq 200) {
    $isHealthy = $true
    break
  }

  Start-Sleep -Milliseconds 300
}

if (-not $isHealthy) {
  Stop-ExactProcessTree -RootProcessId $newPid
  Write-Status 'ERROR' "Service did not respond with HTTP 200 within $TimeoutSeconds seconds."
  Write-Status 'WHAT' "HTTP GET $serviceUrl timed out."
  Write-Status 'IMPACT' 'Service might be unresponsive or blocked.'
  Write-Status 'ACTION' "Check service logs at $stdOutLog and $stdErrLog."
  exit 1
}

Write-Status 'OK' 'UGK Cockpit is running in background.'
Write-Status 'URL' "http://${HostAddress}:${Port}/"
Write-Status 'PID' "$newPid"
Write-Status 'LOG' "$stdOutLog"
