# OpenRouter Cloud Models Setup Guide

**OpenRouter** is a unified cloud gateway offering access to 200+ state-of-the-art AI models (DeepSeek V3, Gemini 2.5 Flash, Claude 3.5 Haiku, GPT-4o, and more).

It is the optimal choice for lightweight laptops without dedicated GPUs, or users seeking studio-quality cinematic translations.

---

## 1. Obtain an API Key

1. Sign up at [OpenRouter.ai](https://openrouter.ai/).
2. Navigate to [Keys](https://openrouter.ai/keys) and click **Create Key**.
3. Copy your newly generated key (`sk-or-v1-...`).
4. (Optional) Add a small credit balance (e.g. $5 is enough to translate dozens of full TV seasons).

---

## 2. Recommended Model Pairings

| Use Case | Translation Model | Supervisor Model | Highlights |
| :--- | :--- | :--- | :--- |
| **Best Value (Recommended)** | `deepseek/deepseek-chat` | `google/gemini-2.0-flash-001` | Highly idiomatic, ultra-affordable (~$0.005 per episode). |
| **Ultra-Low Latency** | `google/gemini-2.0-flash-001` | `google/gemini-2.0-flash-001` | Sub-second response time with near-instant lookahead. |
| **Studio Quality** | `anthropic/claude-3.5-haiku` | `anthropic/claude-3.5-haiku` | Nuanced dialogue, natural rhetoric, exceptional humor handling. |

---

## 3. Configuring CoWatcher

1. Open the CoWatcher popup panel.
2. Select **OpenRouter** in the **AI Service Provider** dropdown.
3. Paste your API key into the **OpenRouter API Key** input.
4. Click **Connect**:
   - CoWatcher validates the key and dynamically fetches the available model catalog.
   - The status indicator turns 🟢 **Connected**.
5. Select your **Translation Model** and **Supervisor Model**, then enjoy your shows!
