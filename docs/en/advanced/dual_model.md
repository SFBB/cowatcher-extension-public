# Dual-Model Pipeline Tuning Guide

Traditional AI subtitle tools suffer from an awkward trade-off: line-by-line translation is either too slow for live audio playback, or disjointed without context—causing character names and idioms to fluctuate wildly from scene to scene.

**CoWatcher resolves this via an asynchronous Dual-Model Pipeline**.

---

## 1. How It Works

```
[Platform Subtitle Stream]
           │
           ▼
 ┌───────────────────────────┐
 │   Translation Model       │ ◄── Enriched with Show Glossary & Memory
 └─────────────┬─────────────┘
               │ Lookahead batch streaming
               ▼
   [Live Player Subtitle DOM]
               │
   (Async Background Audit & Extraction)
               ▼
 ┌───────────────────────────┐
 │   Supervisor Model        │ ──► Audits consistency, maintains names/glossary
 └───────────────────────────┘
```

1. **Translation Model**:
   - **Role**: Ultra-fast, responsive lookahead batch translation.
   - **Mission**: Pre-translates upcoming cues 10–30 seconds ahead of the video playhead so that playback is 100% latency-free.
   - **Recommended**: `translategemma:4b` (Ollama) or `deepseek/deepseek-chat` / `google/gemini-2.0-flash-001` (OpenRouter).

2. **Supervisor Model**:
   - **Role**: Reasoning, contextual summarization, and consistency auditing.
   - **Mission**: Asynchronously warms up show context, reconciles character aliases, maintains terminology consistency, and flags difficult slang.
   - **Recommended**: `qwen2.5:7b` (Ollama) or `google/gemini-2.0-flash-001` / `anthropic/claude-3.5-haiku` (OpenRouter).

---

## 2. Tuning Performance Parameters

Tune these options in the **Dual-Model Pipeline Performance Tuning** section of the popup:

### Batch Size
- **Recommended**: `5` – `10` cues
- Determines how many consecutive cues are grouped into a single LLM prompt. Balances syntactic coherence with prompt round-trip time.

### Lookahead Window
- **Recommended**: `15` – `30` seconds
- Determines how far ahead of the current playhead the engine pre-fetches and translates subtitles into local storage.

### Concurrency Limit
- **Local Ollama (GPU)**: Set to `1`. Prevents GPU VRAM exhaustion or serialization bottlenecks.
- **Cloud OpenRouter**: Set to `2` – `4`. Takes advantage of serverless parallelism to dramatically speed up buffer filling.
