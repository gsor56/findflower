#!/usr/bin/env pwsh
<##
.SYNOPSIS
    Push the prepared Find10K federation shard packages to Kaggle.

.DESCRIPTION
    Authentication is delegated to the locally configured Kaggle CLI. This
    script never reads or prints API keys, usernames, email addresses, or
    passwords. Shards 00-03 are pushed by default; pass -IncludeShard04 when
    the account has capacity for a fifth concurrent kernel.
#>

[CmdletBinding()]
param(
    [string]$PackageRoot = "training",
    [switch]$IncludeShard04
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not (Get-Command kaggle -ErrorAction SilentlyContinue)) {
    throw "The Kaggle CLI is not installed or is not available on PATH."
}

$shardNames = @("find10k-federation-kernel-00", "find10k-federation-kernel-01", "find10k-federation-kernel-02", "find10k-federation-kernel-03")
if ($IncludeShard04) {
    $shardNames += "find10k-federation-kernel-04"
}

foreach ($shardName in $shardNames) {
    $packagePath = Join-Path -Path $PackageRoot -ChildPath $shardName
    $metadataPath = Join-Path -Path $packagePath -ChildPath "kernel-metadata.json"

    if (-not (Test-Path -LiteralPath $packagePath -PathType Container)) {
        throw "Shard package not found: $packagePath"
    }
    if (-not (Test-Path -LiteralPath $metadataPath -PathType Leaf)) {
        throw "Shard metadata not found: $metadataPath"
    }

    Write-Host "Pushing $shardName..."
    $pushOutput = & kaggle kernels push -p $packagePath 2>&1
    $pushOutput | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0) {
        throw "Kaggle push failed for $shardName (exit code $LASTEXITCODE)."
    }
    if ($pushOutput -match "Kernel push error|Error:") {
        throw "Kaggle push failed for $shardName."
    }
}

Write-Host ("Pushed {0} shard package(s)." -f $shardNames.Count)
