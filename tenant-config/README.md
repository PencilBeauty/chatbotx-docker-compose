# tenant-config — ChatbotX config (Pencil Beauty, SCRUM-393)

Declarative source of truth for the salon AI config. Created once in the ChatbotX
builder; these files are the spec to review or rebuild from.

## Files
- `flows/get_services.chatbotx-flow.json` — the flow (import via UI: Flows → Import Flow).
- `ai-functions/get_services.json` — AI Function spec (create by hand in AI Functions).
- `ai-agents/salon.json` — AI Agent spec (create by hand in AI Agents).

## Set up once (UI)
0. Settings → Integrations: Groq (OpenAI Compatible) is the model used everywhere. A Google Gemini key is connected only to unlock AI Agents (ChatbotX ignores OpenAI-Compatible providers when unlocking).
1. **Flows → Import Flow** → `flows/get_services.chatbotx-flow.json`. Check Import history = Success 1. Nothing to build by hand.
2. **AI Agents → AI Functions → + Create AI Function** from `ai-functions/get_services.json`; **Trigger Flow ID** = the imported flow.
3. **AI Agents → + Create AI Agent** from `ai-agents/salon.json`; model Groq `qwen/qwen3.8-27b`; **Tools → Function** `get_services`.

## What it does (SCRUM-393)
Flow calls `GET /v1/public/services` (header `X-Tenant-ID`), maps `$.content` → custom field `erp_services_json`. The flow's AI Generate Text step (Groq) writes the VI/EN answer from that list only and sends it; the Agent never invents a price (ERP has no price field — SCRUM-391). Full runbook: Confluence page 39682059.
