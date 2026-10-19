# 快速开始指南

欢迎使用 **CoWatcher**！本指南将带你在 3 分钟内完成浏览器扩展的安装、配置并开始在流媒体平台畅享 AI 双语字幕。

---

## 1. 安装与载入扩展

### 方式 A：Google Chrome / Edge / Brave 等 Chromium 内核浏览器
1. 从 GitHub 仓库获取最新打包文件或自行编译：
   ```bash
   git clone https://github.com/SFBB/NetflixCoWatcher.git
   cd cowatcher-extension-public
   npm install
   npm run build:chrome
   ```
2. 打开浏览器，在地址栏输入 `chrome://extensions/` 并回车。
3. 打开右上角的 **开发者模式 (Developer mode)** 开关。
4. 点击左上角的 **加载已解压的扩展程序 (Load unpacked)** 按钮。
5. 选择项目目录下的 `dist/` 文件夹。

### 方式 B：Mozilla Firefox
1. 编译 Firefox 专属版本：
   ```bash
   npm run build:firefox
   ```
2. 打开 Firefox，在地址栏输入 `about:debugging#/runtime/this-firefox`。
3. 点击 **临时载入附加组件 (Load Temporary Add-on...)**。
4. 选择项目目录下的 `dist-firefox/manifest.json` 文件。

---

## 2. 首次启动与 AI 服务连接

安装完成后，点击浏览器工具栏右上角的 **CoWatcher** 图标打开面板：

1. **选择 AI 提供商**：
   - 如果你有独立显卡（NVIDIA / Apple Silicon）并追求 **完全免费与绝对隐私**，推荐选择 **Ollama**。详见 [Ollama 配置指南](/zh/providers/ollama)。
   - 如果你想使用目前最强的云端大模型（DeepSeek V3、Gemini 2.5 Flash、Claude 等），推荐选择 **OpenRouter**。详见 [OpenRouter 配置指南](/zh/providers/openrouter)。
2. **设置目标翻译语言**：
   - 在面板中将 **Target Language** 设置为你偏好的母语（如 `Chinese (Simplified)` 简体中文）。
3. **确认连接指示灯**：
   - 面板右上角的状态卡片显示 🟢 **Connected** 时，表示模型与服务正常连接。

---

## 3. 在流媒体中开启双语字幕

打开任意支持的视频流媒体网站：
- [Netflix (网飞)](https://www.netflix.com/)
- [TVer (日本电视/日剧)](https://tver.jp/)
- [YouTube](https://www.youtube.com/)

### 快捷控制方式
- **全局快捷键**：在播放器页面任意时刻按下 **`Alt + T`**，即可一键开启或关闭 AI 双语字幕。
- **播放器控制按钮**：播放器工具栏旁会自动注入 CoWatcher 的专属控制按钮，点击即可实时呼出快速控制浮层。
- **全屏自适应**：进入全屏播放后，字幕会自动调整缩放比例并居中挂载，完全不遮挡原生播放进度条。

---

## 下一步阅读
- 深入了解 [弹窗面板与快捷键指南](/zh/guide/popup)
- 查看流媒体专属调优：[Netflix 说明](/zh/platforms/netflix) · [TVer 说明](/zh/platforms/tver) · [YouTube 说明](/zh/platforms/youtube)
- 探索 [双模型流水线架构与调优](/zh/advanced/dual_model)
