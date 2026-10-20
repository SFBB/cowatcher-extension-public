# Contributing to CoWatcher

Thank you for your interest in contributing to **CoWatcher**! 🎉
Whether you are adding support for a new streaming platform, fixing a bug, enhancing AI translation pipelines, or refining UI performance, your contributions are warmly welcomed.

---

## 1. Code of Conduct

We are committed to providing a welcoming, inclusive, and harassment-free environment for everyone.

- **Be respectful and constructive**: Treat fellow contributors with kindness, empathy, and professionalism.
- **Focus on technical merits**: Critique ideas and code constructively, not individuals.
- **Open collaboration**: Welcome questions and help onboard new contributors.

If you encounter unacceptable behavior, please report it to [the project maintainers](mailto:cowatcher@proton.me).

---

## 2. Core Engineering Tenets (Must Read Before Contributing)

Before writing or reviewing code, every contributor must understand and practice our five non-negotiable architectural tenets:

### 1. Explicit over Implicit

- We discourage `any` or `object` but that doesn't mean you cannot use it. If possible, you should specify a carefully defined data type instead of some guessing about object, array, or whatever.
- If your data type is shared with more than one class, or in other words, if it is not some internal using only data type, you should define it in a domain dir in its related scope. The scopes means the root dir like `content`, `injected`, `background`, and so on. If such data type is shared across scopes, it should be defined under `shared`'s domain.

We don't want anyone to guess other's work or purpose. An explicit defined data type means an explicit function with explicit parameters and return types. It will make following development easier and more maintainable.

### 2. No Silent Fallbacks (Fail-Fast Principle)

In other languages, you might hear fallback as some advanced techniques, but it is not the case here. In js/ts, there are too many fallbacks including guessing a data type and write at least three fallbacks to handle it, which is just bullshit and meaningless! In our business logic(You can understand this as any codes excepts adapter related codes), fallback is discouraged! Just let this program crash and throw error! We prefer error message or stack trace to tell us which is wrong rather than silently handling it. You declare you only accept specific carefully defined data types, then, if your down-stream uses a wrong data type, just let them shoot their own feet!

ADAPTERs are exceptional. You can write as many fallback as you like for adapters as long as it works! But in practice, a carefully design is more important than fallbacks.

### 3. Strictly No Anemic DTOs

> [!IMPORTANT]
> **Data Transfer Objects (DTOs) are NOT allowed anywhere in this repository.**

Currently, we disallows any DTOs to exist in this project.

Indeed, we use message to communicate between different browser components, but those are all our own logic. We don't have split brain problem and should never have.

### 4. Platform Anti-Corruption Layer (ACL)

- Third-party streaming platforms (Netflix, TVer, YouTube, Disney+, etc.) have volatile DOMs and proprietary player engines.
- **Quarantine platform specifics**: Keep all proprietary APIs (Kadmium player, VideoJS, YouTube ytplayer), selectors, and raw subtitle format parsers inside `src/injected/infrastructure/adapters/<platform>/` and `src/content/infrastructure/adapters/<platform>/`. If you need new interface, define it in related adapter interfaces, just remember help existing adapters to implement it!
- The core domain (`SubtitleManager`, `SubtitleOverlay`, `TranslationPipelineService`) must stay completely platform-agnostic.

### 5. Packaging

- `package.json` is the sole authority for extension `version`, `displayName`, and `description`. Webpack injects these dynamically into both Chrome and Firefox manifests during compilation.

