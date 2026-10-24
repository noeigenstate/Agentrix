# 外观功能验证记录

以下是上游 0.6.12 / 7be8797 在 Windows 10 Pro 19045、Node 22.15.0、Electron 44.3.0 的历史验证记录，对应摘要见 [appearance-evidence.json](appearance-evidence.json)。已移除停用主题的矩阵与推荐配置结果；这些记录不代表当前海岛暮蓝版本已经通过 GUI 验证。

## 已完成

- 构建与类型检查通过。完整单元测试：446 通过、0 失败、4 项平台条件跳过（450 总计）。
- 原有编辑、输入、复制、选区、并行终端、阅读、完成通知、Git、导航与动画基线回归通过。
- 实际字体识别、字重 400/500/600、字体缺失回退、设置重启持久化、终端节点/会话/未提交输入保持通过。
- 桌面模糊与不模糊对照，边缘强度为 0.488333 / 2.0004；最大化及窗口内展开通过。此对照证明本机兼容后端发生模糊，不替代主观观感或其他平台验证。
- 透明度两端、主题默认恢复、实色与系统减少透明度回退、展开文件预览通过。

## 回归范围

| 阶段 | 检查 | 结果 |
| --- | --- | --- |
| 保留的历史基线 | appearance、glass-transparency、desktop-glass、readability、themes-markdown、gpu-terminal、editor-terminals、material、composer、reading、completion、git、navigation、motion、desktop、question-appearance、appearance-packaged | 17 项通过 |
| 字体后备与标题栏底色调整后的保留记录 | appearance、desktop-glass、glass-transparency、readability、question-appearance | 5 项通过 |
| 全量单元检查 | tests/*.test.cjs | 446 通过、4 跳过、0 失败 |

名称对应历史测试脚本；当前打包检查通过下述环境变量运行。完整原始日志保留在本地测试输出，文档只链接随 PR 提交的摘要，避免依赖无法在 GitHub 打开的本机日志。

## 复现检查

安装依赖后先构建。Node 22.15.0 直接引用 TypeScript 的测试需要显式启用类型擦除；这次验证使用以下命令，未改动上游测试启动规则：

```powershell
npm run build
node --experimental-strip-types --test tests/*.test.cjs

npm run test:appearance
npm run test:glass-transparency
npm run test:desktop-glass
npm run test:readability
npm run test:question-appearance
```

GUI 检查应顺序运行。脚本创建独立 AGENTRIX_DATA_DIR、演示项目和助手资料；只关闭自身启动的测试窗口，不操作用户工作区。桌面模糊对照在 Windows 使用测试专属背景窗口和标记区域，需可见的桌面会话；无对应后端时不能据此宣称实际背景模糊通过。运行结束后可按日志打印的目录查看截图和 results.json。

## 字体与打包

推荐字体许可及本机元数据核查见 [font-licenses.md](font-licenses.md)。仅调用已安装字体，没有新增字体下载或文件分发；不替任意自定义第三方字体作许可保证。摘要保存已核查文件的哈希和许可字段是否存在，不包含字体文件。

最终 app.asar 为 6,622,877 字节，根目录仅含 LICENSE、assets、dist、electron、package.json 和生产依赖。字体文件、外部字体请求及测试/源码/旧发布目录审计均为空；系统背景助手与 MIT 许可已包含。

本机默认 Windows 打包配置曾把测试及旧发布目录带入资源。这次使用独立打包配置，合并全局与 Windows 的文件白名单并排除测试产物；未修改作者的正式发布配置。发布前仍应单独检查实际安装包资源范围，不能把这份独立包的审计结果等同于正式发布流程已经验证。

以下可重建本次独立测试包，不改 package.json；该目录专供测试，不应放置正在使用的试用包：

```powershell
New-Item -ItemType Directory -Path .test-output -Force | Out-Null
@'
const fs = require('node:fs');
const build = JSON.parse(fs.readFileSync('package.json', 'utf8')).build;
build.directories = { ...build.directories, output: '.test-output/pr-appearance-package' };
build.files = [...build.files, '!{.test-output,release,src,tests,scripts,docs,integration}/**/*', '!{AGENTS.md,README.md,README.en.md,index.html,tsconfig.json,vite.config.ts}'];
build.win.files = [...build.files, ...build.win.files];
fs.writeFileSync('.test-output/pr-preview-build.json', JSON.stringify(build, null, 2));
'@ | Set-Content -LiteralPath .test-output/pr-build-config.cjs -Encoding UTF8
node .test-output/pr-build-config.cjs
node node_modules/electron-builder/out/cli/cli.js --win --dir --x64 --publish never --config .test-output/pr-preview-build.json
$env:AGENTRIX_APPEARANCE_EXE = (Resolve-Path '.test-output/pr-appearance-package/win-unpacked/Agentrix.exe').Path
npm run test:appearance
Remove-Item Env:AGENTRIX_APPEARANCE_EXE
```

## 验证边界与维护注意

- Windows 10/较早的 Windows 11 兼容磨玻璃使用未公开接口，仍属实验路径；最大化通过，系统全屏暂不支持，界面已说明。
- Windows 11 22H2+/macOS 接口调用与不支持平台回退经过单元检查，尚无对应实机验证。Linux 字体后备顺序经过检查，尚无 Linux 实机观感验证。
- 不同显示器的主观字体观感仍需试用确认。已验证颜色光标位图与适用范围，此前物理光标消失的具体根因未完整复现。
- xterm DOM 选区修复触及受守卫保护的内部接口；依赖升级时应重新验证清空选区后调整尺寸/切换主题以及真实选区保持。
- 原构建存在较大前端分块提示；本贡献不借机重构或变更正式打包、版本号、依赖和发布计划。

外观设置与维护说明见 [appearance-increment.md](appearance-increment.md)。

## 首次云端检查

本机验证不等同于云端全绿。首次 CI 的 Linux 白名单、macOS PR 签名与 Windows 权限等待问题及处理范围见 [ci-diagnostics.md](ci-diagnostics.md)；macOS 签名设置保持不变，Windows 根因仍待云端核对。
