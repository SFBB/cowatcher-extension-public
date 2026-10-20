# Netflix AI Subtitle Translator - Popup UI Guide

This document provides a comprehensive guide to all features, controls, settings, and performance tuning options available in the extension's popup interface.

---

## Table of Contents
1. [Header & Master Controls](#1-header--master-controls)
2. [AI Service Provider Setup (Ollama vs. OpenRouter)](#2-ai-service-provider-setup)
3. [Language & Subtitle Display Preferences](#3-language--subtitle-display-preferences)
4. [Show Context & Supervisor Memory](#4-show-context--supervisor-memory)
5. [Dual-Model Pipeline Performance Tuning](#5-dual-model-pipeline-performance-tuning)
6. [Subtitle Appearance & Synchronization](#6-subtitle-appearance--synchronization)
7. [Quick Test & Connectivity Verification](#7-quick-test--connectivity-verification)
8. [Troubleshooting & Best Practices](#8-troubleshooting--best-practices)

---

## 1. Header & Master Controls

### 1.1 Global AI Subtitle Toggle (`#enabled-toggle`)
- **Location**: Top-right switch in the header.
- **Function**: Toggles AI subtitle translation on or off globally.
- **Status**:
  - Green (ON): Actively intercepts subtitle streams and renders AI bilingual subtitles.
  - Gray (OFF): Suspends background inference, hides the AI overlay, and restores the native Netflix subtitles.
  - **Hotkey**: You can toggle this anytime in Netflix with **`Alt + T`**.

### 1.2 Ko-fi Support Button (`☕`)
- **Location**: Header top-right and popup bottom.
- **Function**: Opens the author's [Ko-fi donation page](https://ko-fi.com/sfbb49898) in a new browser tab.

### 1.3 Service Connection Status Card (`#status-card`)
- **Status Indicator**:
  - 🟢 **Green (Connected)**: Active service connected; model list fetched successfully.
  - 🟡 **Yellow (Checking / Warning)**: Verifying connection or awaiting valid models.
  - 🔴 **Red (Disconnected / Error)**: Failed to reach local Ollama server or invalid OpenRouter API credentials.
- **Refresh Button (`🔄`)**: Manually re-probes the active provider and refreshes the list of available models.

---

## 2. AI Service Provider Setup

Choose your preferred AI backend using the **🤖 AI Service Provider (`#ai-provider`)** dropdown:

### 2.1 Local Inference: Ollama (Local / Privacy-first)
Best for users with dedicated NVIDIA/Apple Silicon GPUs who want complete privacy and zero API costs.

| Control | Element ID | Recommended Value | Description |
| :--- | :--- | :--- | :--- |
| **Ollama API URL** | `#ollama-host` | `http://localhost:11434` | Endpoint of your local or LAN Ollama instance. Click **Connect** to save and fetch models. |
| **Translation Model** | `#translation-model` | `translategemma:4b` | Model responsible for fast lookahead batch translation. Automatically populated via `/api/tags`. |
| **Supervisor Model** | `#supervisor-model` | `gemma4:e4b` | Model responsible for context warmup, consistency auditing, and character glossary maintenance. |

> **Tip**: If you encounter CORS or 403 errors on Linux/macOS, launch Ollama with `OLLAMA_ORIGINS="*" ollama serve`.

---

### 2.2 Cloud Inference: OpenRouter (Cloud / Multi-model)
Ideal for laptops, lightweight machines, or users desiring state-of-the-art models (DeepSeek V3, Gemini 2.5 Flash/Pro, Claude 3.5 Haiku, etc.).

| Control | Element ID | Recommended Value | Description |
| :--- | :--- | :--- | :--- |
| **OpenRouter API Key** | `#openrouter-api-key` | `sk-or-v1-...` | Your personal API key from [openrouter.ai/keys](https://openrouter.ai/keys). Stored securely in local browser storage. Click 👁️ to toggle visibility; click **Connect** to validate. |
| **OpenRouter Translation Model** | `#openrouter-translation-model` | `deepseek/deepseek-chat` or `google/gemini-2.5-flash` | Preset with high-value models, dynamically populated with the full OpenRouter catalog. |
| **Custom Translation Model ID** | `#openrouter-custom-translation-model` | e.g. `qwen/qwen-2.5-72b-instruct` | Displayed when selecting "✏️ Enter custom model ID..." to use any model on OpenRouter. |
| **OpenRouter Supervisor Model** | `#openrouter-supervisor-model` | `google/gemini-2.5-flash` | Cloud model for multi-batch review and character glossary auditing. |
| **Custom Supervisor Model ID** | `#openrouter-custom-supervisor-model` | e.g. `google/gemini-2.5-pro` | Displayed when selecting custom supervisor model ID. |

---

### 2.3 Supervisor Model Master Switch (`#enable-supervisor`)
- **Function**: Enables or disables the secondary supervisor model.
- **Enable when**: Watching complex dramas or anime with frequent nicknames and honorifics.
- **Disable when**: Constrained by local GPU VRAM or looking to minimize OpenRouter token usage.

---

## 3. Language & Subtitle Display Preferences

### 3.1 UI Language (`#ui-language`)
- Select between **English**, **中文 (Chinese)**, **日本語 (Japanese)**, and **한국어 (Korean)**.
- Interface labels and hints update immediately.

### 3.2 Target Translation Language (`#target-language`)
- Supports 15 languages: English, 简体中文, 繁體中文, 日本語, 한국어, Español, Français, Deutsch, Italiano, Português, Русский, Tiếng Việt, Bahasa Indonesia, ภาษาไทย, العربية.
- **Context Isolation**: Each target language maintains an independent show context and glossary store.

### 3.3 Subtitle Display Mode (`#display-mode`)
1. **Bilingual (Translation + Original)**: Primary translated line on top, original dialogue underneath (recommended).
2. **Translation Only**: Clean display showing only the AI-translated text.
3. **Original Only**: Displays beautifully styled original-language dialogue without translation.

### 3.4 Hide Netflix Native Subtitles (`#hide-native-subs`)
- **Default**: ON (recommended).
- Hides the native Netflix timed-text rendering layer using CSS transparency while maintaining network track interception, preventing overlapping text.

---

## 4. Show Context & Supervisor Memory

The **🎬 Show Context & Supervisor Memory** card displays real-time memory accumulated for the currently playing title:

- **Show Title (`#show-title`)**: Displays detected title and season.
- **Memory Badge (`#memory-badge`)**: Indicates state (`Pending`, `Ready`, `Auditing`).
- **Show Synopsis (`#show-synopsis`)**: Brief context summary established by the supervisor during warmup.
- **Glossary Tags (`#glossary-tags`)**:
  - Lists verified character aliases (e.g. `Shou-chan ➔ Shoko Nishimiya`).
  - Click the `×` on any badge to delete the mapping.
- **Manual Term Editor (`#input-term-orig ➔ #input-term-trans`)**:
  - Manually input character name or special term and click **Save** to enforce strict translation consistency.
- **Reset Button (`#btn-reset-context`)**:
  - Clears all cached glossary and synopsis data for this show to trigger fresh warmup.

---

## 5. Dual-Model Pipeline Performance Tuning

The extension automatically switches between optimized pipeline presets for **Ollama** and **OpenRouter**, while retaining any custom adjustments you make.

### 5.1 Dynamic Cue Batch & Buffer Parameters

#### ① Min Batch Cues (`min_cue` / `#min-translate-cues`)
- **Range**: 1 to 20 cues (Default: 1 cue).
- **Mechanism**: The minimum number of cues required in buffer before dispatching an inference call. Setting this to 1 guarantees immediate handling of sparse dialogue.
- **Seek Burst**: When jumping or seeking to an uncached timeline, the extension automatically dispatches `Math.max(min_cue, 6)` cues. This guarantees first-cue display within 400ms while quickly seeding a safe buffer.
- **Tail Exemption**: At the end of the video or raw subtitle track, the `min_cue` threshold is automatically bypassed so that remaining cues are translated immediately, preventing trailing dialogue from being truncated or missed.

#### ② Max Batch Cues (`max_cue` / `#max-translate-cues`)
- **Range**: 10 to 150 cues.
- **Presets**:
  - **Ollama**: 30 cues (prevents local model output cutoff or VRAM exhaustion).
  - **OpenRouter**: 100 cues (capitalizes on cloud LLM context windows and reduces API round trips).

#### ③ Auto-Refill Threshold (`refill_threshold` / `#refill-threshold`)
- **Range**: 2 to 40 cues.
- **Presets**: Ollama 10 cues; OpenRouter 20 cues.
- **Description**: Triggers pre-translation of the next batch whenever remaining unplayed cues fall below this number.

### 5.2 Supervisor Review Batch Size (`reviewBatchSize` / `#review-batch-size`)
- **Range**: 2 to 40 cues.
- **Presets**: Ollama 8 cues; OpenRouter 20 cues.
- **Description**: Number of translated dialogues audited together in a single prompt.

---

## 6. Subtitle Appearance & Synchronization

### 6.1 Subtitle Visual Styling
- **Subtitle Font Size (`#font-size`)**: 18px to 44px (default: 26px).
- **Subtitle Background Opacity (`#bg-opacity`)**: 0% (fully transparent) to 100% (solid black).
- **Bottom Margin (`#sub-offset`)**: 40px to 180px (default: 80px), elevates subtitles above Netflix controls.
- **Smaller Original Subtitle (`#show-original-smaller`)**: Renders original dialogue at 75% font size in bilingual mode.
- **Glass Style Box (`#enable-glass-effect`)**: Adds frosted backdrop blur with polished borders.
- **Subtitle Fade Animation (`#enable-animation`)**:
  - **Default: OFF**: Instant, crisp subtitle transitions with zero flicker.
  - **ON**: Smooth fade-in and fade-out animations.

### 6.2 Subtitle Synchronization Offset
- **Earlier (+0.5s)**: Shifts subtitles 0.5s earlier (Hotkeys: `[` or `Alt + [`).
- **Later (-0.5s)**: Shifts subtitles 0.5s later (Hotkeys: `]` or `Alt + ]`).
- **Reset**: Resets offset to 0.0s (Hotkeys: `\` or `Alt + \`).
- **DOM Subtitle Text Auto-Calibration (`#enable-dom-sync`)**:
  - Compares visible native Netflix subtitles to correct subtle drift (Default: OFF; Cadmium player API handles sync automatically).

---

## 7. Quick Test & Connectivity Verification

Verify your model configuration directly inside the popup without opening Netflix:

1. Type any sample text into the input box.
2. Click **Test**.
3. **Phase 1**: Tests the translation model and displays the translated text along with round-trip latency (ms).
4. **Phase 2**: If the supervisor model is enabled, audits the translation and displays supervisor review feedback and latency.

---

## 8. Troubleshooting & Best Practices

### Problem: Local Ollama subtitle generation is too slow
- Switch to a lightweight model such as `translategemma:4b` or `qwen2.5:3b`.
- Increase `max_cue` to 40 and `Auto-Refill Threshold` to 15 to translate earlier ahead of time.
- Disable the supervisor model (`#enable-supervisor`) if your GPU has limited VRAM.

### Problem: Using OpenRouter with high speed and low cost
- Set provider to **OpenRouter**.
- Select `deepseek/deepseek-chat` (superb translation quality and ultra-low cost) or `google/gemini-2.5-flash` (lightning-fast).
- Set supervisor model to `google/gemini-2.5-flash`.
- Use default OpenRouter presets (`max_cue` = 100, `reviewBatchSize` = 20).
