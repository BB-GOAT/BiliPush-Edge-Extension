# 打包已提交的扩展运行文件，本地包名默认带提交短哈希。
param(
  [Parameter(Mandatory = $true)][string]$OutputDirectory,
  [switch]$Release
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
& node (Join-Path $PSScriptRoot 'check.mjs')
if ($LASTEXITCODE -ne 0) { throw '检查失败，停止打包。' }
$manifest = Get-Content -Raw -Encoding utf8 -LiteralPath (Join-Path $projectRoot 'manifest.json') | ConvertFrom-Json
$revision = & git -C $projectRoot rev-parse HEAD
if ($LASTEXITCODE -ne 0) { throw '无法读取 Git 提交。' }
$changes = & git -C $projectRoot status --porcelain
if ($LASTEXITCODE -ne 0) { throw '无法读取 Git 状态。' }
if ($changes) { throw '请先提交修改，再打包，以便产物能对应准确的 Git 提交。' }

$stem = "BiliPush-Edge-$($manifest.version)"
if (-not $Release) {
  $short = & git -C $projectRoot rev-parse --short $revision
  if ($LASTEXITCODE -ne 0) { throw '无法读取提交短哈希。' }
  $stem += "-$short"
}
$outputRoot = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
$archivePath = Join-Path $outputRoot "$stem.zip"
if (Test-Path -LiteralPath $archivePath) { throw "目标文件已存在，不覆盖：$archivePath" }
& git -C $projectRoot archive --format=zip "--output=$archivePath" $revision -- manifest.json src/ assets/
if ($LASTEXITCODE -ne 0) { throw '无法生成扩展 ZIP。' }
Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath
