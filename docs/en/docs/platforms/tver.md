# TVer Platform Guide

[TVer](https://tver.jp/) is Japan's premier commercial broadcast streaming service, hosting the latest Japanese dramas, anime, and variety shows.

---

## Core Features

- **Instant Japanese Dual Subtitles**: Intercepts official Japanese broadcast subtitle tracks and produces real-time AI bilingual subtitles.
- **Fullscreen Adaptive Mounting**: Tailored for TVer's VideoJS player architecture (`EpisodePlayer_container`). Subtitle overlays and player buttons mount cleanly inside the player container across standard and fullscreen viewports.
- **Commercial Ad Detection & Muting**:
  - Automatically detects preroll and midroll video advertisements on TVer.
  - Subtitles are suppressed and background AI inference is paused during ad breaks, resuming instantly when the show continues.

---

## Tips & Troubleshooting

1. **Subtitle Availability**: Ensure the TVer episode offers closed captions (indicated by the CC/字幕 button in TVer's native player controls).
2. **Reload / Retry**: Press **`Alt + T`** at any point during playback to toggle or trigger a subtitle re-probe.
