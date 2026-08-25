param([string]$Base = 'http://127.0.0.1:3080')

$ErrorActionPreference = 'Stop'
$secureKey = Read-Host -AsSecureString
$apiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey))
if ([string]::IsNullOrWhiteSpace($apiKey)) { throw 'Missing API key on stdin' }
$providerId = 'live-e2e'
$modelId = 'stealth/ox-alpha'
$artifactName = 'tcode-live-provider-e2e.txt'
$session = $null
$artifactPath = $null

function Invoke-Json([string]$Method, [string]$Uri, $Body = $null) {
  $args = @{ Method = $Method; Uri = $Uri; UseBasicParsing = $true }
  if ($null -ne $Body) {
    $args.ContentType = 'application/json'
    $args.Body = ($Body | ConvertTo-Json -Depth 20 -Compress)
  }
  $response = Invoke-WebRequest @args
  if ([string]::IsNullOrWhiteSpace($response.Content)) { return $null }
  return $response.Content | ConvertFrom-Json
}

try {
  $remoteHeaders = @{ Authorization = "Bearer $apiKey" }
  $remoteModels = Invoke-WebRequest -Method Get -Uri 'https://ai.txcxgzs.com/v1/models' -Headers $remoteHeaders -UseBasicParsing
  $modelPayload = $remoteModels.Content | ConvertFrom-Json
  if (-not ($modelPayload.data | Where-Object { $_.id -eq $modelId })) { throw 'Requested model is not advertised by /models' }

  Invoke-Json Put "$Base/api/model-profiles/$providerId" @{
    name = 'Live E2E'
    baseUrl = 'https://ai.txcxgzs.com/v1'
    protocol = 'chat-completions'
    models = @(@{ id = $modelId; name = $modelId })
  } | Out-Null
  Invoke-Json Put "$Base/api/credentials/$providerId" @{ apiKey = $apiKey } | Out-Null

  $workspace = (Invoke-Json Get "$Base/api/workspaces" | Where-Object { $_.path -eq (Get-Location).Path } | Select-Object -First 1)
  if ($null -eq $workspace) { throw 'Current workspace is not registered' }
  $artifactPath = Join-Path $workspace.path $artifactName
  if (Test-Path -LiteralPath $artifactPath) { Remove-Item -LiteralPath $artifactPath -Force }

  $session = Invoke-Json Post "$Base/api/sessions" @{ workspacePath = $workspace.path; permissionMode = 'workspace-write' }
  $run = Invoke-Json Post "$Base/api/runs" @{
    credentialId = $providerId
    task = @{
      sessionId = $session.id
      prompt = "Create exactly one file named $artifactName containing exactly TCODE_LIVE_PROVIDER_OK followed by a newline. Use str_replace_editor for the file change, then use pwsh to verify its exact content. Do not modify any other file."
      workspace = $workspace.path
      modelProfile = @{
        baseUrl = 'https://ai.txcxgzs.com/v1'
        model = $modelId
        protocol = 'chat-completions'
        maxOutputTokens = 4096
        contextBudget = 120000
      }
      setup = @()
      grader = @("if ((Get-Content -Raw -LiteralPath '$artifactName') -ne ('TCODE_LIVE_PROVIDER_OK' + [char]10)) { throw 'artifact mismatch' }")
      timeout = 300000
      toolTimeout = 300000
      permissionMode = 'workspace-write'
      network = $true
      maxTurns = 12
      variant = 'live-provider-e2e'
    }
  }

  $deadline = (Get-Date).AddMinutes(5)
  do {
    Start-Sleep -Milliseconds 750
    $current = Invoke-Json Get "$Base/api/runs/$($run.id)"
    if ($current.status -in @('completed', 'failed', 'cancelled')) { break }
  } while ((Get-Date) -lt $deadline)
  if ($current.status -ne 'completed') { throw "Run ended with status $($current.status): $($current.error)" }

  $events = @(Invoke-Json Get "$Base/api/runs/$($run.id)/events.json")
  $types = @($events | ForEach-Object { $_.type })
  $toolNames = @($events | Where-Object { $_.type -eq 'tool_call' } | ForEach-Object { $_.data.name })
  if (-not ($types -contains 'model_request' -and $types -contains 'model_first_token' -and $types -contains 'model_response')) { throw 'Missing real model trace events' }
  if (-not ($toolNames -contains 'str_replace_editor' -and $toolNames -contains 'pwsh')) { throw 'Model did not exercise both required tools' }
  if (-not (Test-Path -LiteralPath $artifactPath)) { throw 'Artifact was not created' }
  if ((Get-Content -Raw -LiteralPath $artifactPath) -ne "TCODE_LIVE_PROVIDER_OK`n") { throw 'Artifact content mismatch' }
  $download = Invoke-WebRequest -Method Get -Uri "$Base/api/runs/$($run.id)/artifact?path=$artifactName" -UseBasicParsing
  if ($download.Content -ne "TCODE_LIVE_PROVIDER_OK`n") { throw 'Artifact download mismatch' }
  $serialized = $events | ConvertTo-Json -Depth 20 -Compress
  if ($serialized.Contains($apiKey)) { throw 'API key leaked into trace events' }

  [pscustomobject]@{
    remoteModels = 'ok'
    modelAdvertised = $true
    runStatus = $current.status
    grader = ($types -contains 'grader_result')
    modelFirstToken = ($types -contains 'model_first_token')
    tools = $toolNames | Select-Object -Unique
    artifactDownload = 'ok'
    traceSecretFree = $true
  } | ConvertTo-Json -Depth 5 -Compress
}
finally {
  if ($null -ne $session) {
    try { Invoke-Json Post "$Base/api/sessions/$($session.id)/archive" @{} | Out-Null } catch {}
    try { Invoke-Json Delete "$Base/api/sessions/archived" @{ ids = @($session.id) } | Out-Null } catch {}
  }
  if ($null -ne $artifactPath -and (Test-Path -LiteralPath $artifactPath)) { Remove-Item -LiteralPath $artifactPath -Force }
  $apiKey = $null
}
