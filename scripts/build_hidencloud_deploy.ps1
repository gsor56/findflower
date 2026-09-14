param(
    [string]$OutputName = 'findflower-deploy.zip'
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$serverRoot = Join-Path $repoRoot 'server'
$sessionPath = Join-Path $serverRoot 'session.js'
$envPath = Join-Path $serverRoot '.env'
$outputPath = Join-Path $repoRoot $OutputName
$legacyOutputPath = Join-Path $repoRoot 'server-deploy.zip'

$requiredFiles = @(
    'index.js', 'package.json', 'package-lock.json', '.env',
    'db.js', 'session.js', 'auth.js', 'lib.js', 'inference.js'
)
$requiredDirectories = @('routes', 'models', 'lib', 'views')
$frontendFiles = @(
    # Every navigable page, not just the ones with server-side data. The server
    # renders each of these for the session cookie, and a page missing from the
    # container is a page that falls back to the static shell.
    'index.html', '404.html', 'about.html', 'api.html', 'article.html',
    'blogs.html', 'community.html', 'contact.html', 'contribute.html',
    'dashboard.html', 'data.html', 'directory.html', 'docs.html',
    'feedback.html', 'how.html', 'login.html', 'pricing.html', 'privacy.html',
    'profile.html', 'releases.html', 'research.html', 'species.html',
    'terms.html', 'try.html',
    'app.css', 'auth.js', 'blur.js', 'directory.js', 'favicon.ico', 'favicon.svg',
    'footer.js', 'i18n.js', 'main.js', 'manifest.json', 'nav.js', 'prefs.js',
    'species.js', 'storage.js', 'sw.js', 'trefle-data.json',
    'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png',
    'robots.txt', 'sitemap.xml'
)
$frontendDirectories = @('assets', 'scripts', 'chat', 'notifications', 'articles', '.well-known')

foreach ($file in $requiredFiles) {
    $path = Join-Path $serverRoot $file
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Required backend file is missing: $path"
    }
}
foreach ($directory in $requiredDirectories) {
    $path = Join-Path $serverRoot $directory
    if (-not (Test-Path -LiteralPath $path -PathType Container)) {
        throw "Required backend directory is missing: $path"
    }
}
foreach ($file in $frontendFiles) {
    $path = Join-Path $repoRoot $file
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Required SSR frontend file is missing: $path"
    }
}
foreach ($directory in $frontendDirectories) {
    $path = Join-Path $repoRoot $directory
    if (-not (Test-Path -LiteralPath $path -PathType Container)) {
        throw "Required SSR frontend directory is missing: $path"
    }
}

# Refuse to recreate the pre-SSR bundle that caused production to boot without
# the OIDC middleware. These are behavior checks, not a version-number check.
$sessionSource = Get-Content -LiteralPath $sessionPath -Raw
foreach ($marker in @(
    '[auth] tenant=',
    "response_type: 'code'",
    'dotenv.config',
    'AUTH0_CLIENT_SECRET'
)) {
    if (-not $sessionSource.Contains($marker)) {
        throw "session.js is not deployment-ready; missing marker: $marker"
    }
}

$entrySource = Get-Content -LiteralPath (Join-Path $serverRoot 'index.js') -Raw
if (-not $entrySource.Contains("from './session.js'")) {
    throw 'index.js does not import the SSR Auth0 session middleware.'
}

$envNames = Get-Content -LiteralPath $envPath | ForEach-Object {
    if ($_ -match '^([A-Z0-9_]+)=') { $Matches[1] }
}
foreach ($name in @(
    'MONGO_URI', 'AUTH0_SECRET', 'AUTH0_BASE_URL',
    'AUTH0_ISSUER_BASE_URL', 'AUTH0_CLIENT_ID', 'AUTH0_CLIENT_SECRET',
    # Inference. HF_TOKEN fetches the private weights and PROXY_SECRET is what
    # the Worker authenticates with, so a bundle missing either one boots and
    # then refuses every scan.
    'HF_TOKEN', 'PROXY_SECRET'
)) {
    if ($name -notin $envNames) {
        throw ".env is missing required variable: $name"
    }
}

