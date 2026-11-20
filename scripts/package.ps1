# 正式 ZIP 由调用者指定保存目录；暂存文件仅写入项目专用临时目录。
param([Parameter(Mandatory = $true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
& node (Join-Path $PSScriptRoot 'check.mjs')
if ($LASTEXITCODE -ne 0) { throw '检查失败，停止打包。' }
$manifest = Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'manifest.json') | ConvertFrom-Json
$revision = & git -C $projectRoot rev-parse --short HEAD
if ($LASTEXITCODE -ne 0) { throw '无法读取 Git 提交。' }
$changes = & git -C $projectRoot status --porcelain
if ($LASTEXITCODE -ne 0) { throw '无法读取 Git 状态。' }
if ($changes) { throw '请先提交修改，再打包，以便产物能对应准确的 Git 提交。' }
$outputRoot = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
$archivePath = Join-Path $outputRoot "BiliPush-Edge-$($manifest.version)-$revision.zip"
if (Test-Path -LiteralPath $archivePath) { throw "目标文件已存在，不覆盖：$archivePath" }
$tempRoot = [IO.Path]::GetFullPath('E:\Codex\BiliPush-Edge-Extension')
$stage = Join-Path $tempRoot ('package-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
try {
  foreach ($name in @('manifest.json', 'src', 'assets')) {
    Copy-Item -LiteralPath (Join-Path $projectRoot $name) -Destination $stage -Recurse
  }
  $entries = Get-ChildItem -Force -LiteralPath $stage
  Compress-Archive -LiteralPath $entries.FullName -DestinationPath $archivePath
  Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath
} finally {
  $resolvedStage = [IO.Path]::GetFullPath($stage)
  if ($resolvedStage.StartsWith($tempRoot + '\', [StringComparison]::OrdinalIgnoreCase) -and
      (Split-Path -Leaf $resolvedStage) -match '^package-[a-f0-9]{32}$') {
    Remove-Item -LiteralPath $resolvedStage -Recurse -Force
  }
}
