<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import {
  Search,
  Compass,
  ArrowUpRight,
  Play,
  Pause,
  Music2,
  LoaderCircle,
  ChevronLeft,
  ChevronRight,
  AlertCircle,
  X,
  Waves,
  Check,
} from 'lucide-vue-next'
import {
  api,
  sourceNames,
  time,
  type ProviderSource,
  type Song,
  type SongList,
  type Source,
} from './api'
import { usePlayer } from './stores/player'
import Cover from './components/Cover.vue'
import PlayerBar from './components/PlayerBar.vue'
const player = usePlayer(),
  mode = ref<'home' | 'search'>('home'),
  query = ref(''),
  searched = ref(''),
  source = ref<Source>('soda'),
  sources = ref<ProviderSource[]>([]),
  result = ref<SongList | null>(null),
  loading = ref(false),
  error = ref(''),
  page = ref(1),
  aboutOpen = ref(false),
  items = computed(() =>
    (result.value?.items || []).filter((song) => !player.hiddenIds.has(song.id)),
  ),
  featured = computed(() => items.value.slice(0, 4)),
  isCurrent = (s: Song) => player.current?.id === s.id
const searchInput = ref<HTMLInputElement>()
function focusSearch() {
  searchInput.value?.focus()
}
function openSearch() {
  if (mode.value !== 'search') {
    ++version
    clearTimeout(timer)
    controller?.abort()
    mode.value = 'search'
    searched.value = ''
    page.value = 1
    result.value = null
    error.value = ''
    loading.value = false
  }
  window.scrollTo({ top: 0, behavior: 'smooth' })
  void nextTick(() => focusSearch())
}

const moods = ['华语流行', '抖音热歌', '民谣', '治愈', '轻音乐', '经典华语']
let timer: ReturnType<typeof setTimeout> | undefined,
  controller: AbortController | undefined,
  version = 0
