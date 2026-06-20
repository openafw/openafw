// A curated catalog of well-known model providers, so onboarding can offer a
// "pick a provider" menu instead of only asking for a raw base URL. Each entry
// carries the provider's base URL, its wire-format compatibility, and a list of
// its better-known models with the metadata afw's registry stores (label,
// vision, context window, max output). Modeled on the provider/model catalog
// references/openclaw ships per provider, flattened into afw's simpler shape:
// afw routes only the three wire formats it can translate, so providers that
// speak google-generative-ai / ollama / mistral-conversations, or that require
// OAuth/CLI/coding-plan auth, are intentionally left out — those still go
// through the "Custom" path.
//
// This is reference data, not a hard dependency: the catalog only seeds the
// onboarding prompts. A user can always pick "Custom" and type any URL, and the
// `afw model` / `afw route` surfaces accept anything the registry accepts.

/** The wire formats the wizard can pre-select — a subset of ModelApi expressed
 *  in the `afw model` wizard's ApiCompat vocabulary (api-key vs bearer auth is
 *  derived from this: anthropic → x-api-key header, the rest → bearer). */
export type CatalogApi = 'openai-chat' | 'openai-responses' | 'anthropic'

export type CatalogModel = {
  id: string
  label: string
  /** Accepts image input — drives the registry's text↔multimodal split. */
  vision?: boolean
  contextWindow?: number
  maxTokens?: number
}

export type CatalogProvider = {
  /** Stable id used as the default provider id + secret ref key. */
  id: string
  label: string
  baseUrl: string
  api: CatalogApi
  /** Where to get an API key — shown as a hint at the key prompt. */
  apiKeyUrl?: string
  /** When set, onboarding also offers an OAuth subscription login (afw runs
   *  its own login + token store). Keys into cli/oauth/login.ts's
   *  OAUTH_PROVIDERS. */
  oauthKey?: 'anthropic' | 'openai'
  /** Known models. May be empty for providers that only expose a live model
   *  listing (e.g. OpenRouter) — the wizard then asks for model ids by hand. */
  models: CatalogModel[]
}

