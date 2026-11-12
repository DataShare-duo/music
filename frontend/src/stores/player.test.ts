import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { usePlayer } from './player'
import { api, post, type Playback, type Song } from '../api'

vi.mock('../api', async (original) => ({
  ...(await original<object>()),
  api: vi.fn(),
  post: vi.fn(),
}))
const song = (id = 1): Song => ({
  id,
  source: 'soda',
  source_track_id: String(id),
  title: `歌曲 ${id}`,
  artist: '歌手',
  album: '',
  cover_url: '',
  duration: 240,
  created_at: '',
  updated_at: '',
  click_count: 0,
  listen_count: 0,
  audio_kind: 'preview',
})
const playback = (id = 'session', version = 1): Playback => ({
  id,
  song_id: 1,
  state: 'ready',
  stream_url: `/api/playbacks/${id}/stream?v=${version}`,
  audio_kind: 'preview',
  link_version: version,
  refresh_count: version - 1,
  expires_at: '',
  error: null,
})
let element: HTMLAudioElement
let player: ReturnType<typeof usePlayer>

beforeEach(() => {
  vi.resetAllMocks()
  setActivePinia(createPinia())
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  vi.mocked(post).mockResolvedValue(playback())
  player = usePlayer()
  element = document.createElement('audio')
  player.attach(element)
})
afterEach(() => {
  player.detach()
  vi.restoreAllMocks()
})

describe('player state and playback lifecycle', () => {
  it('requests a fresh session only on song selection, counts actual playing once', async () => {
    await player.play(song(), [song(), song(2)])
    expect(post).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledWith('/songs/1/playbacks', {
      client_request_id: expect.any(String),
    })
    expect(player.playing).toBe(false)
    element.dispatchEvent(new Event('playing'))
    element.dispatchEvent(new Event('playing'))
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(2))
    expect(post).toHaveBeenLastCalledWith('/playbacks/session/started')
    await player.toggle()
    element.dispatchEvent(new Event('pause'))
    await player.toggle()
    expect(post).toHaveBeenCalledTimes(2)
  })

  it('ignores an old resolution result after fast song switching', async () => {
    let resolveOld!: (value: Playback) => void
    vi.mocked(post).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve
        }),
    )
    const old = player.play(song(1))
    const latest = player.play(song(2))
    await latest
    resolveOld(playback('old'))
    await old
    expect(player.current?.id).toBe(2)
    expect(element.src).not.toContain('/old/')
    expect(player.session?.id).toBe('session')
  })

  it('does not count listening when resolution fails', async () => {
    vi.mocked(post).mockRejectedValueOnce(new Error('没有公开音频'))
    await player.play(song())
    expect(player.failed).toBe(true)
    expect(player.message).toBe('没有公开音频')
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('offers a gesture button when browser blocks autoplay', async () => {
    vi.mocked(element.play).mockRejectedValueOnce(new DOMException('blocked', 'NotAllowedError'))
    await player.play(song())
    expect(player.needsGesture).toBe(true)
    expect(player.failed).toBe(false)
    expect(player.loading).toBe(false)
    await player.toggle()
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('reuses a link already refreshed by backend instead of spending another refresh', async () => {
    await player.play(song())
    vi.mocked(api).mockResolvedValueOnce({ ...playback('session', 2), state: 'streaming' })
    Object.defineProperty(element, 'error', { value: { code: 2 }, configurable: true })
    element.dispatchEvent(new Event('error'))
    await vi.waitFor(() => expect(player.session?.link_version).toBe(2))
    expect(post).toHaveBeenCalledTimes(1)
    expect(element.src).toContain('v=2')
  })

  it('does not retry unsupported audio formats', async () => {
    await player.play(song())
    vi.mocked(api).mockResolvedValueOnce(playback())
    Object.defineProperty(element, 'error', { value: { code: 3 }, configurable: true })
    element.dispatchEvent(new Event('error'))
    await vi.waitFor(() => expect(player.failed).toBe(true))
    expect(player.message).toContain('无法解码')
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('stops recovery after server reports a definitive playback error', async () => {
    await player.play(song())
    vi.mocked(api).mockResolvedValueOnce({
      ...playback(),
      state: 'failed',
      error: { code: 'refresh_exhausted', message: '刷新次数已用完' },
    })
    element.dispatchEvent(new Event('error'))
    await vi.waitFor(() => expect(player.failed).toBe(true))
    expect(player.message).toBe('刷新次数已用完')
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('changes tracks with the queue but does not wrap automatically at its end', async () => {
    await player.play(song(1), [song(1), song(2)])
    await player.next(1)
    expect(player.current?.id).toBe(2)
    const count = vi.mocked(post).mock.calls.length
    await player.next(1, true)
    expect(post).toHaveBeenCalledTimes(count)
    player.setVolume(0.25)
    expect(element.volume).toBe(0.25)
  })
})

it('removes unavailable songs from queue without keeping a permanent frontend blacklist', async () => {
  const { ApiError } = await import('../api')
  vi.mocked(post).mockRejectedValueOnce(
    new ApiError('full_audio_unavailable', '当前没有完整版', 'failed', 1, true),
  )
  await player.play(song(1), [song(1), song(2)])
  expect(player.hiddenIds.has(1)).toBe(true)
  expect(player.queue.map((item) => item.id)).toEqual([2])
  expect(player.current).toBeNull()
  player.restoreVerified([song(1)], player.availabilityRevision)
  expect(player.hiddenIds.has(1)).toBe(false)
})

it('does not let an old list response resurrect a newly hidden song', () => {
  const oldRevision = player.availabilityRevision
  player.hideSong(1)
  player.restoreVerified([song(1)], oldRevision)
  expect(player.hiddenIds.has(1)).toBe(true)
  player.restoreVerified([song(1)], player.availabilityRevision)
  expect(player.hiddenIds.has(1)).toBe(false)
})