async function load(poll = false) {
  if (mode.value === 'search' && !searched.value.trim()) return
  const token = ++version
  const availabilityRevision = player.availabilityRevision
  clearTimeout(timer)
  controller?.abort()
  controller = new AbortController()
  if (!poll) loading.value = true
  error.value = ''
  const path =
    mode.value === 'home'
      ? poll && result.value?.items.length
        ? `/home?ids=${result.value.items.map((song) => song.id).join(',')}`
        : '/home'
      : `/search?q=${encodeURIComponent(searched.value)}&source=${source.value}&page=${page.value}`
  try {
    const data = await api<SongList>(path, { signal: controller.signal })
    if (token !== version) return
    player.restoreVerified(data.items, availabilityRevision)
    result.value = data
  } catch (e) {
    if (token !== version || (e as Error).name === 'AbortError') return
    error.value = (e as Error).message
  } finally {
    if (token === version) {
      loading.value = false
      timer = setTimeout(() => void load(true), result.value?.refreshing ? 3000 : 60000)
    }
  }
}
function search(q = query.value) {
  if (!q.trim()) return
  query.value = searched.value = q.trim()
  mode.value = 'search'
  page.value = 1
  result.value = null
  void load()
}
function home() {
  mode.value = 'home'
  query.value = ''
  searched.value = ''
  page.value = 1
  result.value = null
  void load()
}
function selectSource(value: Source) {
  source.value = value
  changeSource()
}
function changeSource() {
  if (mode.value === 'search' && searched.value.trim()) {
    page.value = 1
    result.value = null
    void load()
  }
}
function turnPage(d: number) {
  page.value += d
  result.value = null
  void load()
  scrollTo({ top: 0, behavior: 'smooth' })
}
function play(s: Song) {
  if (isCurrent(s) && player.session && !player.failed) void player.toggle()
  else void player.play(s, items.value)
}
function songSource(song: Song) {
  if (isCurrent(song) && player.session?.play_source_name) return player.session.play_source_name
  return song.play_source_name || (song.play_source ? sourceNames[song.play_source] : '待确认')
}
function shuffle() {
  const s = items.value[Math.floor(Math.random() * items.value.length)]
  if (s) void player.play(s, items.value)
}
const refreshWhenVisible = () => {
  if (!document.hidden) void load(true)
}
onMounted(() => {
  window.addEventListener('focus', refreshWhenVisible)
  document.addEventListener('visibilitychange', refreshWhenVisible)
  void load()
  void api<ProviderSource[]>('/sources')
    .then((v) => (sources.value = v))
    .catch(() => {})
})
onUnmounted(() => {
  ++version
  window.removeEventListener('focus', refreshWhenVisible)
  document.removeEventListener('visibilitychange', refreshWhenVisible)
  clearTimeout(timer)
  controller?.abort()
})
</script>
<template>
  <div class="app">
    <aside class="side">
      <a class="brand" href="/" @click.prevent="home"
        ><span><Waves :size="25" /></span><b>听见<small>LISTEN & FEEL</small></b></a
      ><label>你的音乐空间</label
      ><button :class="{ active: mode === 'home' }" @click="home">
        <Compass :size="19" />发现音乐</button
      ><button :class="{ active: mode === 'search' }" @click="openSearch">
        <Search :size="19" />搜索歌曲
      </button>
      <div class="side-note">
        <Music2 :size="29" /><b>音乐，不止一种心情</b>
        <p>在熟悉的旋律里<br />找到属于自己的片刻</p>
        <small>JUST PRESS PLAY</small>
      </div>
      <button class="side-foot" @click="aboutOpen = true">
        <i />个人音乐空间<ArrowUpRight :size="14" />
      </button>
    </aside>
    <div class="workspace">
      <main>
        <nav class="mobile-nav" aria-label="页面导航">
          <button :class="{ active: mode === 'home' }" @click="home">
            <Compass :size="17" />发现音乐
          </button>
          <button :class="{ active: mode === 'search' }" @click="openSearch">
            <Search :size="17" />搜索歌曲
          </button>
        </nav>
        <section v-if="mode === 'home'" class="hero">
          <div>
            <small>● EVERYDAY, A NEW SOUND</small>
            <h1>把生活，<br />调到喜欢的频率<span>。</span></h1>
            <p>不必急着出发，先让一首歌陪着你<br />从汽水音乐出发，遇见今天的好心情</p>
            <button class="primary" :disabled="!items.length" @click="shuffle">
              <Play :size="15" fill="currentColor" />随心听一首<ArrowUpRight :size="15" />
            </button>
          </div>
          <div class="record">
            <div><Waves :size="28" /><b>听 见</b><small>33⅓ RPM · SIDE A</small></div>
          </div>
        </section>
        <div v-if="mode === 'home'" class="heading">
          <div>
            <small>PICK YOUR MOOD</small>
            <h2>此刻，想听什么<span>?</span></h2>
          </div>
          <em>给日常加一点旋律</em>
        </div>
        <div v-if="mode === 'home'" class="moods">
          <button v-for="m in moods" :key="m" @click="search(m)">
            {{ m }} <ArrowUpRight :size="13" />
          </button>
        </div>
        <section v-if="featured.length && mode === 'home'" class="featured">
          <button v-for="(song, i) in featured" :key="song.id" @click="play(song)">
            <div>
              <Cover :url="song.cover_url" :title="song.title" /><span>0{{ i + 1 }}</span
              ><i
                ><Pause
                  v-if="isCurrent(song) && player.playing"
                  :size="16"
                  fill="currentColor" /><Play v-else :size="16" fill="currentColor"
              /></i>
            </div>
            <b>{{ song.title }}</b
            ><small>{{ song.artist }}</small>
          </button>
        </section>
        <section class="songs">
          <div class="heading">
            <div>
              <small>{{
                mode === 'home' ? 'FRESH FINDS, JUST FOR YOU' : 'FIND YOUR NEXT FAVORITE'
              }}</small>
              <h2>
                {{
                  mode === 'home'
                    ? '发现好音乐'
                    : searched
                      ? `“${searched}” 的搜索结果`
                      : '搜索歌曲'
                }}
                <sup v-if="mode === 'home' || searched">{{ items.length }} 首</sup>
              </h2>
              <p>
                {{
                  mode === 'home'
                    ? '热门关键词推荐 · 仅展示已验证完整版'
                    : '选择音乐来源，找到你想听的版本'
                }}
              </p>
            </div>
            <button v-if="mode === 'home'" class="outline" :disabled="loading" @click="load()">
              换一批
            </button>
          </div>
          <form v-if="mode === 'search'" class="search-page-form" @submit.prevent="search()">
            <Search :size="18" />
            <input
              ref="searchInput"
              v-model="query"
              aria-label="搜索歌曲或歌手"
              placeholder="搜索歌曲、歌手"
              maxlength="100"
            />
            <button type="submit" :disabled="!query.trim()">搜索</button>
          </form>
          <div v-if="mode === 'search'" class="toolbar">
            <div class="sources" aria-label="搜索音乐来源">
              <button
                v-for="(name, key) in sourceNames"
                :key="key"
                :class="{ selected: source === key }"
                :disabled="sources.find((item) => item.id === key)?.enabled === false"
                @click="selectSource(key)"
              >
                {{ name }}
              </button>
            </div>
          </div>
          <div v-if="error" class="notice error" role="alert">
            <AlertCircle :size="16" />{{ error }}<button @click="() => load()">重试</button>
          </div>
          <div v-else-if="result?.message || result?.refreshing" class="notice">
            <LoaderCircle v-if="result?.refreshing" class="spin" :size="15" /><AlertCircle
              v-else
              :size="15"
            />{{ result?.message || '正在后台验证可播放歌曲' }}
            <span v-if="result?.verification_total" class="verification-progress"
              >已验证 {{ result.verification_available || 0 }} /
              {{ result.verification_total }} 首，待验证
              {{ result.verification_pending || 0 }} 首</span
            >
          </div>
          <div v-if="loading && !items.length" class="empty">
            <LoaderCircle class="spin" :size="27" />
            <p>正在寻找好音乐…</p>
          </div>
          <div v-else-if="items.length" class="table" role="table" aria-label="歌曲列表">
            <div class="tr th" role="row">
              <span>#</span><span>歌曲 / 歌手</span><span>专辑</span><span>歌曲来源</span
              ><span>全曲时长</span><span />
            </div>
            <div
              v-for="(song, i) in items"
              :key="song.id"
              class="tr"
              role="row"
              :class="{ current: isCurrent(song) }"
              @dblclick="play(song)"
            >
              <span>{{ String((page - 1) * 20 + i + 1).padStart(2, '0') }}</span
              ><button class="song" @click="play(song)">
                <Cover :url="song.cover_url" :title="song.title" /><span
                  ><b>{{ song.title }}</b
                  ><small>{{ song.artist }}</small></span
                ></button
              ><span class="album">{{ song.album || '—' }}</span
              ><span class="source-col">{{ songSource(song) }}</span
              ><span>{{ song.duration ? time(song.duration) : '—' }}</span
              ><button
                class="row-play"
                :aria-label="`${isCurrent(song) && player.playing ? '暂停' : '播放'} ${song.title}`"
                @click="play(song)"
              >
                <LoaderCircle
                  v-if="isCurrent(song) && player.loading"
                  class="spin"
                  :size="15"
                /><Pause
                  v-else-if="isCurrent(song) && player.playing"
                  :size="15"
                  fill="currentColor"
                /><Play v-else :size="15" fill="currentColor" />
              </button>
            </div>
          </div>
          <div v-else-if="!loading" class="empty">
            <div>
              <Search v-if="mode === 'search' && !searched" :size="28" /><Music2
                v-else
                :size="28"
              />
            </div>
            <h3>
              {{
                mode === 'search' && !searched
                  ? '输入关键词开始搜索'
                  : result?.refreshing
                    ? '好音乐正在路上'
                    : '暂未找到可确认完整版的歌曲'
              }}
            </h3>
            <p>
              {{
                mode === 'search' && !searched
                  ? '输入歌曲名或歌手，点击“搜索”或按 Enter 开始搜索'
                  : result?.refreshing
                    ? '首次验证需要一点时间，页面会自动更新'
                    : '系统会定期重新检查可播放歌曲'
              }}
            </p>
          </div>
          <div v-if="mode === 'search' && (page > 1 || result?.has_more)" class="pages">
            <button class="outline" :disabled="page === 1" @click="turnPage(-1)">
              <ChevronLeft :size="15" />上一页</button
            ><span>第 {{ page }} 页</span
            ><button class="outline" :disabled="!result?.has_more" @click="turnPage(1)">
              下一页<ChevronRight :size="15" />
            </button>
          </div>
          <div class="foot">
            <span><Check :size="12" />仅在播放时实时获取音频链接</span
            ><span>列表时长为歌曲总时长，播放时使用已验证完整版</span>
          </div>
        </section>
        <div class="page-foot">
          听见 LISTEN & FEEL <span>给生活留一点音乐的时间 · 仅供个人非商业使用</span>
        </div>
      </main>
    </div>
    <PlayerBar />
    <div v-if="aboutOpen" class="modal" @click.self="aboutOpen = false">
      <section role="dialog" aria-modal="true" aria-label="关于听见">
        <button aria-label="关闭说明" @click="aboutOpen = false" class="close"><X /></button
        ><span class="modal-mark"><Waves /></span>
        <h2>简单一点，听见更多</h2>
        <p>这是个人使用的轻量音乐空间，基于 FastAPI、SQLite、Vue 和固定版本 musicdl 构建</p>
        <p>
          推荐来自热门关键词检索，不是官方热榜，仅展示通过完整版验证的歌曲，不可用歌曲暂时隐藏并定期复检，不绕过会员或访问权限
        </p>
        <button class="primary" @click="aboutOpen = false">知道了<Check :size="15" /></button>
      </section>
    </div>
  </div>
</template>
