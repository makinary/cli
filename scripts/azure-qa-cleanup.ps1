param([bool]$DryRun = $false)
$ErrorActionPreference = 'Stop'
# The deployer replaces only these identifiers, never credentials.
$Subscription = '__SUBSCRIPTION__'
$Group = '__GROUP__'
$EnvironmentId = '__ENVIRONMENT_ID__'
$ExpiresAt = '__EXPIRES_AT__'
if ($Group -notmatch '^rg-makinari-qa-[a-z0-9-]+$') { throw 'Invalid QA group' }
$headers = @{ 'X-IDENTITY-HEADER' = $env:IDENTITY_HEADER; 'Metadata' = 'True' }
$tokenUrl = $env:IDENTITY_ENDPOINT + '?resource=https://management.azure.com/'
$token = (Invoke-RestMethod -Uri $tokenUrl -Headers $headers).access_token
if (-not $token) { throw 'Managed identity unavailable' }
$auth = @{ Authorization = "Bearer $token" }
$uri = "https://management.azure.com/subscriptions/$Subscription/resourcegroups/${Group}?api-version=2021-04-01"
$resource = Invoke-RestMethod -Uri $uri -Headers $auth
if ($resource.tags.purpose -ne 'disposable-qa' -or $resource.tags.environmentId -ne $EnvironmentId -or $resource.tags.expiresAt -ne $ExpiresAt) {
    throw 'QA identity or expiration tags do not match; refusing deletion'
}
if ($DryRun) { Write-Output 'QA cleanup authorization verified; no resources deleted'; return }
if ([DateTimeOffset]::UtcNow -lt [DateTimeOffset]::Parse($ExpiresAt)) { throw 'Environment has not expired' }
# The identity is scoped to this one QA group. Azure runs this outside the VM.
Invoke-WebRequest -Uri $uri -Headers $auth -Method Delete -UseBasicParsing | Out-Null
Write-Output 'Expired QA resource-group deletion accepted'