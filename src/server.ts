// src/server.ts — Full Moon TV server
// Hono-based API + static file server. x402 payment gating on prompt submission,
// SSE for live state updates, static serving of generated clips.

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { streamSSE } from 'hono/streaming'
import { serveStatic } from '@hono/node-server/serve-static'
import { serve } from '@hono/node-server'
import { Channel } from './channel.js'
import { Generator } from './generator.js'
import { ClipStorage } from './storage.js'
import { createVeniceVideoCandidate } from 'shipyard-inference'

const PORT = parseInt(process.env.PORT ?? '3000', 10)

// --- Config ---
const VENICE_API_KEY = process.env.VENICE_API_KEY ?? ''
const LLM_API_KEY = process.env.OPENROUTER_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? ''
const PRICE_PER_PROMPT_USDC = parseFloat(process.env.PRICE_PER_PROMPT_USDC ?? '1.0')
const DEV_MODE = !VENICE_API_KEY

if (DEV_MODE) {
  console.warn('[fullmoon-tv] ⚠️  DEV MODE — VENICE_API_KEY not set. Generation will be mocked.')
}

// --- State ---
const channel = new Channel()
const storage = new ClipStorage()
const generator = DEV_MODE ? null : new Generator({
  veniceApiKey: VENICE_API_KEY,
  llmApiKey: LLM_API_KEY,
})
const veniceCandidate = DEV_MODE ? null : createVeniceVideoCandidate({ apiKey: VENICE_API_KEY })

// --- Hono app ---
const app = new Hono()

app.use('*', cors({ origin: '*' }))

// Static clips directory
app.use('/clips/*', serveStatic({ root: './' }))

// Frontend
app.use('*', serveStatic({ root: './public' }))

// Health check
app.get('/healthz', (c) => c.json({ status: 'ok' }))

// --- Channel state (public) ---
app.get('/api/state', (c) => {
  return c.json(channel.getState())
})

// --- SSE: live state stream ---
app.get('/api/live', (c) => {
  return streamSSE(c, async (stream) => {
    const unsubscribe = channel.subscribe((state) => {
      stream.writeSSE({ data: JSON.stringify(state) }).catch(() => {})
    })
    // Keep the connection alive with heartbeats
    const heartbeat = setInterval(() => {
      stream.writeSSE({ event: 'ping', data: String(Date.now()) }).catch(() => {})
    }, 15000)
    // Wait for the stream to close (client disconnect)
    stream.onAbort(() => {
      clearInterval(heartbeat)
      unsubscribe()
    })
  })
})

// --- Submit a prompt (x402 gated) ---
// In production, this endpoint returns 402 with payment instructions.
// The client signs a USDC payment and retries with the X-Payment header.
// For dev mode (no x402 configured), it's free.

app.post('/api/submit', async (c) => {
  let body: { prompt?: string; model?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }

  const prompt = body?.prompt?.trim()
  if (!prompt) {
    return c.json({ error: '`prompt` is required' }, 400)
  }
  if (prompt.length > 500) {
    return c.json({ error: 'Prompt must be 500 characters or less' }, 400)
  }

  // --- x402 payment check ---
  // TODO: Wire this to the shipyard-inference payment layer.
  // For now, accept all prompts in dev mode.
  // In production:
  //   const payment = c.req.header('X-Payment')
  //   if (!payment) {
  //     return c.json({ error: 'Payment required', price: PRICE_PER_PROMPT_USDC, asset: 'USDC', chain: 'solana' }, 402)
  //   }
  //   // Verify payment via facilitator...
  const submittedBy = c.req.header('X-Wallet') ?? 'anonymous'

  // --- Submit to channel ---
  const clip = channel.submit(prompt, submittedBy, body.model)

  // --- Kick off generation in background ---
  const previousClip = channel.getRecentlyPlayed()[0] ?? channel.getNowPlaying()
  ;(async () => {
    try {
      console.log(`[fullmoon-tv] Generating clip ${clip.id}: "${prompt}"`)
      
      if (DEV_MODE) {
        // Mock: wait 3s, then mark as ready with no video (placeholder)
        await new Promise(resolve => setTimeout(resolve, 3000))
        channel.markReady(clip.id, '', 0.16)
        console.log(`[fullmoon-tv] Clip ${clip.id} ready (mock)`)
        return
      }

      const result = await generator!.generate(prompt, previousClip, veniceCandidate!)
      
      // Save the video
      let videoUrl: string | undefined
      if (result.videoData) {
        videoUrl = storage.saveBase64(clip.id, result.videoData)
      } else if (result.downloadUrl) {
        // Download and save it, or just use the URL directly
        videoUrl = result.downloadUrl
      }

      if (videoUrl) {
        channel.markReady(clip.id, videoUrl, result.costUsd)
        console.log(`[fullmoon-tv] Clip ${clip.id} ready: ${videoUrl} (cost: $${result.costUsd})`)
      } else {
        channel.markFailed(clip.id)
        console.error(`[fullmoon-tv] Clip ${clip.id} generated but no video URL`)
      }
    } catch (err) {
      console.error(`[fullmoon-tv] Clip ${clip.id} generation failed:`, err)
      channel.markFailed(clip.id)
    }
  })()

  return c.json({
    clipId: clip.id,
    prompt: clip.prompt,
    status: clip.status,
    position: channel.getUpNext().length,
    priceUsdc: PRICE_PER_PROMPT_USDC,
    message: 'Your prompt is in the queue. Watch the live stream to see it air.',
  })
})

// --- Channel schedule / auto-advance ---
// In a real deployment, a scheduler advances the playlist when the current
// clip finishes playing. For now, we'll use a simple timer based on clip duration.
let advanceTimer: NodeJS.Timeout | null = null

function scheduleAdvance() {
  if (advanceTimer) clearTimeout(advanceTimer)
  const nowPlaying = channel.getNowPlaying()
  if (nowPlaying?.status === 'ready') {
    const duration = (nowPlaying.durationSec ?? 5) * 1000
    advanceTimer = setTimeout(() => {
      channel.advance()
      scheduleAdvance()
    }, duration)
  }
}

// Auto-advance when a clip is ready and nothing is playing
setInterval(() => {
  if (!channel.getNowPlaying() || channel.getNowPlaying()?.status === 'failed') {
    const next = channel.peekNext()
    if (next?.status === 'ready') {
      channel.advance()
      scheduleAdvance()
    }
  }
}, 2000)

// --- Start server ---
console.log(`🌑 Full Moon TV — starting on port ${PORT}`)
console.log(`   Venice API: ${VENICE_API_KEY ? 'configured' : 'NOT SET (dev mode)'}`)
console.log(`   Price per prompt: $${PRICE_PER_PROMPT_USDC} USDC`)
console.log(`   Stream: http://localhost:${PORT}`)
console.log(`   API:    http://localhost:${PORT}/api/submit`)

serve({ fetch: app.fetch, port: PORT })