> 📖 **Deep Dive**: For full details on the multi-world architecture and domain layering, read [Architecture.md](file:///home/tom/Documents/codes/javascript/cowatcher-extension-public/Architecture.md).

---

## 3. Development Workflow & Setup

### Prerequisites

- [Node.js](https://nodejs.org/) (version 18 or higher recommended)
- `nvm` is your friend when handling multiple nodejs project
- `npm` (version 9 or higher)
- Google Chrome (or Chromium-based browser) and/or Mozilla Firefox

### Getting Started

1. **Clone the repository**:

   ```bash
   git clone https://github.com/SFBB/NetflixCoWatcher.git
   cd cowatcher-extension-public
   ```

2. **Install dependencies**:

   ```bash
   npm install
   // or
   npm ci // to get the same env with current project
   ```

3. **Build targets**:
   CoWatcher compiles to two separate browser distributions from a single codebase:

   ```bash
   # Build Chrome Manifest V3 (outputs to dist/)
   npm run build:chrome

   # Build Firefox Manifest V3 (outputs to dist-firefox/)
   npm run build:firefox

   # Build both targets simultaneously
   npm run build:all
   ```

4. **Watch mode during development**:

   ```bash
   # Watch Chrome build
   npm run watch

   # Watch Firefox build
   npm run watch:firefox
   ```

---

## 4. How to Load and Test Locally

### Google Chrome / Brave / Edge

1. Navigate to `chrome://extensions/`.
2. Enable **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked** and select the [`dist/`](file:///home/tom/Documents/codes/javascript/cowatcher-extension-public/dist) folder.
4. Whenever you make code changes, run `npm run build:chrome` and click the **Reload icon** on the CoWatcher extension card in `chrome://extensions/`.

### Mozilla Firefox

1. Navigate to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on...**.
3. Select [`dist-firefox/manifest.json`](file:///home/tom/Documents/codes/javascript/cowatcher-extension-public/dist-firefox/manifest.json).
4. Whenever you make code changes, run `npm run build:firefox` and click **Reload**.

### Debugging Contexts

CoWatcher runs across several sandboxes. To view logs:

- **Background Service Worker (Chrome)**:
  In `chrome://extensions/`, click **Inspect views: service worker** on the CoWatcher card.
- **Background Event Page (Firefox)**:
  In `about:debugging#/runtime/this-firefox`, click **Inspect** on CoWatcher.
- **Content Script (`ISOLATED` world)**:
  Open Developer Tools on the video page (`F12`) -> **Console** -> select the extension context in the top dropdown (e.g. `CoWatcher (Extension)`).
- **Injected Script (`MAIN` world)**:
  Open Developer Tools on the video page (`F12`) -> **Console** -> select `top` context.
- **Filter logs**: All internal logging uses the `Logger` utility with prefixes like `[content]`, `[injected]`, `[background]`, or `[netflix]`.

---

## 5. Coding Standards & Quality Gates

Before opening a pull request, verify that all quality checks pass:

### 1. Type Safety

```bash
npx tsc --noEmit
```

Must pass with **0 errors**. Avoid `any`. Use discriminated unions, strict null checks, and explicit return types on public functions.

### 2. Linting & Formatting

```bash
# Check for lint issues
npm run lint

# Automatically fix lint issues
npm run lint:fix

# Format code with Prettier
npm run format
```

### 3. Path Aliases

Always use configured TypeScript path aliases instead of fragile relative paths:

- `@shared/*` -> `src/shared/*`
- `@content/*` -> `src/content/*`
- `@injected/*` -> `src/injected/*`
- `@background/*` -> `src/background/*`
- `@popup/*` -> `src/popup/*`
- `@options/*` -> `src/options/*`

---

## 6. Adding Support for a New Platform

If you are adding a new streaming service (e.g., Disney+, Hulu, Crunchyroll):

1. Add the platform ID to [`StreamingPlatforms.ts`](file:///home/tom/Documents/codes/javascript/cowatcher-extension-public/src/shared/domain/constants/StreamingPlatforms.ts).
2. Create `src/injected/infrastructure/adapters/<platform>/<Platform>InjectedAdapter.ts` implementing `IInjectedAdapter` and register it in `injected.ts`.
3. Create `src/content/infrastructure/adapters/<platform>/<Platform>ContentAdapter.ts` implementing `IStreamingAdapter` and register it in `content.ts`.
   _(Remember: never return `document.body` in `getPlayerContainer()`)_.
4. Add URL match patterns to `manifest.json` and `manifest.firefox.json`.
5. See section 5 of [Architecture.md](file:///home/tom/Documents/codes/javascript/cowatcher-extension-public/Architecture.md) for detailed guidelines.

---

## 7. Pull Request Guidelines

1. **Branch Naming**:
   - `feature/<description>` for new capabilities or platforms.
   - `fix/<description>` for bug and selector fixes.
   - `refactor/<description>` for code restructuring.
2. **Commit Messages**:
   We encourage [Conventional Commits](https://www.conventionalcommits.org/):
   - `feat(tver): support full screen player subtitle mounting`
   - `fix(chrome): resolve MV3 background service worker registration`
   - `docs: update contributing guide and architectural tenets`
3. **PR Checklist**:
   - [ ] Code strictly follows the 5 Core Engineering Tenets (Explicit over implicit, no silent fallbacks, no DTOs, ACL platform isolation, packaging).
   - [ ] `npx tsc --noEmit` passes with 0 errors.
   - [ ] `npm run build:all` passes without warnings.
   - [ ] Tested locally on both Chrome (`dist/`) and Firefox (`dist-firefox/`).
   - [ ] Diagnostic logs added with `Logger` where appropriate.

Thank you for helping make CoWatcher the best bilingual watching experience! 🍿
