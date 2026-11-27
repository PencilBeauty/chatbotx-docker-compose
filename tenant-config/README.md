# tenant-config — ChatbotX config (Pencil Beauty, SCRUM-393)

Declarative source of truth for the salon AI config. Created once in the ChatbotX
builder; these files are the spec to review or rebuild from.

## Files
- `flows/get_services.chatbotx-flow.json` — the flow (import via UI: Flows → Import Flow).
- `ai-functions/get_services.json` — AI Function spec (create by hand in AI Functions).
- `ai-agents/salon.json` — AI Agent spec (create by hand in AI Agents).

## Set up once (UI)
0. Settings → Integrations: Groq (OpenAI Compatible) is the model used everywhere. A Google Gemini key is connected only to unlock AI Agents (ChatbotX ignores OpenAI-Compatible providers when unlocking).
1. **Flows → Import Flow** → `flows/get_services.chatbotx-flow.json` and `flows/get_offerings.chatbotx-flow.json`; **Publish** each (import creates a draft only). Check Import history = Success 1. Nothing to build by hand.
2. **AI Agents → AI Functions → + Create AI Function** from `ai-functions/get_services.json` and `ai-functions/get_offerings.json`; **Trigger Flow ID** = the imported flow.
3. **AI Agents → + Create AI Agent** from `ai-agents/salon.json`; model Groq `openai/gpt-oss-120b`; **Tools → Function** `get_services` + `get_offerings`.

## What it does (SCRUM-393)
Flow calls `GET /v1/public/services` (header `X-Tenant-ID`), maps `content` → custom field `erp_services_json`. The flow's AI Generate Text step (Groq) writes the VI/EN answer from that list only and sends it; the Agent never invents a price (ERP has no price field — SCRUM-391). Full runbook: Confluence page 39682059.

## Two catalogs
- `get_services` → `/public/services`: bookable services with duration, no price.
- `get_offerings` → `/public/offering-variants`: priced menu items (`service_id` may be null). Kept separate so prices are never attached to a bookable service by guesswork.
- Both point at **nonprod** for now; switch base URL + `X-Tenant-ID` together when moving to prod.

## Prompts (where each one lives)
- `ai-agents/salon.json` `prompt` → agent **System Message**: general rules only (scope, facts-from-tools, style). Names no tools; tool choice comes from each function's Purpose.
- Each flow's AI Generate Text step: `system` → UI **Prompt (optional)** = shared style block (identical in both flows); `text` → UI **User message** = question + ERP data + tool-specific instruction. This step writes the reply the customer actually sees.
- Keep the style (reply in the customer's language, polite neutral address, no markdown) identical in the agent prompt and both flow `system` blocks.

## check_availability (SCRUM-394)
- Needs core-backend `GET /v1/public/bookings/availability/slots?branchId=&serviceId=&date=&guestCount=` -> `{"slots":[...]}` deployed first. The older `/bookings/availability` returns a root array, which Response Mapping (dot-prop) cannot store.
- Import `flows/check_availability.chatbotx-flow.json`, **Publish**, create the AI Function from `ai-functions/check_availability.json` (Trigger Flow ID = imported flow), add it to the agent's Tools.
- Flow: services + branches -> AI step resolves names and relative dates to `avail_query` (or `AMBIGUOUS` / `NOMATCH`) -> slots call -> AI reply. Slots call error (timeout, 4xx/5xx, `AMBIGUOUS`/`NOMATCH` -> 400; AMBIGUOUS asks which service) and resolver error go to the "Availability check failed" node, so an API failure is never reported as "no free slots". `{"slots":[]}` is always written, so an old result is never reused.
- Missing values: the AI Function's Purpose makes the agent ask only for what is missing before calling; a changed value triggers a new call.
