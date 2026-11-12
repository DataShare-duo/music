import { createApp, nextTick, type App as VueApp } from 'vue'
import { createPinia, type Pinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App.vue'
import { api, type Song, type SongList } from './api'
import { usePlayer } from './stores/player'

vi.mock('./api', async (original) => ({ ...(await original<object>()), api: vi.fn() }))
const track: Song = {
  id: 1,
  source: 'soda',
  source_track_id: '1',
  title: '测试歌曲',
  artist: '歌手',
  album: '专辑',
  cover_url: '',
  duration: 240,
  created_at: '',
  updated_at: '',
  click_count: 0,
  listen_count: 0,
  audio_kind: 'full',
  play_source: 'netease',
  play_source_name: '网易云音乐',
}
const list: SongList = {
  items: [track],
  count: 1,
  stale: false,
  refreshing: false,
  message: null,
  page: 1,
  has_more: false,
  updated_at: null,
  verification_total: 1,
  verification_available: 1,
  verification_pending: 0,
}
let app: VueApp, pinia: Pinia, root: HTMLDivElement
beforeEach(() => {
  vi.resetAllMocks()
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.mocked(api).mockImplementation(async (path) => (path === '/sources' ? [] : list))
  pinia = createPinia()
  root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp(App).use(pinia)
  app.mount(root)
})
afterEach(() => {
  app.unmount()
  root.remove()
  vi.restoreAllMocks()
})

async function rendered() {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

describe('full-only discovery UI', () => {
  it('removes the audio column and has six matching table cells', async () => {
    await rendered()
    const header = root.querySelector('.tr.th')!
    expect(header.children.length).toBe(6)
    expect(header.textContent).toContain('全曲时长')
    expect([...header.children].some((node) => node.textContent === '音频')).toBe(false)
    expect(root.querySelector('.tr:not(.th)')!.children.length).toBe(6)
    expect(root.querySelector('.tag')).toBeNull()
    expect(root.querySelector('.toolbar')).toBeNull()
    expect(root.textContent).not.toContain('多源验证 · 仅展示可播放歌曲')
    expect(root.querySelector('.source-col')?.textContent).toContain('网易云音乐')
  })

  it('shows the actual playback source without audio-type labels', async () => {
    await rendered()
    const player = usePlayer(pinia)
    player.current = track
    player.session = {
      id: 'session',
      song_id: 1,
      state: 'ready',
      stream_url: '/api/stream',
      audio_kind: 'full',
      link_version: 1,
      refresh_count: 0,
      expires_at: '',
      error: null,
      play_source: 'netease',
      play_source_name: '网易云音乐',
    }
    await nextTick()
    const footer = root.querySelector('.player')!
    expect(footer.textContent).toContain('网易云音乐')
    for (const label of ['完整音频', '试听', '完整性未知'])
      expect(footer.textContent).not.toContain(label)
  })

  it('keeps hidden songs out of cards and rows, then restores on fresh verified response', async () => {
    await rendered()
    const player = usePlayer(pinia)
    player.hideSong(1)
    await nextTick()
    expect(root.querySelector('.song')).toBeNull()
    expect(root.querySelector('.featured')).toBeNull()
    window.dispatchEvent(new Event('focus'))
    await rendered()
    expect(root.querySelector('.song')).not.toBeNull()
    expect(player.hiddenIds.has(1)).toBe(false)
  })
})

it('retains source selection on search without the removed explanatory strip', async () => {
  await rendered()
  const navigation = [...root.querySelectorAll('aside button')].find((item) =>
    item.textContent?.includes('搜索歌曲'),
  ) as HTMLButtonElement
  navigation.click()
  await rendered()
  const input = root.querySelector('.search-page-form input') as HTMLInputElement
  input.value = '测试'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
  root
    .querySelector('form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await rendered()
  const toolbar = root.querySelector('.toolbar')!
  expect(toolbar).not.toBeNull()
  expect(
    [...toolbar.querySelectorAll('button')].map((button) => button.textContent?.trim()),
  ).toEqual(['汽水音乐', '网易云音乐', '酷我音乐'])
  expect(toolbar.textContent).not.toContain('多源验证')
})

it('updates a current row to the actual source returned by the playback session', async () => {
  await rendered()
  const player = usePlayer(pinia)
  player.current = track
  player.session = {
    id: 'new-source',
    song_id: 1,
    state: 'ready',
    stream_url: '/api/stream',
    audio_kind: 'full',
    link_version: 1,
    refresh_count: 0,
    expires_at: '',
    error: null,
    play_source: 'kuwo',
    play_source_name: '酷我音乐',
  }
  await nextTick()
  expect(root.querySelector('.source-col')?.textContent).toContain('酷我音乐')
})

it('does not mistake the original catalog source for an unknown actual source', async () => {
  await rendered()
  vi.mocked(api).mockResolvedValue({
    ...list,
    items: [{ ...track, play_source: null, play_source_name: null }],
  })
  window.dispatchEvent(new Event('focus'))
  await rendered()
  expect(root.querySelector('.source-col')?.textContent?.trim()).toBe('待确认')
})

it('opens search mode and focuses the search input from the sidebar', async () => {
  await rendered()
  const button = [...root.querySelectorAll('aside button')].find((item) =>
    item.textContent?.includes('搜索歌曲'),
  ) as HTMLButtonElement
  button.click()
  await nextTick()
  const input = root.querySelector('.search-page-form input') as HTMLInputElement
  expect(root.querySelector('.workspace > header')).toBeNull()
  expect(input).not.toBeNull()
  expect(document.activeElement).toBe(input)
  expect(root.querySelector('.search-page-form')).not.toBeNull()
  expect(root.querySelector('.toolbar')).not.toBeNull()
})

it('does not send empty searches on navigation, focus, or source changes', async () => {
  await rendered()
  const button = [...root.querySelectorAll('aside button')].find((item) =>
    item.textContent?.includes('搜索歌曲'),
  ) as HTMLButtonElement
  button.click()
  await rendered()
  expect(root.querySelector('.hero')).toBeNull()
  expect(root.querySelector('.song')).toBeNull()
  expect(root.querySelector('.heading h2')?.textContent?.trim()).toBe('搜索歌曲')
  expect(root.querySelector('.empty')?.textContent).toContain('输入关键词开始搜索')
  window.dispatchEvent(new Event('focus'))
  const netease = [...root.querySelectorAll('.sources button')].find(
    (item) => item.textContent?.trim() === '网易云音乐',
  ) as HTMLButtonElement
  netease.click()
  await rendered()
  expect(vi.mocked(api).mock.calls.some(([path]) => path.startsWith('/search'))).toBe(false)
  const input = root.querySelector('.search-page-form input') as HTMLInputElement
  input.value = '周杰伦'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
  root
    .querySelector('form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await rendered()
  expect(
    vi
      .mocked(api)
      .mock.calls.some(
        ([path]) => path === '/search?q=%E5%91%A8%E6%9D%B0%E4%BC%A6&source=netease&page=1',
      ),
  ).toBe(true)
  expect(root.querySelector('.song')).not.toBeNull()
  const searchCalls = vi
    .mocked(api)
    .mock.calls.filter(([path]) => path.startsWith('/search')).length
  button.click()
  await rendered()
  expect(root.querySelector('.song')).not.toBeNull()
  expect(vi.mocked(api).mock.calls.filter(([path]) => path.startsWith('/search'))).toHaveLength(
    searchCalls,
  )
})

it('ignores a delayed home response after opening the search page', async () => {
  app.unmount()
  let finishHome!: (value: SongList) => void
  vi.mocked(api).mockImplementation((path) =>
    path === '/sources'
      ? Promise.resolve([])
      : new Promise((resolve) => {
          finishHome = resolve
        }),
  )
  app = createApp(App).use(createPinia())
  app.mount(root)
  const button = [...root.querySelectorAll('aside button')].find((item) =>
    item.textContent?.includes('搜索歌曲'),
  ) as HTMLButtonElement
  button.click()
  await nextTick()
  finishHome(list)
  await rendered()
  expect(root.querySelector('.hero')).toBeNull()
  expect(root.querySelector('.song')).toBeNull()
  expect(root.querySelector('.empty')?.textContent).toContain('输入关键词开始搜索')
})

it('removes the top header on both pages and preserves the home shuffle action', async () => {
  await rendered()
  expect(root.querySelector('.workspace > header')).toBeNull()
  expect(root.querySelector('.crumb')).toBeNull()
  expect(root.querySelector('.profile')).toBeNull()
  expect(root.querySelector('.search-page-form')).toBeNull()
  const shuffle = [...root.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === '换一批',
  ) as HTMLButtonElement
  expect(shuffle).toBeDefined()
  const before = vi.mocked(api).mock.calls.filter(([path]) => path === '/home').length
  shuffle.click()
  await rendered()
  expect(vi.mocked(api).mock.calls.filter(([path]) => path === '/home')).toHaveLength(before + 1)
  const navigation = [...root.querySelectorAll('aside button')].find((button) =>
    button.textContent?.includes('搜索歌曲'),
  ) as HTMLButtonElement
  navigation.click()
  await rendered()
  expect(root.querySelector('.workspace > header')).toBeNull()
  expect(root.querySelector('main .search-page-form')).not.toBeNull()
  expect(
    [...root.querySelectorAll('button')].some(
      (button) => button.textContent?.trim() === '返回发现',
    ),
  ).toBe(false)
})

it('submits using the visible search button inside the page content', async () => {
  await rendered()
  const navigation = [...root.querySelectorAll('aside button')].find((button) =>
    button.textContent?.includes('搜索歌曲'),
  ) as HTMLButtonElement
  navigation.click()
  await rendered()
  const form = root.querySelector('main .search-page-form')!
  const input = form.querySelector('input') as HTMLInputElement
  const submit = form.querySelector('button[type="submit"]') as HTMLButtonElement
  expect(submit.textContent?.trim()).toBe('搜索')
  expect(submit.disabled).toBe(true)
  expect(document.activeElement).toBe(input)
  input.value = '四块五'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
  expect(submit.disabled).toBe(false)
  submit.click()
  await rendered()
  expect(
    vi
      .mocked(api)
      .mock.calls.some(
        ([path]) => path === '/search?q=%E5%9B%9B%E5%9D%97%E4%BA%94&source=soda&page=1',
      ),
  ).toBe(true)
  expect(root.querySelector('.songs h2')?.textContent).toContain('四块五')
})

it('uses page navigation without interrupting the player', async () => {
  await rendered()
  const player = usePlayer(pinia)
  player.current = track
  player.playing = true
  await nextTick()
  const audio = root.querySelector('audio')
  const buttons = [...root.querySelectorAll('.mobile-nav button')]
  ;(buttons[1] as HTMLButtonElement).click()
  await rendered()
  expect(root.querySelector('.search-page-form')).not.toBeNull()
  ;(buttons[0] as HTMLButtonElement).click()
  await rendered()
  expect(root.querySelector('.hero')).not.toBeNull()
  expect(root.querySelector('.search-page-form')).toBeNull()
  expect(root.querySelector('.workspace > header')).toBeNull()
  expect(root.querySelector('audio')).toBe(audio)
  expect(player.current?.id).toBe(track.id)
  expect(player.playing).toBe(true)
  expect(HTMLMediaElement.prototype.pause).not.toHaveBeenCalled()
})

it('credits DataShare in the page footer and about dialog', async () => {
  await rendered()
  expect(root.querySelector('.page-foot')?.textContent).toContain('作者：DataShare')
  ;(root.querySelector('.side-foot') as HTMLButtonElement).click()
  await nextTick()
  expect(root.querySelector('[role="dialog"]')?.textContent).toContain('作者：DataShare')
})
