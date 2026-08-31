// src/storage.ts — Simple file-based storage for generated video clips.
// Saves MP4s to disk under ./clips/ and serves them statically.
// For production, swap this for R2/S3/CDN — the interface is the same.

import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

const CLIPS_DIR = join(process.cwd(), 'clips')

export class ClipStorage {
  constructor(dir: string = CLIPS_DIR) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    this.dir = dir
  }

  private dir: string

  /** Save a base64-encoded video string to disk, return the public path. */
  saveBase64(clipId: string, base64Data: string): string {
    const filename = `${clipId}.mp4`
    const filepath = join(this.dir, filename)
    const buffer = Buffer.from(base64Data, 'base64')
    writeFileSync(filepath, buffer)
    return `/clips/${filename}`
  }

  /** Save raw binary video data to disk, return the public path. */
  saveBinary(clipId: string, data: Uint8Array | ArrayBuffer): string {
    const filename = `${clipId}.mp4`
    const filepath = join(this.dir, filename)
    writeFileSync(filepath, Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data))
    return `/clips/${filename}`
  }

  /** If we only have a download URL (Venice pre-signed), return it directly. */
  static toPublicPath(clipId: string): string {
    return `/clips/${clipId}.mp4`
  }
}
