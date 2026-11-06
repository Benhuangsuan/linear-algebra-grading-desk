[CmdletBinding(DefaultParameterSetName = 'Upgrade')]
param(
    [Parameter(ParameterSetName = 'Upgrade')][string]$OldData,
    [Parameter(ParameterSetName = 'Upgrade')][ValidateSet('Git', 'ZIP')][string]$Source,
    [Parameter(ParameterSetName = 'Upgrade')][ValidateRange(1, 65535)][int]$Port = 3000,
    [Parameter(Mandatory, ParameterSetName = 'Start')][switch]$Start
)

$ErrorActionPreference = 'Stop'
$repository = 'https://github.com/Benhuangsuan/linear-algebra-grading-desk'
$database = 'grading.sqlite'
$databaseFiles = @($database, "$database-wal", "$database-shm", "$database-journal")

function Assert-PlainPath([string]$path) {
    while ($path) {
        $item = Get-Item -LiteralPath $path -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '请选择本机的普通文件夹，避免使用链接或云盘目录。' }
        $path = Split-Path -Parent $path
    }
}

function Get-DataManifest([string]$root, [switch]$WithoutDatabase) {
    $folders = [Collections.Generic.Stack[string]]::new()
    $folders.Push($root)
    $entries = while ($folders.Count) {
        foreach ($item in Get-ChildItem -LiteralPath ($folders.Pop()) -Force) {
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '数据含有链接或云盘占位文件，无法完整备份。' }
            $relative = $item.FullName.Substring($root.Length + 1)
            if ($item.PSIsContainer) {
                $folders.Push($item.FullName)
                # Store creates an empty uploads folder when the old data has none.
                if (!$WithoutDatabase) { "D $relative" }
            } elseif (!$WithoutDatabase -or $relative -notin $databaseFiles) {
                $reader = [IO.File]::OpenRead($item.FullName)
                $sha = [Security.Cryptography.SHA256]::Create()
                try { "F $relative $($item.Length) $([BitConverter]::ToString($sha.ComputeHash($reader)))" }
                finally { $sha.Dispose(); $reader.Dispose() }
            }
        }
    }
    return (@($entries | Sort-Object -CaseSensitive) -join "`n")
}

function Invoke-CompatibilityCheck([string]$app, [string]$data) {
    $store = Join-Path $app 'build/server/store.js'
    # Use the published Store's migration without starting a service or loading API credentials.
    @'
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [storePath, data] = process.argv.slice(2);
const database = join(data, 'grading.sqlite');
const required = ['courses', 'assignments', 'files', 'submissions', 'history', 'versions'];
function snapshot(db) {
    if (db.prepare('PRAGMA integrity_check').all().some(row => row.integrity_check !== 'ok') ||
        db.prepare('PRAGMA foreign_key_check').get()) throw new Error('integrity');
    const names = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*'").all().map(row => row.name);
    if (!required.every(name => names.includes(name))) throw new Error('schema');
    const hashes = new Map();
    for (const name of names) {
        const hash = createHash('sha256');
        const query = db.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '" ORDER BY rowid');
        for (const row of query.iterate()) {
            const payload = JSON.parse(row.payload);
            if (name === 'files' && (!/^[a-f0-9-]+\.(pdf|docx)$/.test(payload.diskName) ||
                statSync(join(data, 'uploads', payload.diskName)).size !== payload.size)) throw new Error('upload');
            hash.update(JSON.stringify(row) + '\n');
        }
        hashes.set(name, hash.digest('hex'));
    }
    return hashes;
}
try {
    const old = new DatabaseSync(database, { readOnly: true });
    let before;
    try { before = snapshot(old); } finally { old.close(); }
    const { Store } = await import(pathToFileURL(storePath));
    const upgraded = new Store(data);
    try {
        const after = snapshot(upgraded.db);
        for (const [name, hash] of before) if (after.get(name) !== hash) throw new Error('records changed');
    } finally { upgraded.close(); }
} catch {
    process.exitCode = 1;
}
'@ | & node.exe --disable-warning=ExperimentalWarning --input-type=module - $store $data
    if ($LASTEXITCODE -ne 0) { throw '数据兼容性检查未通过。请确认选中了正确的旧数据目录、原文件齐全，且旧平台的批改任务已结束。' }
}

