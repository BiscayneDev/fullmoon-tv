// src/channel.ts — Live channel state manager
// Manages the playlist, now-playing, up-next queue, and live SSE subscribers.

export interface Clip {
  id: string
  prompt: string
  model: string
  videoUrl: string | null     // null while generating
  status: 'generating' | 'ready' | 'failed'
  costUsd?: number
  submittedAt: number
  submittedBy: string          // wallet address or 'system'
  durationSec?: number
}

export interface ChannelState {
  nowPlaying: Clip | null
  upNext: Clip[]
  recentlyPlayed: Clip[]
  viewerCount: number
}

type StateListener = (state: ChannelState) => void

export class Channel {
  private state: ChannelState = {
    nowPlaying: null,
    upNext: [],
    recentlyPlayed: [],
    viewerCount: 0,
  }
  private listeners = new Set<StateListener>()
  private clipId = 0

  /** Subscribe to state changes. Returns unsubscribe. */
  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener)
    this.state.viewerCount++
    this.notify()
    return () => {
      this.listeners.delete(listener)
      this.state.viewerCount = Math.max(0, this.state.viewerCount - 1)
      this.notify()
    }
  }

  /** Submit a new prompt to the queue. Returns the created clip. */
  submit(prompt: string, submittedBy: string, model?: string): Clip {
    const clip: Clip = {
      id: `clip-${++this.clipId}`,
      prompt,
      model: model ?? 'auto',
      videoUrl: null,
      status: 'generating',
      submittedAt: Date.now(),
      submittedBy,
    }
    this.state.upNext.push(clip)
    this.notify()
    return clip
  }

  /** Mark a clip as ready with a video URL. */
  markReady(clipId: string, videoUrl: string, costUsd?: number) {
    const clip = this.findClip(clipId)
    if (!clip) return
    clip.videoUrl = videoUrl
    clip.status = 'ready'
    clip.costUsd = costUsd
    this.notify()
  }

  /** Mark a clip as failed. */
  markFailed(clipId: string) {
    const clip = this.findClip(clipId)
    if (!clip) return
    clip.status = 'failed'
    this.notify()
  }

  /** Promote the next ready clip to now-playing. */
  advance(): Clip | null {
    if (this.state.nowPlaying) {
      this.state.recentlyPlayed.unshift(this.state.nowPlaying)
      this.state.recentlyPlayed = this.state.recentlyPlayed.slice(0, 20)
    }
    // Find the first ready clip in upNext
    const readyIdx = this.state.upNext.findIndex((c) => c.status === 'ready')
    if (readyIdx === -1) {
      this.state.nowPlaying = null
      this.notify()
      return null
    }
    const [clip] = this.state.upNext.splice(readyIdx, 1)
    this.state.nowPlaying = clip
    this.notify()
    return clip
  }

  /** Peek at what would advance next (without actually advancing). */
  peekNext(): Clip | null {
    return this.state.upNext.find((c) => c.status === 'ready') ?? null
  }

  getUpNext(): Clip[] {
    return [...this.state.upNext]
  }

  getRecentlyPlayed(): Clip[] {
    return [...this.state.recentlyPlayed]
  }

  getNowPlaying(): Clip | null {
    return this.state.nowPlaying
  }

  getState(): ChannelState {
    return { ...this.state, upNext: [...this.state.upNext], recentlyPlayed: [...this.state.recentlyPlayed] }
  }

  private findClip(id: string): Clip | undefined {
    if (this.state.nowPlaying?.id === id) return this.state.nowPlaying
    return this.state.upNext.find((c) => c.id === id)
  }

  private notify() {
    const snapshot = this.getState()
    for (const listener of this.listeners) {
      listener(snapshot)
    }
  }
}
