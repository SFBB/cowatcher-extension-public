import { defineConfig } from "vitepress";

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: "CoWatcher",
  description:
    "AI Dual Subtitles, Real-Time Translation, Language Immersion & More",
  base: process.env.VITEPRESS_BASE || "/cowatcher-extension-public/",
  appearance: "dark",
  head: [
    ["link", { rel: "icon", type: "image/png", href: "/icons/icon48.png" }],
    [
      "script",
      {},
      `
      (function() {
        try {
          var path = window.location.pathname;
          if (path.indexOf('/zh/') !== -1) {
            localStorage.setItem('ncw_page_lang', 'zh');
          } else if (path.indexOf('/en/') !== -1) {
            localStorage.setItem('ncw_page_lang', 'en');
          }
        } catch (e) {}
      })();
      `,
    ],
  ],
  locales: {
    en: {
      label: "English",
      lang: "en",
      link: "/en/",
      themeConfig: {
        nav: [
          { text: "Home", link: "/en/" },
          { text: "Quickstart", link: "/en/quickstart" },
          {
            text: "AI Providers",
            items: [
              { text: "Ollama (Local / GPU)", link: "/en/providers/ollama" },
              { text: "OpenRouter (Cloud)", link: "/en/providers/openrouter" },
            ],
          },
          {
            text: "Platforms",
            items: [
              { text: "Netflix", link: "/en/platforms/netflix" },
              { text: "TVer (Japan)", link: "/en/platforms/tver" },
              { text: "YouTube", link: "/en/platforms/youtube" },
            ],
          },
          { text: "Architecture", link: "/en/architecture" },
        ],
        sidebar: [
          {
            text: "Getting Started",
            items: [
              { text: "Quickstart", link: "/en/quickstart" },
              { text: "Popup Interface Guide", link: "/en/guide/popup" },
            ],
          },
          {
            text: "AI Providers Setup",
            items: [
              {
                text: "Ollama (Local Inference)",
                link: "/en/providers/ollama",
              },
              {
                text: "OpenRouter (Cloud Models)",
                link: "/en/providers/openrouter",
              },
            ],
          },
          {
            text: "Supported Platforms",
            items: [
              { text: "Netflix", link: "/en/platforms/netflix" },
              { text: "TVer", link: "/en/platforms/tver" },
              { text: "YouTube", link: "/en/platforms/youtube" },
            ],
          },
          {
            text: "Advanced Configuration",
            items: [
              { text: "Dual-Model Pipeline", link: "/en/advanced/dual_model" },
            ],
          },
          {
            text: "Developer & Architecture",
            items: [{ text: "System Architecture", link: "/en/architecture" }],
          },
        ],
      },
    },
    zh: {
      label: "简体中文",
      lang: "zh-CN",
      link: "/zh/",
      themeConfig: {
        nav: [
          { text: "首页", link: "/zh/" },
          { text: "快速开始", link: "/zh/quickstart" },
          {
            text: "AI 服务商配置",
            items: [
              { text: "Ollama 本地显卡部署", link: "/zh/providers/ollama" },
              { text: "OpenRouter 云端模型", link: "/zh/providers/openrouter" },
            ],
          },
          {
            text: "平台使用指南",
            items: [
              { text: "Netflix (网飞)", link: "/zh/platforms/netflix" },
              { text: "TVer (日剧/日本电视)", link: "/zh/platforms/tver" },
              { text: "YouTube", link: "/zh/platforms/youtube" },
            ],
          },
          { text: "系统架构", link: "/zh/architecture" },
        ],
        sidebar: [
          {
            text: "入门指南",
            items: [
              { text: "快速开始", link: "/zh/quickstart" },
              { text: "弹窗面板与快捷键指南", link: "/zh/guide/popup" },
            ],
          },
          {
            text: "AI 服务商配置",
            items: [
              { text: "Ollama 本地模型配置", link: "/zh/providers/ollama" },
              {
                text: "OpenRouter 云端 API 配置",
                link: "/zh/providers/openrouter",
              },
            ],
          },
          {
            text: "流媒体平台指南",
            items: [
              { text: "Netflix 使用技巧", link: "/zh/platforms/netflix" },
              { text: "TVer 播放器全屏适配", link: "/zh/platforms/tver" },
              { text: "YouTube 双语字幕", link: "/zh/platforms/youtube" },
            ],
          },
          {
            text: "进阶调优",
            items: [
              { text: "双模型流水线调优", link: "/zh/advanced/dual_model" },
            ],
          },
          {
            text: "架构与开发",
            items: [{ text: "核心架构白皮书", link: "/zh/architecture" }],
          },
        ],
      },
    },
  },
  themeConfig: {
    socialLinks: [
      { icon: "github", link: "https://github.com/SFBB/NetflixCoWatcher" },
    ],
    search: {
      provider: "local",
    },
    footer: {
      message: "Released under the MIT License.",
      copyright: "Copyright © 2026 CoWatcher Contributors",
    },
  },
});
