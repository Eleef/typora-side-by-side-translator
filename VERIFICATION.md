# MVP Verification

## 环境

| 平台 | 证据状态 | 环境或边界 |
|---|---|---|
| Windows 10/11 | VERIFIED | Typora 1.14.9 + typora-community-plugin 2.9.14；已完成安装、加载、pane 和迁移 smoke |
| macOS | UNVERIFIED in Typora | `darwin` 清单、架构无关 ZIP、Mac 安装器/doctor 和 macOS CI 隔离测试已定义；没有真实 Typora-on-macOS 运行证据 |
| Linux | Unsupported | 未声明平台，未提供安装器和宿主 smoke |

## 构建验证

命令：

```powershell
npm run check
```

期望结果：

- `dist/main.js` 存在
- `build/typora-side-by-side-translator/main.js` 存在
- `build/typora-side-by-side-translator/locales/` 下存在英文、简体中文、繁体中文、日文和韩文资源
- `build/typora-side-by-side-translator/manifest.json` 存在
- `build/typora-side-by-side-translator/style.css` 存在
- 严格类型检查通过
- 运行时安全、凭据策略迁移、界面语言、目标语言隔离、增量翻译、Markdown/导出、HTML 净化、pane 卸载、缓存一致性、任务取消、版本、发布和仓库/安装规则测试全部通过，共 67 项
- 连续两次生成的 `release/plugin.zip` SHA-256 完全一致

版本候选验证：

```powershell
npm run version:set -- 0.1.0-alpha.3
npm run ci
$env:RELEASE_TAG = "0.1.0-alpha.3"
npm run check:release
```

期望 package、lock、源码 Manifest、构建 Manifest、ZIP Manifest 和 Release tag 完全一致，且 tag 不带 `v` 前缀。

发布后远程验证：

```powershell
npm run check:published -- --version 0.1.0-alpha.3
```

该命令检查 GitHub Release 状态、六个发布资产、每个资产的 SHA-256、ZIP 根目录、插件 ID 和安装版本。六个资产为共享 `plugin.zip`、校验和、Windows 安装/诊断脚本及 macOS 安装/诊断脚本。正式版本还会验证 GitHub `latest` 指向该版本。

Windows 安装器回归：

```powershell
npm run test:windows-installer
```

该测试会构造隔离的 Typora/社区市场目录，验证健康安装、自动启用、无 BOM 写入、会话密钥升级阻止和持久设置完整保留，并确认缺少市场注入或启用配置带 BOM 时 `doctor` 必须失败。

macOS 安装器回归：

```bash
npm run test:macos-installer
```

该测试在 GitHub 的 macOS runner 上构造隔离的 `Typora.app` 和社区运行目录，验证官方加载器注入形态、同一 `plugin.zip` 安装、`darwin` 清单、自动启用、持久设置哈希不变、会话密钥升级阻止及损坏安装检测。它不启动 Typora 图形界面，因此结果不能标记为 macOS 宿主 smoke。

## 安装验证

### Windows

