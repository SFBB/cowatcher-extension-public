# Ollama Local Model Setup Guide

**Ollama** is ideal for users with dedicated GPUs (NVIDIA or Apple Silicon) who want **zero API costs** and **100% offline privacy**. All subtitle streams are processed entirely on your local machine.

---

## 1. Install & Pull Models

1. Download and install Ollama from [ollama.com](https://ollama.com/).
2. Pull recommended models in your terminal:
   ```bash
   # Blazing-fast specialized translation model
   ollama pull translategemma:4b

   # High-accuracy general bilingual model
   ollama pull qwen2.5:7b
   ```

---

## 2. Essential Step: Enable CORS

> [!CAUTION]
> Browser extensions requesting `http://localhost:11434` will be blocked by CORS unless Ollama is instructed to permit origins.

### macOS
Launch Ollama from terminal with:
```bash
OLLAMA_ORIGINS="*" ollama serve
```

### Linux (Systemd)
1. Edit service overrides:
   ```bash
   sudo systemctl edit ollama.service
   ```
2. Add the environment variable:
   ```ini
   [Service]
   Environment="OLLAMA_ORIGINS=*"
   ```
3. Reload and restart:
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl restart ollama
   ```

### Windows
1. Quit Ollama from the system tray.
2. Open System Environment Variables.
3. Under User Variables, add:
   - Variable name: `OLLAMA_ORIGINS`
   - Variable value: `*`
4. Relaunch Ollama.

---

## 3. Connecting from CoWatcher

1. Open the CoWatcher popup.
2. Select **Ollama** in the **AI Service Provider** dropdown.
3. Set **Ollama API URL** to `http://localhost:11434`.
4. Click **Connect**:
   - The status card will turn 🟢 **Connected**.
   - Model dropdowns will automatically populate with your locally installed models.
5. Select your desired **Translation Model** and **Supervisor Model**, then start watching!
