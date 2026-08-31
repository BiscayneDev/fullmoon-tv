// src/generator.ts — The generation pipeline
// Takes a prompt + previous clip context, chains it with an LLM, then generates
// a video clip via Venice through Shipyard Inference's VideoRouter.

import {
  Router,
  AnthropicProvider,
  createOpenRouterProvider,
  createVeniceVideoCandidate,
  costOptimized,
} from 'shipyard-inference'
import type { Clip } from './channel.js'

export interface GeneratorOptions {
  veniceApiKey: string
  llmApiKey?: string
  videoModel?: string
  /** If true, use the cheapest video model. If a model is specified, use it. */
  autoModel?: boolean
}

const SYSTEM_PROMPT = `You are the creative director of Full Moon TV, a live AI-generated television channel.
Your job: take the user's prompt and the previous scene description, and produce a single vivid video generation prompt that continues the narrative.

Rules:
- Write a single paragraph (2-4 sentences) describing a 5-second video scene
- Include visual details: setting, lighting, camera angle, mood, motion
- Continue from where the previous scene left off (same world, progressing time)
- If there's no previous scene, establish the opening shot
- Be cinematic and vivid — this is TV, not a slideshow
- Do not include text overlays or captions — describe what the camera sees
- Output ONLY the video prompt, no preamble or explanation`

export class Generator {
  private router: Router
  private videoModel: string | undefined

  constructor(opts: GeneratorOptions) {
    const veniceCandidate = createVeniceVideoCandidate({
      apiKey: opts.veniceApiKey,
      models: undefined, // use VENICE_PREFERRED_VIDEO default
    })

    const candidates = [
      {
        id: 'openrouter',
        provider: createOpenRouterProvider({ apiKey: opts.llmApiKey ?? process.env.OPENROUTER_API_KEY }),
      },
    ]

    this.router = new Router({
      candidates,
      strategy: costOptimized(),
    })

    // Add Venice as a separate candidate for video routing
    // The router.video property handles video; we just need the chat candidates
    // for the LLM chaining call. But we also need Venice available for video.
    // Store the video model preference.
    this.videoModel = opts.videoModel
  }

  /**
   * Generate a video clip from a user prompt, chained to the previous scene.
   * Returns the video generation result with the enriched prompt and cost.
   */
  async generate(
    userPrompt: string,
    previousClip: Clip | null,
    veniceCandidate: ReturnType<typeof createVeniceVideoCandidate>,
  ): Promise<{ videoPrompt: string; videoData?: string; downloadUrl?: string; costUsd?: number; model: string }> {
    // Step 1: LLM chain — connect the user's prompt to the previous scene
    const messages = [
      {
        role: 'user' as const,
        content: previousClip
          ? `Previous scene: "${previousClip.prompt}"\n\nUser's new prompt: "${userPrompt}"\n\nWrite the next scene.`
          : `User's opening prompt: "${userPrompt}"\n\nWrite the opening scene.`,
      },
    ]

    let videoPrompt: string
    try {
      const response = await this.router.chat({
        system: SYSTEM_PROMPT,
        messages,
        tools: [],
        routingHints: { tier: 'economy' },
        maxTokens: 200,
      })
      videoPrompt = response.content ?? userPrompt
    } catch {
      // If the LLM fails, just use the raw user prompt
      videoPrompt = userPrompt
    }

    // Step 2: Generate the video via Venice through the VideoRouter
    // We need a Router that has the Venice candidate for video routing
    const videoRouter = new Router({
      candidates: [veniceCandidate],
      strategy: costOptimized(),
    })

    const model = this.videoModel ?? 'gemini-omni-flash-1-1-text-to-video'
    const result = await videoRouter.video.generate({
      model,
      prompt: videoPrompt,
      duration: 5,
      resolution: '720p',
      pollIntervalMs: 5000,
      maxPollAttempts: 60,
    })

    return {
      videoPrompt,
      videoData: result.videoData,
      downloadUrl: result.downloadUrl,
      costUsd: result.costUsd,
      model: result.model,
    }
  }
}
