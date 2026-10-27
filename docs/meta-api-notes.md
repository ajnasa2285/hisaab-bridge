# Meta API verification — 27 October 2026 (IST)

Official Meta documentation only; checked by Astra during this session.

| Item | Confirmed documentation | Source |
| --- | --- | --- |
| Base and auth | `https://api.meta.ai/v1`; Bearer token. This repo reads `META_API_KEY` (the docs call it `MODEL_API_KEY`). | [Overview](https://dev.meta.ai/docs/overview) |
| Spark IDs | `muse-spark-1.3`, `muse-spark-1.2`, `muse-spark-1.1`. Use standard mode for private evidence. | [Models](https://dev.meta.ai/docs/models) |
| Model discovery | `GET /v1/models`, response `data[].id`. | [List models](https://dev.meta.ai/docs/api-reference/models/list-models) |
| Vision request | `POST /v1/chat/completions`, `model`, `messages`; user content contains `{type:"text",text}` and `{type:"image_url",image_url:{url:"data:<mime>;base64,..."}}`. | [Vision input](https://dev.meta.ai/docs/cookbook/vision-input) |
| JSON output | `response_format:{type:"json_schema",json_schema:{name,schema,strict:true}}`; every object has `additionalProperties:false` and all properties required. | [Structured output](https://dev.meta.ai/docs/structured-output) |
| Speech model | `muse-voice-transcribe-1.0`. | [Overview](https://dev.meta.ai/docs/overview) |
| Speech upload | `POST /v1/asr/transcribe`, multipart `request` JSON plus `audio` WAV; `Accept: application/json`. Request fields: `model`, `audioEncoding:"WAV"`, `mode:"PUSH_TO_TALK"`, `languageBias:["Hindi"]`. | [Transcribe](https://dev.meta.ai/docs/api-reference/voice/transcribe), [Voice schemas](https://dev.meta.ai/docs/api-reference/voice/schemas) |
| Speech format | Mono 16-bit PCM WAV at 16 or 24 kHz; conversion of WhatsApp audio is required upstream. | [Speech to text](https://dev.meta.ai/docs/speech-to-text) |

## Account verification

`META_API_KEY` is present; its value was never displayed or written. Base and model environment variables were absent. The first sandbox catalog attempt failed DNS before reaching Meta. With network access enabled, one live `GET /v1/models` succeeded through `src/meta/client.js`. It confirmed `muse-spark-1.3`, `muse-spark-1.2`, `muse-spark-1.1`, and `muse-voice-transcribe-1.0` among the available IDs. A synthetic Spark call also succeeded using `muse-spark-1.3`, the documented Chat Completions format, and reported usage. Contributor variants are intentionally disallowed for private evidence.

Use explicit process configuration, with no model defaults in application code:

```powershell
$env:META_API_BASE = 'https://api.meta.ai/v1'
$env:MUSE_SPARK_MODEL = 'muse-spark-1.3'
$env:MUSE_TRANSCRIBE_MODEL = 'muse-voice-transcribe-1.0'
```

## Response handling and accounting

Chat results use `choices[0].message.content`, `message.tool_calls[].function.{name,arguments}`, and `usage.{prompt_tokens,completion_tokens}`. Only completed (`stop` or `tool_calls`) responses are accepted; arguments and structured JSON are locally validated. See [Tool calling](https://dev.meta.ai/docs/tool-calling). This dependency-free client supports a documented subset of JSON Schema; unsupported keywords fail before upload, rather than being silently ignored.

Voice JSON contains top-level `transcript`, `audioDurationMs`, and `turns` (empty in `PUSH_TO_TALK`); the client reads `transcript`. See [Voice schemas](https://dev.meta.ai/docs/api-reference/voice/schemas).

Standard Spark prices checked today: input $1.25, cached input $0.15, output $4.25 per million tokens; Voice Transcribe $0.18/hour. Accounting uses integer nano-USD. Failed requests with unreported usage have unknown cost, not zero. Prices are estimates, not an invoice. Source: [Pricing and rate limits](https://dev.meta.ai/docs/pricing-rate-limits).

## Open questions

- Voice Transcribe is catalog-confirmed, but no real voice sample has been used. Who will provide mono PCM WAV samples or implement upstream conversion from WhatsApp audio?
- No answer key exists yet. Human-confirmed accuracy cannot be claimed until the owner labels development photos; model predictions must never become their own answer key.

## Live meter request verification

The first development run completed all 11 image requests with schema-validated responses and reported usage. This confirms the documented inline-image and strict JSON-schema request format works for this account. The report contains only aggregate counts, timing, tokens and cost; no evidence contents. Nine numeric readings and two abstentions were returned. Their correctness is unmeasured until human labeling; see `eval/README.md` for the labeling and cached-scoring commands.