$stage = Join-Path ([IO.Path]::GetTempPath()) ('findflower-deploy-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null

try {
    foreach ($file in $requiredFiles) {
        Copy-Item -LiteralPath (Join-Path $serverRoot $file) -Destination (Join-Path $stage $file)
    }
    foreach ($directory in $requiredDirectories) {
        Copy-Item -LiteralPath (Join-Path $serverRoot $directory) -Destination (Join-Path $stage $directory) -Recurse
    }
    Copy-Item -LiteralPath (Join-Path $repoRoot 'class_names.json') -Destination (Join-Path $stage 'class_names.json')
    foreach ($file in $frontendFiles) {
        Copy-Item -LiteralPath (Join-Path $repoRoot $file) -Destination (Join-Path $stage $file)
    }
    foreach ($directory in $frontendDirectories) {
        Copy-Item -LiteralPath (Join-Path $repoRoot $directory) -Destination (Join-Path $stage $directory) -Recurse
    }

    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    if (Test-Path -LiteralPath $outputPath) { [IO.File]::Delete($outputPath) }

    # Create each entry explicitly. ZipFile.CreateFromDirectory preserves
    # Windows backslashes in this environment, which Linux extractors can
    # interpret as literal filename characters instead of path separators.
    $archive = [IO.Compression.ZipFile]::Open(
        $outputPath,
        [IO.Compression.ZipArchiveMode]::Create
    )
    try {
        $stagePrefix = $stage.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
        foreach ($sourceFile in Get-ChildItem -LiteralPath $stage -File -Recurse | Sort-Object FullName) {
            $relativePath = $sourceFile.FullName.Substring($stagePrefix.Length).Replace('\', '/')
            [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $archive,
                $sourceFile.FullName,
                $relativePath,
                [IO.Compression.CompressionLevel]::Optimal
            )
        }
    } finally {
        $archive.Dispose()
    }

    # HidenCloud was accidentally given this older filename. Keep it as a byte-
    # identical alias so selecting it in the upload panel cannot deploy stale
    # pre-SSR code again.
    if ($outputPath -ne $legacyOutputPath) {
        Copy-Item -LiteralPath $outputPath -Destination $legacyOutputPath -Force
    }

    foreach ($archivePath in @($outputPath, $legacyOutputPath)) {
        $archive = [IO.Compression.ZipFile]::OpenRead($archivePath)
        try {
            $names = @($archive.Entries | ForEach-Object { $_.FullName })
            if ($names | Where-Object { $_.Contains('\') }) {
                throw "Archive contains Windows-style entry separators: $archivePath"
            }
            foreach ($required in @(
                '.env', 'index.js', 'package.json', 'package-lock.json',
                'db.js', 'session.js', 'auth.js', 'lib.js', 'inference.js', 'class_names.json'
            )) {
                if ($required -notin $names) {
                    throw "Archive is not flat or is missing $required`: $archivePath"
                }
            }
            foreach ($directory in $requiredDirectories) {
                if (-not ($names | Where-Object { $_.StartsWith("$directory/") })) {
                    throw "Archive is missing the $directory/ directory: $archivePath"
                }
            }
            foreach ($required in $frontendFiles) {
                if ($required -notin $names) {
                    throw "Archive is missing required SSR frontend file $required`: $archivePath"
                }
            }
            foreach ($directory in $frontendDirectories) {
                if (-not ($names | Where-Object { $_.StartsWith("$directory/") })) {
                    throw "Archive is missing required SSR frontend directory $directory/`: $archivePath"
                }
            }
            if ($names | Where-Object { $_ -match '(^|/)(node_modules|\.git|proxy)(/|$)' }) {
                throw "Archive contains a forbidden directory: $archivePath"
            }
        } finally {
            $archive.Dispose()
        }
    }

    $hash = (Get-FileHash -LiteralPath $outputPath -Algorithm SHA256).Hash
    Write-Output "Built $outputPath"
    Write-Output "Mirrored $legacyOutputPath"
    Write-Output "SHA256 $hash"
} finally {
    if (Test-Path -LiteralPath $stage) {
        Remove-Item -LiteralPath $stage -Recurse -Force
    }
}
