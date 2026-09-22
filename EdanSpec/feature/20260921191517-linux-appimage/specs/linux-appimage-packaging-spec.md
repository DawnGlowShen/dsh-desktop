# Linux AppImage 打包规格

## ADDED Requirements

### Requirement: Linux AppImage 产物

`dsh-plugin-desktop` 的 `build.linux` 必须声明 AppImage 目标，构建后产出单一 `.AppImage` 文件，且产物名包含 `package.json` 中的版本号。

#### Scenario: 构建产出 AppImage

- **WHEN** 在 Linux 打包环境执行 Linux 打包命令
- **THEN** `dist/` 下产出 `DSH-Desktop-Evo-<version>-x86_64.AppImage`，且该文件具有可执行权限

#### Scenario: 产物携带定制默认值

- **WHEN** 解包已构建的 AppImage 并检查 `resources/app`
- **THEN** `cordis.patch.yml` 中 `desktop-updates` 含 `config.enabled: false`，且 `lib/` 内编译产物的更新端点指向不可解析的 `.invalid` 域

### Requirement: AppImage 可启动

产物必须能在不含 Node.js 与 Electron 的干净 Linux x64 环境启动并进入主界面。

#### Scenario: 干净环境启动

- **WHEN** 在没有 Node.js 与 Electron 的 Linux x64 环境执行该 AppImage
- **THEN** 应用启动并显示主窗口，不出现未捕获的模块加载错误

### Requirement: Linux CodeGraph 可用

Linux x64 产物必须包含可用的 CodeGraph CLI，其来源为 GitHub Releases bundle 经格式适配后的归档。

#### Scenario: 产物内含 CodeGraph

- **WHEN** 解包 AppImage 并检查 `resources/codegraph`
- **THEN** 存在 `bin/codegraph` 与 `node`，且二者的可执行位已设置

#### Scenario: 物化清单记录 linux-x64

- **WHEN** 执行 `prepare-codegraph.mjs` 后读取其生成的标记文件
- **THEN** `target` 字段为 `linux-x64`，`packageName` 为 `@colbymchenry/codegraph-linux-x64`，且记录了归档的 sha256