function Start-Platform {
    $app = Join-Path $PSScriptRoot 'app'
    $data = Join-Path $PSScriptRoot 'data'
    $settingsPath = Join-Path $PSScriptRoot 'upgrade-ready.json'
    $entry = Join-Path $app 'build/server/index.js'
    $dbPath = Join-Path $data $database
    if (!(Test-Path -LiteralPath $settingsPath -PathType Leaf) -or !(Test-Path -LiteralPath $entry -PathType Leaf) -or
        !(Test-Path -LiteralPath $dbPath -PathType Leaf)) { throw '升级未完成或找不到正式数据。请检查启动文件、app 和 data 是否都在原升级目录。' }
    Assert-PlainPath $dbPath
    Assert-PlainPath $entry
    $settings = Get-Content -LiteralPath $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $identity = Get-Content -LiteralPath (Join-Path $data '.upgrade-id') -Raw -Encoding UTF8
    if ($settings.Version -ne '2.13.0' -or $settings.Id -cne $identity -or $settings.Port -lt 1 -or $settings.Port -gt 65535 -or
        (Get-Item -LiteralPath $dbPath).Length -lt 100) { throw '正式数据或启动设置与此次升级不匹配。' }

    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, [int]$settings.Port)
    $listener.ExclusiveAddressUse = $true
    try { $listener.Start() } catch { throw "端口 $($settings.Port) 已被占用。请先关闭旧平台或已经打开的 v2.13 窗口。" }
    finally { $listener.Stop() }

    $env:DATA_DIR = $data
    $env:PORT = [string]$settings.Port
    $env:AI_PROVIDER = 'mock'
    Set-Location -LiteralPath $app
    & node.exe $entry
    if ($LASTEXITCODE -ne 0) { throw '平台启动失败，请查看上方提示。' }
}

