# 🌕 Full Moon TV

A live AI-generated television channel. Users pay per prompt via x402 (USDC), clips chain narratively from one to the next, and everything is rendered by Venice video models through Shipyard Inference.

Everyone watches the same stream. You submit a prompt, it gets chained to the previous scene by an LLM, rendered into a 5-second video clip, and aired live.

## Quick start

```bash
# Install dependencies
npm install

# Set up environment (copy and edit)
cp .env.example .env
# Add your VENICE_API_KEY (get one at https://venice.ai)

# Start the server (dev mode without API key — generation is mocked)
npm run dev

# Open http://localhost:3000
```

## How it works

```
User submits prompt ($1 via x402)
    │
    ▼
LLM chains it to the previous scene
    │ (Shipyard Inference — cheapest capable model)
    ▼
Venice video.generate() renders a 5s clip
    │ (Shipyard Inference VideoRouter — cheapest Venice model)
    ▼
Clip airs on the live stream
    │ (SSE pushes state to all viewers)
```

## Architecture

| Component | What it does |
|---|---|
| `src/server.ts` | Hono server — API endpoints, SSE live stream, static file serving |
| `src/channel.ts` | Live channel state — playlist, now-playing, up-next queue, SSE subscribers |
| `src/generator.ts` | Generation pipeline — LLM prompt chaining + Venice video generation via Shipyard Inference |
| `src/storage.ts` | Saves generated MP4 clips to disk (swap for R2/S3 in production) |
| `public/index.html` | Frontend — video player, prompt input, live queue, payment flow |

## API

| Endpoint | Method | What it does |
|---|---|---|
| `/api/state` | GET | Current channel state (now-playing, up-next, recently-played) |
| `/api/live` | GET (SSE) | Live state stream — pushes updates to all viewers |
| `/api/submit` | POST | Submit a prompt (x402 gated in production) — body: `{ prompt, model? }` |
| `/healthz` | GET | Health check |

## Environment

| Variable | Default | Description |
|---|---|---|
| `VENICE_API_KEY` | — | Venice API key for video generation. Without it, dev mode mocks generation. |
| `OPENROUTER_API_KEY` | — | OpenRouter API key for the prompt-chaining LLM |
| `ANTHROPIC_API_KEY` | — | Anthropic API key (alternative LLM) |
| `PRICE_PER_PROMPT_USDC` | `1.0` | Price per prompt in USDC |
| `PORT` | `3000` | Server port |

## Tech

- **Shipyard Inference** — routing, x402 payment, Venice video provider
- **Hono** — web framework
- **Venice API** — video generation (async queue → poll → retrieve)
- **x402** — pay-per-prompt in USDC on Solana

## License

MIT
