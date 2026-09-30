# Run in a normal PowerShell terminal when the managed session cannot write .git.
# Publishes only the reviewed hosting migration and showcase follow-up files.
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
Push-Location -LiteralPath $projectRoot
try {
    function Invoke-Checked {
        param([string]$Program, [string[]]$Arguments)
        & $Program @Arguments
        if ($LASTEXITCODE -ne 0) { throw "$Program failed with exit code $LASTEXITCODE. Nothing further was run." }
    }

    $branch = & git branch --show-current
    if ($LASTEXITCODE -ne 0 -or $branch -ne 'main') { throw 'Run this from the FindFlower main checkout.' }
    $remote = & git remote get-url origin
    if ($LASTEXITCODE -ne 0 -or $remote -notin @('https://github.com/gsor56/findflower.git', 'git@github.com:gsor56/findflower.git')) {
        throw 'origin is not the FindFlower repository; inspect it before publishing.'
    }
    $paths = @(
        '.github/workflows/pages.yml', '.github/workflows/deploy.yml', '.gitignore',
        'proxy/worker.js', 'proxy/worker.test.mjs', 'proxy/wrangler.toml',
        'server/index.js', 'server/package.json', 'server/routes/identify.js', 'server/lib/public-assets.js',
        'scripts/hidencloud', 'scripts/sync-server-to-github.mjs',
        'scripts/generate-showcase/README.md', 'scripts/generate-showcase/playback.test.js',
        'scripts/generate-showcase/qa-shots.patch'
    )
    $staged = @(& git diff --cached --name-only)
    if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect staged files.' }
    foreach ($file in $staged) {
        if ($file -and $file -notin $paths -and -not $file.StartsWith('scripts/hidencloud/')) {
            throw "Unrelated staged file: $file. Publish it separately before running this script."
        }
    }

    # This is the remaining integration check that the managed session cannot spawn.
    Invoke-Checked node @('scripts/hidencloud/sync.integration.mjs')
    Invoke-Checked node @('scripts/hidencloud/deployment.test.mjs')
    Invoke-Checked node @('scripts/hidencloud/verify-live.test.mjs')
    Invoke-Checked node @('scripts/generate-showcase/contracts.test.js')
    Invoke-Checked node @('scripts/generate-showcase/playback.test.js')
    Invoke-Checked python @('-m', 'unittest', 'discover', '-s', 'scripts/hidencloud', '-p', '*_test.py')
    Invoke-Checked git (@('diff', '--check', '--') + $paths)

    # The retired workflow may already be absent from HEAD on a retry.
    $toStage = @()
    foreach ($item in $paths) {
        if (Test-Path -LiteralPath $item) { $toStage += $item; continue }
        $tracked = & git ls-files -- $item
        if ($LASTEXITCODE -ne 0) { throw "Cannot inspect $item." }
        if ($tracked) { $toStage += $item }
    }
    Invoke-Checked git (@('add', '--') + $toStage)
    Invoke-Checked git @('diff', '--cached', '--check')
    Invoke-Checked git @('diff', '--cached', '--stat')
    & git diff --cached --quiet
    $hasChanges = $LASTEXITCODE
    if ($hasChanges -eq 1) {
        Invoke-Checked git @('commit', '-m', 'Deploy FindFlower from HidenCloud and retire Pages')
    } elseif ($hasChanges -ne 0) { throw 'Cannot inspect the staged diff.' }

    # Uses the existing Windows Credential Manager; never force-pushes.
    Invoke-Checked git @('push', 'origin', 'main')
    Write-Host 'Published main. Configure the Actions secrets/variables in scripts/hidencloud/README.md to activate automatic deployment.'
} finally {
    Pop-Location
}
