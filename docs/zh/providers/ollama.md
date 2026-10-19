# Ollama 本地模型配置指南

**Ollama** 适合追求 **完全免费** 和 **100% 隐私安全** 的用户。所有影视字幕的推理和翻译均在你自己的电脑显卡（NVIDIA GPU 或 Apple Silicon）上离线完成，不会上传任何数据至云端。

---

## 1. 安装与启动 Ollama

1. 访问 [Ollama 官方网站](https://ollama.com/) 下载并安装对应系统的客户端。
2. 打开终端，拉取推荐的模型：
   ```bash
   # 推荐的高速翻译模型
   ollama pull translategemma:4b
   # 或者通用性能优异的 Qwen 2.5
   ollama pull qwen2.5:7b
   ```

---

## 2. 关键避坑：配置跨域（CORS）

> [!CAUTION]
> 浏览器扩展从网页环境访问本地 `http://localhost:11434` 时，如果未配置允许跨域，浏览器会拦截请求，导致 CoWatcher 面板显示 **🔴 Disconnected (CORS Error)**。

根据你的操作系统进行配置：

### macOS
打开终端，使用允许跨域的环境变量启动：
```bash
OLLAMA_ORIGINS="*" ollama serve
```
或者在全局 LaunchAgent 设置环境变量并重启 Ollama。

### Linux (Systemd)
1. 编辑 systemd 服务配置：
   ```bash
   sudo systemctl edit ollama.service
   ```
2. 在打开的文件中添加：
   ```ini
   [Service]
   Environment="OLLAMA_ORIGINS=*"
   ```
3. 保存并重载服务：
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl restart ollama
   ```

### Windows
1. 在任务栏退出 Ollama 图标。
2. 打开系统 **环境变量** 设置（Windows 键搜索“环境变量”）。
3. 在 **用户变量** 或 **系统变量** 中新建：
   - 变量名：`OLLAMA_ORIGINS`
   - 变量值：`*`
4. 重新启动 Ollama。

---

## 3. 在 CoWatcher 中连接

1. 点击浏览器右上角 CoWatcher 图标。
2. 在 **AI Service Provider** 下拉菜单选择 **Ollama**。
3. **Ollama API URL**：保持默认 `http://localhost:11434`（如果 Ollama 运行在局域网另一台主机，请输入对应 IP 如 `http://192.168.1.100:11434`）。
4. 点击 **Connect** 按钮：
   - 连接成功后，指示卡片变为 🟢 **Connected**。
   - 下方 **Translation Model** 和 **Supervisor Model** 会自动加载你本地已拉取的模型列表。
5. 分别选择你下载的模型并保存即可。
