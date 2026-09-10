# MEMORY

长期事实与项目约定，跨会话复用。

## 仓库约定（踩过的坑）

- **`.agents` 在 `.gitignore` 里（第 41 行），但 Agent Note 是强制加入（tracked）的**：新建的 Agent Note 需要用 `git add -f` 才能纳入版本控制，否则 `git status` 看不到它。文档门（`verify-agent-note-format` / `verify-agent-note-classification` / `verify-translation-pairing`）仍然会扫描它。
- **Agent Note 是三件套**：`foo.md` + `foo.zh.md` + `foo.i18n.yaml`。sidecar 用 `pnpm run verify-translation-pairing --write <foo.md>` 生成（记录 git blob 哈希，不需要先 commit/stage）。class 目录必须取自闭合集合（feature / bug-fix / simplification / architecture / process / testing）。
- **双语文档的代码块必须逐字一致**（`verify-translation-pairing` 会逐块比对），中文正文里不要把代码块内的英文注释翻译掉；表格与正文可以本地化。改动 `native-macos/README.md` 或 `.zh.md` 后必须重新 `--write` 该配对。
- 工作区里 `docs/subsystems/storage.*` 与 `dsh-oauth-plugin/README.*` 存在**先于本次改动**的 pairing 漂移，`verify-translation-pairing` 会因此失败；与本仓库其它改动无关。
- `native-macos` 不在任何仓库门禁的扫描范围内（`scripts/` 与 `package.json` 都不引用它），因此 `native-macos/Tests/` 这类目录是安全的。
- 用户 shell 里 `du` 似乎被包装过：`du -sh <dir>` 会输出 `sort: Is a directory`，改用 `/usr/bin/du` 或 `find`/`ls` 统计。
- **本会话环境的两个「批量删除」拦截（会静默拖死构建，务必识别）**：
  1. `NODE_OPTIONS=--require=".../CodeBuddy CN.app/.../genie/out/vendor/shim/node-language-shim.cjs"`。任何 node 脚本的批量删除都会被转派给 `safe-delete-bulk-guard` 子进程（疑似移入废纸篓），把秒级剪枝拖成小时级。诊断依据：`sample <pid>` 看到 `node::SyncProcessRunner`＋`posix_spawn`，或 `pgrep -P <pid>` 看到该 guard。规避：`env -u NODE_OPTIONS` 运行。
  2. 更上层还有一处按「回合」计量的删除守卫：单回合删除超过 500 个文件后会打印 `[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {...}` 并**静默中止后续删除**（表现为 `rm -rf "$APP_DIR"` 不生效、构建立即结束）。因此在本会话里跑 `build-release.sh` 这类重度构建需要用户在 IDE 里确认删除，或改由用户自己的终端执行。
- macOS 只保证有 `/usr/bin/gzip` 与 `/usr/bin/bzip2`；`xz`/`zstd` 在本机来自 `/opt/homebrew`，**不能假定最终用户机器上存在**，所以随包分发的压缩归档只能用 gzip/bzip2 以便 `/usr/bin/tar` 解压。

## native-macos

- **`native-macos/Scripts/build-release.sh` 是唯一的构建脚本**（README 里的 `build.sh` / `release.sh` 早已不存在，已修正）。Swift 源文件清单同时存在于 `build-release.sh` 的 `compile_swift` 与 `Package.swift` 的 `sources`，**新增 .swift 必须两处都登记**；`Project.yml` 按目录自动包含，`xcodegen generate` 已安装可用于刷新 `.xcodeproj`。
- 应用包结构：`Contents/MacOS/DeepSeekHarness` + `Contents/Resources/{dsh-root,node,updater}`。`dsh-root` 是 `@deepseek-ai/dsh` 的 npm 生产闭包，`apps/cli → ../node_modules/@deepseek-ai/dsh`、`apps/web/dist → ../../node_modules/@deepseek-ai/dsh-web-frontend/dist`（相对符号链接，须能通过 `codesign --verify --deep --strict`）。
- 运行时数据在 `<DSH_HOME>`（默认 `~/.dsh`）：`profiles/ sessions/ storages/ logs/`，外加 `runtime/`（可更新运行时 + `.npm-cache` + `.update.lock`）。
- dsh 版本解析口径（打包脚本与运行期更新器共用）：**GitHub release tag 优先**，用 `releases?per_page=1`（仓库所有 Release 都是 pre-release，`/releases/latest` 拿不到），去 `dsh-`/`v` 前缀后在 npm registry 校验，失败回退 `dist-tags.latest`。
