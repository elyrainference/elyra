// Copy-paste client snippets for the Connect view and the one-click model-source presets. Static data + pure functions.
// The endpoint is escaped: it can come from the ?api= override, and these strings are rendered as HTML (copy uses textContent).
import { toolUrl } from "../lib/config.js";
import { S } from "../lib/store.js";
import { esc } from "../lib/dom.js";

const E = () => esc(toolUrl(S.status?.node?.port));

export const SNIP = {
  curl: () => `<span class="c"># any OpenAI-compatible client works unchanged</span>\ncurl ${E()}/chat/completions \\\n  -H <span class="s">"Content-Type: application/json"</span> \\\n  -d <span class="s">'{"model":"auto","messages":[{"role":"user","content":"hi"}]}'</span>`,
  python: () => `<span class="k">from</span> openai <span class="k">import</span> OpenAI\n\nclient = OpenAI(base_url=<span class="s">"${E()}"</span>, api_key=<span class="s">"elyra"</span>)\nr = client.chat.completions.create(\n    model=<span class="s">"auto:cheapest"</span>,\n    messages=[{<span class="s">"role"</span>: <span class="s">"user"</span>, <span class="s">"content"</span>: <span class="s">"hi"</span>}],\n)\nprint(r.choices[0].message.content)`,
  node: () => `<span class="k">import</span> OpenAI <span class="k">from</span> <span class="s">"openai"</span>;\n\n<span class="k">const</span> client = <span class="k">new</span> OpenAI({ baseURL: <span class="s">"${E()}"</span>, apiKey: <span class="s">"elyra"</span> });\n<span class="k">const</span> r = <span class="k">await</span> client.chat.completions.create({\n  model: <span class="s">"auto"</span>,\n  messages: [{ role: <span class="s">"user"</span>, content: <span class="s">"hi"</span> }],\n});`,
  env: () => `<span class="c"># Cursor, Continue, Open WebUI, aider, LangChain…</span>\n<span class="g">export</span> OPENAI_BASE_URL=${E()}\n<span class="g">export</span> OPENAI_API_KEY=elyra   <span class="c"># any string; the router holds no platform account</span>\n<span class="c"># then use model "auto", "auto:cheapest", "auto:private" or a model name</span>`,
};

// [name, base URL, key placeholder]
export const PRESET_UP = [
  ["Ollama", "http://localhost:11434/v1", ""], ["LM Studio", "http://localhost:1234/v1", ""], ["OpenAI", "https://api.openai.com/v1", "sk-…"],
  ["OpenRouter", "https://openrouter.ai/api/v1", "sk-or-…"], ["Groq", "https://api.groq.com/openai/v1", "gsk_…"], ["Together", "https://api.together.xyz/v1", ""],
];
