# OpenRouter 云端模型配置指南

**OpenRouter** 是目前最方便的统一云端 AI 网关。它聚合了全球 200+ 顶尖大语言模型（包括 DeepSeek V3、Gemini 2.5 Flash、Claude 3.5 Haiku、GPT-4o 等）。

如果你使用的是轻薄本、没有独立显卡，或者希望获得专业文学级的字幕翻译水准，推荐使用 OpenRouter。

---

## 1. 获取 OpenRouter API Key

1. 前往 [OpenRouter 官网](https://openrouter.ai/) 注册账号。
2. 访问 [Keys 管理页面](https://openrouter.ai/keys)，点击 **Create Key** 生成一个新的 API 密钥。
3. 复制生成的密钥（格式通常为 `sk-or-v1-...`）。
4. （可选）为账户充值少量余额（如 $5 即可翻译几十部整季剧集）。

---

## 2. 推荐模型搭配

| 场景需求 | 推荐翻译模型 (Translation) | 推荐监督模型 (Supervisor) | 特点与性价比 |
| :--- | :--- | :--- | :--- |
| **极致性价比 (推荐)** | `deepseek/deepseek-chat` | `google/gemini-2.0-flash-001` | 速度极快，翻译地道，单集成本约 $0.005 |
| **极速低延迟** | `google/gemini-2.0-flash-001` | `google/gemini-2.0-flash-001` | 首字响应极快，几乎零等待 |
| **专业文学级质感** | `anthropic/claude-3.5-haiku` | `anthropic/claude-3.5-haiku` | 语境拿捏极准，修辞自然，适合高难度影视 |

---

## 3. 在 CoWatcher 中配置

1. 打开 CoWatcher 扩展弹窗面板。
2. 在 **AI Service Provider** 下拉菜单选择 **OpenRouter**。
3. 在 **OpenRouter API Key** 输入框中粘贴你的密钥。
4. 点击 **Connect** 按钮：
   - 扩展会自动向 OpenRouter 校验密钥，并动态拉取最新可用模型列表。
   - 验证成功后状态指示卡片变为 🟢 **Connected**。
5. 在下拉列表中选择你的 **Translation Model** 与 **Supervisor Model** 即可生效。
