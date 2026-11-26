# tenant-config — ChatbotX config (Pencil Beauty, SCRUM-393)

Declarative source of truth for the salon AI config. Created once in the ChatbotX
builder; these files are the spec to review or rebuild from.

## Files
- `flows/get_services.chatbotx-flow.json` — the flow (import via UI: Flows → Import Flow).
- `ai-functions/get_services.json` — AI Function spec (create by hand in AI Functions).
- `ai-agents/salon.json` — AI Agent spec (create by hand in AI Agents).

## Set up once (UI)
1. **Flows → Import Flow** → `get_services.chatbotx-flow.json` → **Publish**.
2. Finish the flow in the builder (Clear Custom Field → External API Request → Condition → Gemini: AI Generate Text → Send Message) → **Publish**, then **Export** it back over `flows/get_services.chatbotx-flow.json`.
3. **AI Agents → AI Functions → + Create AI Function** from `ai-functions/get_services.json` (output message empty; Trigger Flow ID = the flow).
4. **AI Agents → + Create AI Agent** from `ai-agents/salon.json`; **Tools** → Function `get_services`.

## What it does (SCRUM-393)
Flow calls `GET /v1/public/services` (header `X-Tenant-ID`), maps `$.content` → custom field `erp_services_json`. The flow's Gemini: AI Generate Text writes the VI/EN answer from that list only and sends it; the Agent never invents a price (ERP has no price field — SCRUM-391). Full runbook: Confluence page 39682059.