try {
    $nodeVersion = & node.exe --version
    if ($LASTEXITCODE -ne 0 -or [version]($nodeVersion.TrimStart('v')) -lt [version]'24.13.0') {
        throw '请先安装 Node.js 24.13.0 或更新的兼容版本，然后重新打开 PowerShell。'
    }
    if ($Start) { Start-Platform; exit 0 }

    if (!$OldData) { $OldData = (Read-Host '请输入旧平台启动时显示的“数据保存在”完整路径').Trim().Trim('"') }
    $old = (Get-Item -LiteralPath $OldData -Force).FullName
    $oldDb = Join-Path $old $database
    if (!(Test-Path -LiteralPath $oldDb -PathType Leaf)) { throw '该目录没有旧平台数据库。请核对旧平台显示的实际数据路径。' }
    Assert-PlainPath $oldDb
    if (!$Source) {
        switch (Read-Host '下载方式：1 Git（推荐，需已安装 Git），2 ZIP（无需 Git）') {
            '1' { $Source = 'Git' }
            '2' { $Source = 'ZIP' }
            default { throw '请输入 1 或 2。' }
        }
    }
    if ($Source -eq 'Git' -and !(Get-Command git.exe -ErrorAction SilentlyContinue)) { throw '未找到 Git。可重跑升级并选择 ZIP。' }

    $local = (Get-Item -LiteralPath $env:LOCALAPPDATA -Force).FullName
    Assert-PlainPath $local
    $parent = Join-Path $local 'GradingDeskUpgrades'
    if ($parent.Equals($old, [StringComparison]::OrdinalIgnoreCase) -or
        $parent.StartsWith($old.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '升级目录必须在旧数据目录之外。' }
    if (!(Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent | Out-Null }
    Assert-PlainPath $parent

    $handles = @()
    try {
        foreach ($name in $databaseFiles) {
            $file = Join-Path $old $name
            if (!(Test-Path -LiteralPath $file)) { continue }
            Assert-PlainPath $file
            try { $handles += [IO.File]::Open($file, 'Open', 'Read', 'Read') }
            catch { throw '旧数据仍在使用或无法读取。请关闭使用这份数据的所有平台窗口，再重试。' }
        }
        if ($handles.Count -eq 0 -or !(Test-Path -LiteralPath $oldDb -PathType Leaf)) { throw '找不到旧平台数据库。' }
        $id = [guid]::NewGuid().ToString('N')
        $install = Join-Path $parent ('v2.13.0-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + $id.Substring(0, 8))
        if (Test-Path -LiteralPath $install) { throw '升级目录已存在，请重试。' }
        New-Item -ItemType Directory -Path $install | Out-Null
        $backup = Join-Path $install 'backup'
        $app = Join-Path $install 'app'
        $data = Join-Path $install 'data'

        Write-Host '正在备份并校验旧数据…'
        $expected = Get-DataManifest $old
        Copy-Item -LiteralPath $old -Destination $backup -Recurse -Force
        if ((Get-DataManifest $backup) -cne $expected -or (Get-DataManifest $old) -cne $expected) { throw '旧数据与备份不一致，升级已停止。' }
        Set-Content -LiteralPath (Join-Path $install 'backup-sha256.txt') -Value $expected -Encoding UTF8

        Write-Host '正在下载 v2.13.0 并构建程序…'
        if ($Source -eq 'Git') {
            & git.exe clone --branch v2.13.0 --depth 1 --quiet -c advice.detachedHead=false "$repository.git" $app
            if ($LASTEXITCODE -ne 0) { throw 'Git 下载失败。可检查网络，或重试并选择 ZIP。' }
            if ((& git.exe -C $app rev-parse HEAD) -ne '1e001dcc0da82239c0f57460ff81553d57831fc1') { throw '下载的 Git 版本与 v2.13.0 不符。' }
        } else {
            $zip = Join-Path $install 'source.zip'
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            Invoke-WebRequest -UseBasicParsing -Uri "$repository/archive/refs/tags/v2.13.0.zip" -OutFile $zip
            Add-Type -AssemblyName System.IO.Compression.FileSystem
            [IO.Compression.ZipFile]::ExtractToDirectory($zip, $install)
            Rename-Item -LiteralPath (Join-Path $install 'linear-algebra-grading-desk-2.13.0') -NewName 'app'
        }
        Set-Location -LiteralPath $app
        $package = Get-Content -Raw -LiteralPath 'package.json' | ConvertFrom-Json
        if ($package.name -ne 'linear-algebra-grading-desk' -or $package.version -ne '2.13.0') { throw '下载的程序与 v2.13.0 不符。' }
        & npm.cmd ci --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw '依赖安装失败，请检查网络后重试。' }
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw '程序构建失败。' }

        Write-Host '正在检查新版能否完整读取旧数据…'
        Copy-Item -LiteralPath $backup -Destination $data -Recurse -Force
        if ((Get-DataManifest $data) -cne $expected) { throw '新数据副本校验失败。' }
        Invoke-CompatibilityCheck $app $data
        if ((Get-DataManifest $data -WithoutDatabase) -cne (Get-DataManifest $backup -WithoutDatabase) -or
            (Get-DataManifest $old) -cne $expected) { throw '升级过程中有文件变化，升级已停止。' }

        Copy-Item -LiteralPath $PSCommandPath -Destination (Join-Path $install 'upgrade-v2.13.ps1')
        Set-Content -LiteralPath (Join-Path $data '.upgrade-id') -Value $id -Encoding ASCII -NoNewline
        @'
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0upgrade-v2.13.ps1" -Start
if not errorlevel 1 exit /b 0
pause
exit /b 1
'@ | Set-Content -LiteralPath (Join-Path $install 'Start-v2.13.cmd') -Encoding ASCII
        @{Version = '2.13.0'; Id = $id; Port = $Port} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $install 'upgrade-ready.json') -Encoding UTF8
        Write-Host "升级完成。请记下这个目录：$install"
        Write-Host '新版程序在 app，备份在 backup。配置 API 后双击 Start-v2.13.cmd。'
        Write-Host "启动后打开 http://127.0.0.1:$Port"
    } finally {
        foreach ($handle in $handles) { $handle.Dispose() }
    }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    if (!$Start) { [Console]::Error.WriteLine('升级已停止。请保留原程序、原数据和已生成的备份。') }
    exit 1
}
