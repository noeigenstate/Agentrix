# 增量功能说明：玻璃背景与终端字体

外观现已固定为「海岛暮蓝」（Catalina）；玻璃背景透明度、终端字体与字重仍可独立调整。

## README 可用短文

### 中文

**海岛暮蓝外观。** 设置中可调整终端西文/中文后备字体、字重和玻璃背景透明度。液态玻璃支持应用内壁纸，或在平台支持时模糊窗口背后的桌面内容；终端程序的 RGB 真彩色输出保持原样。

桌面背景首次启用需要重新打开应用。Windows 10 与较早的 Windows 11 使用实验兼容路径，支持最大化与窗口内展开，暂不支持系统全屏；Windows 11 22H2+/macOS 接入原生材质 API，尚待实机验证；不支持的平台保留主题背景。字体从本机调用，不自动下载或随应用分发。

### English

**Island Dusk appearance.** Catalina is the fixed appearance. Choose installed terminal fonts, adjust weight and glass transparency, and use the app wallpaper or, on supported platforms, blur content behind the window. Terminal programs keep their RGB truecolor output.

Enabling desktop glass initially requires reopening the app. The experimental Windows 10/older Windows 11 path supports maximising and in-window expansion, but not native fullscreen. Windows 11 22H2+/macOS use native material APIs and still need hardware validation; unsupported systems retain the theme background. Fonts are called from the local installation, without downloads or bundled font files.

## 用户操作与默认行为

1. 打开「工作台设置 → 外观」。
2. 在「界面材质」选择液态玻璃或实色。玻璃下才显示「玻璃背景」，可选主题背景或桌面背景。
3. 玻璃透明度可跟随主题或自定义；0% 不透明，100% 最透明。只改变背景，正文保持原透明度。标题栏和弹窗保留更实的底色，以稳定操作文字的对比度。
4. 终端字体调用已安装字体。西文使用等宽字体；中文选择作为缺字后备。留空沿用原字体栈，未安装的字体继续回退；自定义字体栈额外包含 Linux 常见的 DejaVu Sans Mono/Liberation Mono，位于中文后备之前。字体配置作用于终端，不替换阅读正文和界面的字体栈。
5. 字重可选 400/500/600；不会改动通知、声音、会话恢复或快捷键。

切换实色时隐藏背景选项并保留选择，切回玻璃恢复。普通窗口首次选择桌面背景会显示重开提示；不会自动关闭、重启或重建正在使用的终端。系统减少透明度偏好优先。不支持或启用失败时使用应用内背景。

## 合并范围与兼容性

- 不再保存主题选择；旧工作区中的主题值会被忽略，统一使用海岛暮蓝。
- `glassBackground` 默认 `theme`；`glassTransparency` 默认 `null`；`terminalFontWeight` 默认 `400`；`terminalFontFamily` / `terminalCjkFontFamily` 默认空字符串。无需迁移旧工作区文件。
- 早期本地预览的 `surface=desktop-glass` 清理为 `surface=glass` + `glassBackground=desktop`；公开材质仍只有两个值。
- 原生背景接入集中在一个模块与 Windows 兼容助手；不增加生产依赖、原生 addon 或字体文件。
- 字体变化只更新现有终端并重新计算尺寸；会话、未发草稿与缓冲区保持。额外的 xterm 6.0 DOM 选区缓存兼容修复用守卫接入现有渲染适配入口；升级 xterm 时应重新核对其内部接口。
- Windows 10 兼容路径使用未公开的系统接口，保留实验说明和失败回退。颜色光标限定于该透明窗口，原终端鼠标协议及链接光标保留。
- 字体许可和分发边界见 [font-licenses.md](font-licenses.md)。任意自定义字体仍以其授权为准。

## 维护者可核对的证据

[验证记录](appearance-validation.md)列出范围、可复现命令与平台边界；[机器可读摘要](appearance-evidence.json)保存单元测试、GUI 检查、背景对照及打包审计结果。图片和摘要随本次贡献提交；完整原始日志保留在本地测试输出，不在文档中链接未提交的日志。

当前外观截图可由维护者运行 `npm run test:appearance` 生成，输出目录由脚本打印；检查使用独立资料并顺序执行，不操作用户正在使用的窗口或会话。历史记录不代表当前海岛暮蓝版本已经通过 GUI 验证。

合并前仍需维护者安排 Windows 11 22H2+/macOS 实机材质验证；Linux 的系统背景保持回退，字体候选顺序经过检查但尚未进行 Linux 实机观感验证。README 不应宣传所有平台效果一致或任意背景下的透明文字都可读。版本号与发布说明由主分支维护者按发布计划决定。
