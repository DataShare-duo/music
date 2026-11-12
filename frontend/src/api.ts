export type Source = 'soda' | 'netease' | 'kuwo'
export interface Song {
  id: number
  source: Source
  source_track_id: string
  title: string
  artist: string
  album: string
  cover_url: string
  duration: number
  created_at: string
  updated_at: string
  click_count: number
  listen_count: number
  audio_kind: 'preview' | 'full' | 'unknown'
  play_source?: Source | null
  play_source_name?: string | null
}
export interface SongList {
  items: Song[]
  count: number
  stale: boolean
  refreshing: boolean
  message: string | null
  page: number
  has_more: boolean
  updated_at: string | null
  verification_total?: number
  verification_pending?: number
  verification_available?: number
  verification_unavailable?: number
  verification_errors?: number
}
export interface Playback {
  id: string
  song_id: number
  state: string
  stream_url: string
  audio_kind: Song['audio_kind']
  link_version: number
  refresh_count: number
  expires_at: string
  play_source?: string | null
  play_source_name?: string | null
  audio_duration?: number | null
  error: { code: string; message: string } | null
}
export interface ProviderSource {
  id: Source
  name: string
  enabled: boolean
  status: string
  note: string
}
export const sourceNames: Record<Source, string> = {
  soda: '汽水音乐',
  netease: '网易云音乐',
  kuwo: '酷我音乐',
}
export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public playbackId?: string,
    public songId?: number,
    public hidden = false,
  ) {
    super(message)
  }
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/api${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...options.headers },
    })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e
    throw new ApiError('network_error', '无法连接音乐服务，请检查后端是否已启动')
  }
  const payload = await response.json().catch(() => null)
  if (!response.ok)
    throw new ApiError(
      payload?.error?.code || 'request_failed',
      payload?.error?.message || `请求失败 ${response.status}`,
      payload?.error?.playback_id,
      payload?.error?.song_id,
      payload?.error?.hidden || false,
    )
  return payload as T
}
export const post = <T>(path: string, data: object = {}) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(data) })
export function time(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const s = Math.floor(seconds)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
