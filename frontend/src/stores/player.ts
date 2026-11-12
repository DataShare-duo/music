import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { api, post, ApiError, type Playback, type Song } from '../api'

function requestId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export const usePlayer = defineStore('player', () => {
  const current = ref<Song | null>(null)
  const queue = ref<Song[]>([])
  const session = ref<Playback | null>(null)
  const playing = ref(false)
  const loading = ref(false)
  const message = ref('')
  const failed = ref(false)
  const position = ref(0)
  const duration = ref(0)
  const volume = ref(0.7)
  const seekable = ref(false)
  const needsGesture = ref(false)
  const hiddenIds = ref(new Set<number>())
  const availabilityRevision = ref(0)
  const hiddenRevisions = new Map<number, number>()
  const kind = computed(() => session.value?.audio_kind || current.value?.audio_kind || 'unknown')
  let audio: HTMLAudioElement | null = null
  let generation = 0
  let recovering = false
  let countedSession: string | null = null
  const listeners: Array<[string, EventListener]> = []

  function listen(name: string, callback: EventListener) {
    audio?.addEventListener(name, callback)
    listeners.push([name, callback])
  }

  function attach(element: HTMLAudioElement) {
    if (audio) detach()
    audio = element
    audio.volume = volume.value
    listen('playing', () => void onPlaying())
    listen('pause', () => {
      playing.value = false
    })
    listen('timeupdate', () => {
      position.value = audio?.currentTime || 0
    })
    listen('durationchange', updateMedia)
    listen('progress', updateMedia)
    listen('waiting', () => {
      if (session.value && !failed.value) loading.value = true
    })
    listen('ended', () => {
      playing.value = false
      void next(1, true)
    })
    listen('error', () => {
      void recover()
    })
  }

  function updateMedia() {
    duration.value = audio && Number.isFinite(audio.duration) ? audio.duration : 0
    seekable.value = !!audio && audio.seekable.length > 0
  }

  async function onPlaying() {
    if (!session.value || !audio || failed.value) return
    playing.value = true
    loading.value = false
    needsGesture.value = false
    message.value = ''
    updateMedia()
    const id = session.value.id
    if (countedSession === id) return
    countedSession = id
    try {
      await post(`/playbacks/${id}/started`)
    } catch {
      if (countedSession === id) countedSession = null
    }
  }

  async function tryPlay(token: number, inRecovery = false) {
    if (!audio || token !== generation) return
    try {
      await audio.play()
    } catch (error) {
      if (token !== generation || (error as DOMException).name === 'AbortError') return
      if ((error as DOMException).name === 'NotAllowedError') {
        loading.value = false
        needsGesture.value = true
        message.value = '浏览器需要你的确认，点击播放继续'
      } else if (recovering) {
        // The media error handler owns recovery; do not race its request
        if (!inRecovery) return
        if (audio.error) throw new Error('刷新后音频仍不可播放，请切换来源或稍后重试')
      } else if (audio.error) {
        await recover()
      } else {
        loading.value = false
        message.value = '暂时无法播放，请点击重试'
        failed.value = true
      }
    }
  }

  function restoreVerified(songs: Song[], requestRevision: number) {
    for (const song of songs) {
      if ((hiddenRevisions.get(song.id) ?? Infinity) <= requestRevision) {
        hiddenRevisions.delete(song.id)
        hiddenIds.value.delete(song.id)
      }
    }
  }

  function hideSong(id: number) {
    hiddenRevisions.set(id, ++availabilityRevision.value)
    hiddenIds.value = new Set([...hiddenIds.value, id])
    queue.value = queue.value.filter((item) => item.id !== id)
    if (current.value?.id === id) {
      audio?.pause()
      current.value = null
      session.value = null
    }
  }

  async function play(song: Song, songs?: Song[]) {
    const token = ++generation
    if (songs) queue.value = [...songs]
    audio?.pause()
    session.value = null
    audio?.removeAttribute('src')
    audio?.load()
    current.value = song
    position.value = duration.value = 0
    seekable.value = false
    loading.value = true
    playing.value = failed.value = needsGesture.value = false
    recovering = false
    countedSession = null
    message.value = '正在实时获取音乐链接…'
    try {
      const result = await post<Playback>(`/songs/${song.id}/playbacks`, {
        client_request_id: requestId(),
      })
      if (token !== generation || !audio) return
      session.value = result
      message.value = ''
      audio.src = result.stream_url
      await tryPlay(token)
    } catch (error) {
      if (token !== generation) return
      const apiError = error as Error & { code?: string; songId?: number }
      if (apiError.code === 'full_audio_unavailable' && apiError.songId) hideSong(apiError.songId)
      message.value = apiError.message
      loading.value = false
      failed.value = true
    }
  }

  async function recover() {
    if (!session.value || !audio || recovering || failed.value) return
    const token = generation
    const id = session.value.id
    const resumeAt = position.value
    recovering = true
    loading.value = true
    message.value = '正在检查并刷新播放链接…'
    try {
      const mediaCode = audio.error?.code
      const latest = await api<Playback>(`/playbacks/${id}`)
      if (token !== generation) return
      if (latest.error)
        throw new ApiError(
          latest.error.code,
          latest.error.message,
          latest.id,
          latest.song_id,
          latest.error.code === 'full_audio_unavailable',
        )
      if (mediaCode === 3 || (mediaCode === 4 && latest.state !== 'failed')) {
        throw new Error('浏览器无法解码当前音频，请切换音乐来源')
      }
      const result =
        latest.link_version !== session.value!.link_version
          ? latest
          : await post<Playback>(`/playbacks/${id}/refresh`, {
              expected_version: latest.link_version,
            })
      if (token !== generation) return
      session.value = result
      const element = audio
      if (resumeAt > 0) {
        element.addEventListener(
          'loadedmetadata',
          () => {
            if (token === generation && Number.isFinite(element.duration)) {
              element.currentTime = Math.min(resumeAt, Math.max(0, element.duration - 0.1))
            }
          },
          { once: true },
        )
      }
      element.src = result.stream_url
      element.load()
      message.value = ''
      await tryPlay(token, true)
    } catch (error) {
      if (token !== generation) return
      const apiError = error as Error & { code?: string; songId?: number }
      if (apiError.code === 'full_audio_unavailable' && apiError.songId) hideSong(apiError.songId)
      message.value = apiError.message
      loading.value = playing.value = false
      failed.value = true
    } finally {
      if (token === generation) recovering = false
    }
  }

  async function toggle() {
    if (!audio || !current.value) return
    if (failed.value || !session.value) {
      await play(current.value)
      return
    }
    if (playing.value) {
      audio.pause()
      return
    }
    message.value = ''
    await tryPlay(generation)
  }

  async function next(direction: number, automatic = false) {
    if (!current.value || !queue.value.length) return
    const index = queue.value.findIndex((song) => song.id === current.value?.id)
    const target = index + direction
    if (automatic && target >= queue.value.length) return
    const song = queue.value[(target + queue.value.length) % queue.value.length]
    if (song) await play(song)
  }

  function seek(value: number) {
    if (audio && seekable.value) audio.currentTime = value
  }
  function setVolume(value: number) {
    volume.value = value
    if (audio) audio.volume = value
  }
  function detach() {
    generation++
    audio?.pause()
    for (const [name, callback] of listeners) audio?.removeEventListener(name, callback)
    listeners.length = 0
    audio = null
  }

  return {
    current,
    queue,
    session,
    playing,
    loading,
    message,
    failed,
    position,
    duration,
    volume,
    seekable,
    needsGesture,
    kind,
    hiddenIds,
    availabilityRevision,
    restoreVerified,
    attach,
    play,
    toggle,
    next,
    seek,
    setVolume,
    detach,
    hideSong,
  }
})
