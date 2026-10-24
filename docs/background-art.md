# 自然风景背景

固定外观「海岛暮蓝」采用 macOS Catalina 自然风景壁纸，由 [512 Pixels 壁纸档案](https://512pixels.net/projects/default-mac-wallpapers-in-5k/)整理提供。

| 主题 | 壁纸/应用资源 | 尺寸 | 字节数 | 来源 |
| --- | --- | --- | --- | --- |
| 海岛暮蓝 | Catalina Day / `src/assets/macos-catalina.webp` | 2560×2560 | 609,632 | [Catalina Day](https://media.512pixels.net/downloads/macos-wallpapers-6k/10-15-Day-6k.jpg) |

- Catalina 的 6K 原图用 Pillow 等比缩放到长边 2560 px、WebP quality 84/method 6，没有重新绘制或更改画面。
- 背景只绘制在 `.app-shell`，保持原有染色及液态玻璃透明度；`center 42% / cover` 保持比例与现有裁切。
- Vite 将壁纸打包为本地资源，运行时不下载图片，断网可用。
- 壁纸权利归 Apple 及相应权利人，来源档案由 Stephen Hackett 整理；不将第三方图片声明为项目原创或 MIT 授权素材。安装包附带 `assets/THIRD-PARTY-NOTICES.txt`。

## 历史 PNG 测试图片

- 文件：`tests/fixtures/preview-large.png`
- 方式：内置 `imagegen` 工具生成，原图直接保存，未二次绘制。
- 内容：树叶与枝干围绕蓝天白云，斑驳日光、自然绿色和可见油画笔触。
- 用途：保留给大尺寸 PNG 预览自动化测试，不再作为主题素材，不打入应用。旧山青蓝/西野红的 SVG 背景已移除。

### 历史测试图片的生成提示词

```text
Use case: stylized-concept. Asset type: a high-resolution landscape 16:9 desktop background painting, ideally 2560 by 1440 pixels, with no interface. Create a luminous impressionist oil painting of looking upward through gently swaying leafy trees toward a beautiful natural blue sky with soft white cumulus clouds. The desired feeling is sunlight and dappled shade beneath trees, with distinct leaf clusters and slender dark branches framing openings of sky; recognizable trees, sky and clouds, not a blue-green abstract blend. Leafy boughs enter from the upper left and side edges, with a looser canopy across the lower edge. Leave a generous calm opening of blue sky and drifting white clouds through the center and upper right. Use expressive visible oil brushstrokes, layered pigment, subtle canvas texture, natural plant greens ranging from warm sunlit sap green to cool deep-green shadow, clear cerulean and azure sky, warm creamy cloud highlights. Balanced airy composition, peaceful summer sunlight, subtle sense of a breeze, painterly rather than photorealistic. This painting will sit behind translucent glass terminal panels in a desktop application, so prefer medium-scale readable forms and a calm center over fussy tiny detail. Keep the painting naturally bright; the application will add its own readability tint. No people, no buildings, no mountains, no roads, no text, no logos, no borders, no fake UI, no neon colors, no smooth gradient wallpaper.
```
