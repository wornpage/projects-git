# The same entrypoint runs locally and on the hosted runner. No deployment or secrets.
if ($PSVersionTable.PSVersion.Major -lt 7) { throw "CI requires PowerShell 7." }
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false
$ciImageTag = "projects-git-ci:verification-" + [Guid]::NewGuid().ToString("N")
New-Item -ItemType Directory -Force qa/ci | Out-Null
node scripts/ci-receipt.mjs init
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

function Invoke-CiCheck([string]$Name, [scriptblock]$Command) {
    $commandExit = 1
    New-Item -ItemType File -Force "qa/ci/$Name.log" | Out-Null
    node scripts/ci-receipt.mjs start $Name
    if ($LASTEXITCODE -ne 0) { return $false }
    try {
        & $Command 2>&1 | Tee-Object -FilePath "qa/ci/$Name.log" | Out-Host
        $commandExit = $LASTEXITCODE
    } catch {
        $_ | Out-String | Tee-Object -FilePath "qa/ci/$Name.log" -Append | Out-Host
    }
    node scripts/ci-receipt.mjs record $Name $commandExit
    $receiptExit = $LASTEXITCODE
    return ($commandExit -eq 0 -and $receiptExit -eq 0)
}

$installed = Invoke-CiCheck "install" { npm ci }
if ($installed) {
    Invoke-CiCheck "audit" { npm audit --json --audit-level=high } | Out-Null
    $imagesReady = Invoke-CiCheck "images" {
        docker build --network none --platform linux/amd64 --tag $ciImageTag containers/verification
        if ($LASTEXITCODE -eq 0) {
            $runtimeImage = (docker image inspect $ciImageTag --format "{{.Id}}").Trim()
            if ($LASTEXITCODE -ne 0 -or $runtimeImage -notmatch "^sha256:[a-f0-9]{64}$") { throw "Docker did not return an immutable image ID." }
            node scripts/ci-receipt.mjs image $runtimeImage
        }
    }
    if ($imagesReady) {
        $recordedImage = (Get-Content -Raw qa/ci/receipt.json | ConvertFrom-Json).runtime.image
        $env:PROJECTS_SANDBOX_TEST_IMAGE = $recordedImage
        $env:PROJECTS_PYTHON_TEST_IMAGE = $recordedImage
        $env:PROJECTS_HOSTED_TEST_IMAGE = $recordedImage
        Invoke-CiCheck "tests" { npm test } | Out-Null
    }
    Invoke-CiCheck "types" { npm run typecheck } | Out-Null
    Invoke-CiCheck "qualification-types" { node node_modules/typescript/bin/tsc -p tests/qualification/tsconfig.json --noEmit } | Out-Null
    Invoke-CiCheck "build" {
        npm run check:design
        if ($LASTEXITCODE -eq 0) { npm run build }
    } | Out-Null
}
node scripts/ci-receipt.mjs finish
exit $LASTEXITCODE