export const PROVIDER_CATALOG: CatalogProvider[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    api: 'openai-responses',
    apiKeyUrl: 'https://platform.openai.com/api-keys',
    oauthKey: 'openai',
    models: [
      { id: 'gpt-5.5', label: 'GPT-5.5', vision: true, contextWindow: 1000000, maxTokens: 128000 },
      {
        id: 'gpt-5.4',
        label: 'GPT-5.4',
        vision: true,
        contextWindow: 272000,
        maxTokens: 128000,
      },
      {
        id: 'gpt-5.4-mini',
        label: 'GPT-5.4 mini',
        vision: true,
        contextWindow: 400000,
        maxTokens: 128000,
      },
      {
        id: 'gpt-5.3-codex',
        label: 'GPT-5.3 Codex',
        vision: true,
        contextWindow: 400000,
        maxTokens: 128000,
      },
      { id: 'o3', label: 'o3', vision: true, contextWindow: 200000, maxTokens: 100000 },
      { id: 'o4-mini', label: 'o4-mini', vision: true, contextWindow: 200000, maxTokens: 100000 },
    ],
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    api: 'anthropic',
    apiKeyUrl: 'https://console.anthropic.com/settings/keys',
    oauthKey: 'anthropic',
    models: [
      {
        id: 'claude-opus-4-8',
        label: 'Claude Opus 4.8',
        vision: true,
        contextWindow: 1048576,
        maxTokens: 128000,
      },
      {
        id: 'claude-opus-4-7',
        label: 'Claude Opus 4.7',
        vision: true,
        contextWindow: 200000,
        maxTokens: 64000,
      },
      {
        id: 'claude-sonnet-4-6',
        label: 'Claude Sonnet 4.6',
        vision: true,
        contextWindow: 200000,
        maxTokens: 64000,
      },
    ],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    api: 'openai-chat',
    apiKeyUrl: 'https://platform.deepseek.com/api_keys',
    models: [
      {
        id: 'deepseek-v4-pro',
        label: 'DeepSeek V4 Pro',
        contextWindow: 1000000,
        maxTokens: 384000,
      },
      {
        id: 'deepseek-v4-flash',
        label: 'DeepSeek V4 Flash',
        contextWindow: 1000000,
        maxTokens: 384000,
      },
      { id: 'deepseek-chat', label: 'DeepSeek Chat', contextWindow: 131072, maxTokens: 8192 },
      {
        id: 'deepseek-reasoner',
        label: 'DeepSeek Reasoner',
        contextWindow: 131072,
        maxTokens: 65536,
      },
    ],
  },
  {
    id: 'zai',
    label: 'Z.AI (GLM)',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    api: 'openai-chat',
    apiKeyUrl: 'https://z.ai/manage-apikey/apikey-list',
    models: [
      { id: 'glm-5.1', label: 'GLM-5.1', contextWindow: 202800, maxTokens: 131100 },
      { id: 'glm-5', label: 'GLM-5', contextWindow: 202800, maxTokens: 131100 },
      {
        id: 'glm-5v-turbo',
        label: 'GLM-5V Turbo',
        vision: true,
        contextWindow: 202800,
        maxTokens: 131100,
      },
      { id: 'glm-4.7', label: 'GLM-4.7', contextWindow: 204800, maxTokens: 131072 },
    ],
  },
  {
    id: 'moonshot',
    label: 'Moonshot (Kimi)',
    baseUrl: 'https://api.moonshot.ai/v1',
    api: 'openai-chat',
    apiKeyUrl: 'https://platform.moonshot.ai/console/api-keys',
    models: [
      {
        id: 'kimi-k2.6',
        label: 'Kimi K2.6',
        vision: true,
        contextWindow: 262144,
        maxTokens: 262144,
      },
      {
        id: 'kimi-k2.5',
        label: 'Kimi K2.5',
        vision: true,
        contextWindow: 262144,
        maxTokens: 262144,
      },
      {
        id: 'kimi-k2-thinking',
        label: 'Kimi K2 Thinking',
        contextWindow: 262144,
        maxTokens: 262144,
      },
    ],
  },
  {
    id: 'mistral',
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    api: 'openai-chat',
    apiKeyUrl: 'https://console.mistral.ai/api-keys',
    models: [
      {
        id: 'mistral-large-latest',
        label: 'Mistral Large',
        vision: true,
        contextWindow: 262144,
        maxTokens: 16384,
      },
      {
        id: 'mistral-medium-3-5',
        label: 'Mistral Medium 3.5',
        vision: true,
        contextWindow: 262144,
        maxTokens: 8192,
      },
      {
        id: 'codestral-latest',
        label: 'Codestral',
        contextWindow: 256000,
        maxTokens: 4096,
      },
      {
        id: 'devstral-medium-latest',
        label: 'Devstral 2',
        contextWindow: 262144,
        maxTokens: 32768,
      },
    ],
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    api: 'openai-chat',
    apiKeyUrl: 'https://console.groq.com/keys',
    models: [
      {
        id: 'openai/gpt-oss-120b',
        label: 'GPT OSS 120B',
        contextWindow: 131072,
        maxTokens: 65536,
      },
      { id: 'qwen/qwen3-32b', label: 'Qwen3 32B', contextWindow: 131072, maxTokens: 40960 },
      {
        id: 'llama-3.3-70b-versatile',
        label: 'Llama 3.3 70B Versatile',
        contextWindow: 131072,
        maxTokens: 32768,
      },
    ],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    api: 'openai-chat',
    apiKeyUrl: 'https://openrouter.ai/keys',
    // OpenRouter aggregates hundreds of models behind one key; rather than pin a
    // stale subset, leave this empty so the wizard asks for the exact model
    // slug (e.g. `anthropic/claude-sonnet-4.6`) the user wants to route to.
    models: [],
  },
  {
    id: 'together',
    label: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    api: 'openai-chat',
    apiKeyUrl: 'https://api.together.ai/settings/api-keys',
    models: [
      {
        id: 'deepseek-ai/DeepSeek-V4-Pro',
        label: 'DeepSeek V4 Pro',
        contextWindow: 512000,
        maxTokens: 8192,
      },
      {
        id: 'zai-org/GLM-5.1',
        label: 'GLM 5.1',
        contextWindow: 202752,
        maxTokens: 8192,
      },
      {
        id: 'moonshotai/Kimi-K2.6',
        label: 'Kimi K2.6',
        vision: true,
        contextWindow: 262144,
        maxTokens: 32768,
      },
    ],
  },
  {
    id: 'fireworks',
    label: 'Fireworks AI',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    api: 'openai-chat',
    apiKeyUrl: 'https://app.fireworks.ai/settings/users/api-keys',
    models: [
      {
        id: 'accounts/fireworks/models/kimi-k2p6',
        label: 'Kimi K2.6',
        vision: true,
        contextWindow: 262144,
        maxTokens: 262144,
      },
    ],
  },
  {
    id: 'deepinfra',
    label: 'DeepInfra',
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    api: 'openai-chat',
    apiKeyUrl: 'https://deepinfra.com/dash/api_keys',
    models: [
      {
        id: 'deepseek-ai/DeepSeek-V4-Flash',
        label: 'DeepSeek V4 Flash',
        contextWindow: 1048576,
        maxTokens: 1048576,
      },
      { id: 'zai-org/GLM-5.1', label: 'GLM-5.1', contextWindow: 202752, maxTokens: 202752 },
      {
        id: 'moonshotai/Kimi-K2.5',
        label: 'Kimi K2.5',
        vision: true,
        contextWindow: 262144,
        maxTokens: 262144,
      },
    ],
  },
  {
    id: 'novita',
    label: 'Novita AI',
    baseUrl: 'https://api.novita.ai/openai/v1',
    api: 'openai-chat',
    apiKeyUrl: 'https://novita.ai/settings/key-management',
    models: [
      {
        id: 'moonshotai/kimi-k2.5',
        label: 'Kimi K2.5',
        vision: true,
        contextWindow: 262144,
        maxTokens: 65536,
      },
      { id: 'zai-org/glm-5', label: 'GLM-5', contextWindow: 202752, maxTokens: 65536 },
    ],
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    api: 'openai-chat',
    apiKeyUrl: 'https://cloud.cerebras.ai/platform',
    models: [
      { id: 'zai-glm-4.7', label: 'Z.ai GLM 4.7', contextWindow: 128000, maxTokens: 8192 },
      { id: 'gpt-oss-120b', label: 'GPT OSS 120B', contextWindow: 128000, maxTokens: 8192 },
      {
        id: 'qwen-3-235b-a22b-instruct-2507',
        label: 'Qwen 3 235B Instruct',
        contextWindow: 128000,
        maxTokens: 8192,
      },
    ],
  },
  {
    id: 'nvidia',
    label: 'NVIDIA',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    api: 'openai-chat',
    apiKeyUrl: 'https://build.nvidia.com',
    models: [
      {
        id: 'nvidia/nemotron-3-super-120b-a12b',
        label: 'Nemotron 3 Super 120B',
        contextWindow: 262144,
        maxTokens: 8192,
      },
      { id: 'z-ai/glm-5.1', label: 'GLM 5.1', contextWindow: 202752, maxTokens: 8192 },
    ],
  },
  {
    id: 'xiaomi',
    label: 'Xiaomi MiMo',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    api: 'openai-chat',
    models: [
      { id: 'mimo-v2-pro', label: 'MiMo V2 Pro', contextWindow: 1048576, maxTokens: 32000 },
      {
        id: 'mimo-v2-omni',
        label: 'MiMo V2 Omni',
        vision: true,
        contextWindow: 262144,
        maxTokens: 32000,
      },
    ],
  },
  {
    id: 'stepfun',
    label: 'StepFun',
    baseUrl: 'https://api.stepfun.ai/v1',
    api: 'openai-chat',
    models: [
      { id: 'step-3.5-flash', label: 'Step 3.5 Flash', contextWindow: 262144, maxTokens: 65536 },
    ],
  },
  {
    id: 'venice',
    label: 'Venice AI',
    baseUrl: 'https://api.venice.ai/api/v1',
    api: 'openai-chat',
    apiKeyUrl: 'https://venice.ai/settings/api',
    models: [
      { id: 'zai-org-glm-5', label: 'GLM 5', contextWindow: 198000, maxTokens: 32000 },
      {
        id: 'qwen3-235b-a22b-thinking-2507',
        label: 'Qwen3 235B Thinking',
        contextWindow: 128000,
        maxTokens: 16384,
      },
      { id: 'llama-3.3-70b', label: 'Llama 3.3 70B', contextWindow: 128000, maxTokens: 4096 },
    ],
  },
]
