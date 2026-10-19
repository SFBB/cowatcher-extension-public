# Quickstart Guide

Welcome to **CoWatcher**! This guide will walk you through installing the browser extension, connecting your AI inference provider, and enjoying AI dual subtitles in under 3 minutes.

---

## 1. Installing the Extension

### Method A: Google Chrome / Brave / Edge (Chromium)
1. Clone and build the distribution:
   ```bash
   git clone https://github.com/SFBB/NetflixCoWatcher.git
   cd cowatcher-extension-public
   npm install
   npm run build:chrome
   ```
2. Navigate to `chrome://extensions/` in your browser.
3. Enable **Developer mode** using the toggle in the top-right corner.
4. Click **Load unpacked** in the top-left corner.
5. Select the `dist/` directory inside the repository.

### Method B: Mozilla Firefox
1. Build the Firefox Manifest V3 distribution:
   ```bash
   npm run build:firefox
   ```
2. Navigate to `about:debugging#/runtime/this-firefox` in Firefox.
3. Click **Load Temporary Add-on...**.
4. Select the `dist-firefox/manifest.json` file inside the repository.

---

## 2. Connecting Your AI Provider

Click the **CoWatcher** icon in your browser toolbar to open the popup:

1. **Choose an AI Provider**:
   - **Ollama**: Recommended for users with dedicated GPUs who want 100% privacy and zero API costs. See [Ollama Setup Guide](/en/providers/ollama).
   - **OpenRouter**: Recommended for cloud inference using cutting-edge models (DeepSeek V3, Gemini 2.5 Flash, Claude 3.5 Haiku). See [OpenRouter Setup Guide](/en/providers/openrouter).
2. **Select Target Language**:
   - Choose your preferred target language in the **Target Language** selector.
3. **Verify Status**:
   - The status indicator in the top right will turn 🟢 **Connected** when the backend is reachable.

---

## 3. Enjoy Dual Subtitles

Navigate to any supported streaming platform:
- [Netflix](https://www.netflix.com/)
- [TVer (Japan)](https://tver.jp/)
- [YouTube](https://www.youtube.com/)

### Essential Controls
- **Toggle Hotkey**: Press **`Alt + T`** anywhere on the watch page to toggle AI bilingual subtitles on or off instantly.
- **In-Player Button**: Look for the CoWatcher companion button injected directly into the video player controls.
- **Fullscreen Ready**: Subtitles automatically rescale and center themselves in fullscreen mode.

---

## Next Steps
- Read the full [Popup Interface Guide](/en/guide/popup)
- Platform Guides: [Netflix](/en/platforms/netflix) · [TVer](/en/platforms/tver) · [YouTube](/en/platforms/youtube)
- Learn how the [Dual-Model Pipeline](/en/advanced/dual_model) ensures consistent translations.
