# 本工作区的本地构建环境（Windows / PowerShell）
#
# 用法（在仓库根目录）：
#   . .\scripts\build-env.ps1
#
# 与 macOS 侧的 .build-cache\env.sh 对应（那份含本机绝对路径，未入库）。作用是把所有缓存固定在本仓库内，
# 并指向国内镜像，避免下载超时。
#
# 注意：必须用「点源」（开头一个点加空格）执行，否则变量只存在于子作用域，
# 当前窗口里拿不到。

$repoRoot = Split-Path -Parent $PSScriptRoot

# Corepack / Yarn 缓存留在仓库内，避免写 %LOCALAPPDATA%
$env:COREPACK_HOME = Join-Path $repoRoot '.build-cache\corepack'
$env:YARN_GLOBAL_FOLDER = Join-Path $repoRoot '.build-cache\yarn-global'
$env:YARN_ENABLE_GLOBAL_CACHE = 'false'

# npm 与 Electron 二进制走国内镜像
$env:YARN_NPM_REGISTRY_SERVER = 'https://registry.npmmirror.com'
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'

# Electron Builder 下载的 NSIS / winCodeSign 工具链也走镜像
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://registry.npmmirror.com/-/binary/electron-builder-binaries/'

# Electron 与 Electron Builder 的下载缓存留在仓库内
$env:ELECTRON_CACHE = Join-Path $repoRoot '.build-cache\electron'
$env:ELECTRON_BUILDER_CACHE = Join-Path $repoRoot '.build-cache\electron-builder'

# 让 Agents-Anywhere 桥接包走 vendor 里已 pin 的版本，不对 GitHub 发 git ls-remote
$env:DSH_AA_SOURCE_REF = 'pinned'

Write-Host 'build environment ready:' -ForegroundColor Green
Write-Host "  repo        : $repoRoot"
Write-Host "  node        : $(node --version)"
Write-Host "  arch        : $(node -p process.arch)   # 必须是 x64"
Write-Host "  registry    : $env:YARN_NPM_REGISTRY_SERVER"