命令：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\doctor.ps1 -Mode Community
powershell -ExecutionPolicy Bypass -File .\scripts\install-plugin.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\install-plugin.ps1 -PackagePath .\release\plugin.zip -ExpectedSha256 ((Get-Content .\release\SHA256SUMS.txt | Select-String 'plugin\.zip').Line.Split()[0])
powershell -ExecutionPolicy Bypass -File .\scripts\doctor.ps1
```

期望结果：

- `%USERPROFILE%\.typora\community-plugins\plugins\eleef.typora-side-by-side-translator\main.js` 存在
- `doctor -Mode Community` 确认 Typora、社区市场注入、loader 和 core 完整
- `plugins.json` 为无 BOM UTF-8，当前插件 ID 自动启用，旧 ID 被移除
- 中间版本 `eleef.typora-side-by-side-translation` 和更早版本的代码目录被安全移除
- 构建目录与安装目录中的 `main.js`、`manifest.json`、`style.css` 及五个 `locales/*.json` SHA-256 分别一致
- 完整 `doctor` 确认最低版本门槛、已验证组合和插件启动日志标记
- 安装目录 `manifest.json` 的版本为 `0.1.0-alpha.3`，并与本轮构建一致
- 已有安装采用会话 key 且服务配置完整时，安装器在修改插件文件前停止；显式增加 `-AcceptSessionCredentialLoss` 才允许接受安装后重新输入
- 已有安装采用明文插件设置模式时，安装器输出 `verified_settings_preserved=true`，设置文件 SHA-256 在升级前后完全一致

重启 Typora 后继续确认：

- Installed Plugins 显示 **Typora Side-by-Side Translator**
- 插件设置页顶部显示 **当前安装版本：0.1.0-alpha.3**
- 命令面板显示新名称下的 5 个命令；命令标题使用当前插件界面语言
- 旧设置、缓存、主日志和轮转日志迁移到新插件 ID；旧设置文件中的 `apiKey` 被清空

### macOS 候选

先按社区框架官方说明运行 `install-macos.sh`，然后完全退出 Typora：

```bash
./scripts/doctor-macos.sh --mode Community
checksum=$(awk '$2 == "plugin.zip" { print $1 }' release/SHA256SUMS.txt)
./scripts/install-plugin-macos.sh --package ./release/plugin.zip --expected-sha256 "$checksum"
./scripts/doctor-macos.sh --redact-paths
```

自动化期望：

- 加载器位于 `~/Library/Application Support/abnerworks.Typora/plugins`
- 插件位于该目录下的 `plugins/eleef.typora-side-by-side-translator`
- `manifest.json` 声明 `darwin`，插件包与 Windows 共用且不含原生 CPU 模块
- `settings/plugins.json` 保持有效 JSON，并启用当前插件 ID
- 已持久化插件设置在覆盖安装前后 SHA-256 相同
- 会话模式 key 存在丢失风险时，默认在替换代码前停止
- doctor 可以识别加载器注入、Core、插件文件、最低版本、启用状态和启动日志标记

真实 Mac 后续仍需确认：

- Installed Plugins 中可见并能启用插件
- 命令面板显示全部命令
- pane、悬停菜单、分隔条、共享滚动和多语言布局正常
- 全文翻译、增量刷新、取消、缓存和导出正常
- 重启后设置按所选凭据模式恢复
- Intel 与 Apple Silicon 至少各收集一份兼容报告；这不是当前候选代码完成的前置条件

## Smoke 场景

### 1. Pane 开关

1. 打开 `fixtures/fixture-basic.md`
2. 执行 `Typora Side-by-Side Translator: Toggle Pane`

期望：

- 右侧 pane 出现
- 工具栏与状态提示显示为右上角悬浮层，不占正文顶部高度
- 原文首块与译文首块从同一垂直起点开始
- 右侧没有独立滚动条
- 左侧 Typora 编辑区仍可正常输入和滚动

### 1.1 比例调整

1. 显示右侧 pane
2. 拖拽中间分隔条
3. 双击分隔条
4. 点击 `40/60`、`50/50`、`60/40` 预设按钮

期望：

- 拖拽时比例实时变化
- 释放后宽度被持久化
- 双击后恢复 `50/50`
- 点击预设后布局立即切换并持久化

### 1.2 工具栏模式

1. 在设置页将 `toolbarDisplayMode` 设为 `compact`
2. 打开 pane 并观察右上角工具栏
3. 再将 `toolbarDisplayMode` 设为 `collapsed`
4. 观察折叠入口，并移入或点击展开

期望：

- `compact` 为紧凑单行悬浮层
- `collapsed` 默认只显示小入口，移入或点击后展开完整工具栏
- 两种模式都不会让译文正文整列继续向左缩窄
- 模式切换后共享滚动与高亮仍正常

### 2. 首次全文翻译

1. 配置目标语言和 `baseUrl/apiKey/model`
2. 执行 `Typora Side-by-Side Translator: Translate Current File`

期望：

- 原文目录下不生成目标语言对应的译文或 map
- 插件缓存区生成目标语言独立的缓存译文和 map
- 右侧渲染译文内容

### 2.1 取消与重复任务

1. 对较长文档执行 `Translate Current File`
2. 请求运行时再次执行翻译命令，确认不会启动第二个任务
3. 执行 `Typora Side-by-Side Translator: Cancel Translation`

期望：

- 工具栏显示“取消翻译”，全文翻译和刷新按钮在任务期间禁用
- 重复命令不产生第二组网络请求
- 取消后显示明确状态，现有缓存译文和 map 不被覆盖
- 切换文件或关闭 Typora 时，旧任务也会取消

### 3. 导出净化

1. 在首次全文翻译后点击“导出译文”

期望：

- 原文目录下生成当前目标语言对应的 `.zh.md`、`.zh-TW.md`、`.en.md`、`.ja.md` 或 `.ko.md`
- 导出的 Markdown 中不包含 `typora-side-by-side:block-*` 或旧版 `typora-bilingual:block-*` 注释
- 标题、列表、引用、代码块、公式、表格结构可正常阅读

### 4. 脏区刷新

1. 修改原文一个段落
2. 执行 `Typora Side-by-Side Translator: Refresh Stale Blocks`

期望：

- 编辑后仅提示脏区，不自动调用翻译
- 刷新后脏区归零

### 5. 结构保护

1. 打开 `fixtures/fixture-structured.md`
2. 执行全文翻译

期望：

- 代码块围栏保留
- 数学公式原样保留
- HTML 块原样保留
- 表格不崩坏

### 6. 人工改写保护

1. 打开 `fixtures/fixture-manual-edit.md`
2. 执行全文翻译
3. 在设置页找到翻译缓存目录，手工修改当前语言缓存 Markdown 中某一控制块的译文正文
4. 回到原文，修改对应原文块
5. 执行 `Refresh Stale Blocks`

期望：

- 手工修改过的缓存译文块默认不被覆盖
- 人工清空为零字符的缓存译文块也视为手工修改，不被静默补回
- 原文目录里的导出文件不会被静默改写

### 6.1 损坏或不完整缓存保护

1. 完成一次全文翻译并退出 Typora
2. 备份缓存后，分别模拟删除 map 文件和将 map 文件改成无效 JSON
3. 重新打开 Typora，执行 `Refresh Stale Blocks`
4. 再明确执行 `Translate Current File`

期望：

- 脏区刷新在网络请求和写盘前停止，并提示缓存不完整、损坏或不可读
- 原缓存译文不被脏区刷新覆盖
- 用户明确执行全文翻译后，缓存译文和 map 可一起重建

### 7. 共享滚动

1. 打开一个较长文档并显示右栏
2. 在右侧区域使用鼠标滚轮或触控板滚动
3. 持续滚动原文长文档
4. 在出现错误或警告提示时继续滚动观察

期望：

- 右侧没有独立滚动条
- 实际滚动的是 Typora 主滚动容器
- 右侧高亮块随原文滚动更新
- 同屏位置大体保持对齐，不出现明显错位累积
- 错误/警告提示为悬浮层，不会把正文首块继续向下推

### 8. 错误处理

1. 把 `baseUrl` 改成一个无效地址
2. 执行全文翻译

期望：

- 右栏显示悬浮错误提示
- Typora 主编辑区不冻结
- 模型返回 `typora-side-by-side:block-*` 或旧版 `typora-bilingual:block-*` 保留控制注释时安全失败，不写入缓存

### 9. 服务地址限制

1. 尝试保存远程 HTTP 地址，例如 `http://api.example.com/v1`
2. 尝试保存本地地址，例如 `http://127.0.0.1:11434/v1`
3. 尝试保存带用户名、密码或查询参数的地址

期望：

- 远程 HTTP 被拒绝并显示明确原因
- 本机回环地址的 HTTP 可以保存
- 用户名、密码、查询参数和页面锚点被拒绝

### 10. API Key 保存与恢复

1. 先配置 `baseUrl`，再输入 API key
2. 关闭并重新打开设置页，确认当前会话仍可使用
3. 保持默认“本地保存（明文）”，完全退出并重启 Typora
4. 切换到“不保存（仅当前 Typora 会话）”，再输入测试 key，完全退出并重启 Typora
5. 将 `baseUrl` 改到另一个域名
6. 点击“删除 API key”

期望：

- 默认插件设置模式重启后显示已恢复状态，且可以继续发起明确授权的翻译请求
- 会话模式重启后 API key 为空，需要重新输入
- 不同服务来源不能复用旧 key；更换来源会同时清除内存和已保存 key
- 删除操作同时清除当前会话 key 和已保存 key
- 插件设置文件中 `apiKey` 始终为空字符串
- 默认插件设置模式下，设置文件中的 `storedApiKey` 包含明文测试 key；主动选择会话模式后该字段为空

### 10.1 目标语言与缓存隔离

1. 依次选择简体中文、繁体中文、English、日本語和 한국어
2. 每次切换后先确认没有自动网络请求，再执行全文翻译
3. 切回已翻译过的语言
4. 分别导出各语言译文

期望：

- 设置页和右侧工具栏都能切换五种目标语言
- 切换语言只读取对应缓存，不会自动翻译
- 各语言使用独立缓存与 map，互不覆盖
- 切回已翻译语言后直接显示其已有缓存

### 10.2 插件界面语言

1. 在设置页将界面语言依次切换为自动、英文、简体中文、繁体中文、日文和韩文
2. 每次切换后重新打开命令面板并观察右侧 pane
3. 保持目标语言不变，仅切换界面语言
4. 输入无效 API 地址并触发一次校验错误

期望：

- 设置页、五个命令、右侧按钮、状态徽标、确认框和错误提示使用当前界面语言
- 自动模式优先读取 Typora 原始区域设置；`zh-Hant`/`zh-HK` 等别名正确归一化，宿主语言无对应资源时回退英文
- 切换界面语言不会改变目标语言，不会切换缓存，也不会发起网络请求
- 技术字段名、诊断事件名和发送给模型的固定结构指令不因界面语言改变
- 导出后缀分别为 `.zh.md`、`.zh-TW.md`、`.en.md`、`.ja.md` 和 `.ko.md`

### 11. Map 摘要、块标识与旧格式迁移

1. 打开一个由旧版本生成、`translatedHash` 仍是完整译文的缓存文档
2. 不执行翻译，只显示 pane
3. 检查缓存 map

期望：

- 新 map 使用 `schemaVersion: 4`、`translatedHashAlgorithm: sha256`、`blockIdAlgorithm: position-v1` 和 `cacheGeneration`
- 缓存译文头与 map 的 `cacheGeneration` 相同，块 ID 集合与数量一致
- 缓存对先写临时文件再替换，第二个文件提交失败时恢复上一对正式文件
- 每个 `translatedHash` 是 64 位十六进制摘要
- 人工修改标记仍可正确识别
- schema 2 摘要不会被重复哈希
- 缺少 `blockIdAlgorithm` 的旧缓存执行“刷新脏区”时被拒绝，执行“全文翻译”时允许显式重建
- 文档结构变化且存在人工改写时，刷新脏区被拒绝；无人工改写时允许重译受影响位置

### 12. 缓存与日志清理

1. 在设置页检查缓存目录、文件数和占用
2. 点击“清理当前文档”
3. 点击“清理全部缓存”并确认
4. 点击“清理日志”
5. 在非生产测试数据上点击“清除全部插件本地数据”并确认

期望：

- 当前文档清理不影响其他语言缓存和已导出的译文 Markdown
- 全部清理只删除插件翻译缓存
- 日志和轮转备份均被删除
- 日志中不出现 API key、完整本地路径或带查询参数的服务地址
- 全部本地数据动作删除设置、已保存明文 key、缓存、映射和日志并禁用插件；已导出 Markdown 保留

## 已知风险

- 当前共享滚动依赖块级最小高度对齐，属于可读同步，不是像素级双编辑器对齐
- 当前右栏渲染使用 `markdown-it`，视觉上不会完全等同 Typora 原生渲染
- 当前右栏缓存文件保留内部控制注释，仅导出文件为纯净 Markdown
- 当前 Typora 社区插件宿主没有可用的系统安全凭据桥；默认跨重启保存依赖明文插件设置，设置页必须明确披露风险并提供会话模式
- macOS 平台声明基于社区框架公开契约和自动化安装测试；没有真实 Mac 宿主证据前，不得在 Release 或市场文案中称为正式支持
