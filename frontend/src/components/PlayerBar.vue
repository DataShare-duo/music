<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import {
  LoaderCircle,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Volume2,
  Headphones,
  RotateCcw,
} from 'lucide-vue-next'
import { sourceNames, time } from '../api'
import { usePlayer } from '../stores/player'
import Cover from './Cover.vue'
const player = usePlayer(),
  element = ref<HTMLAudioElement>()
onMounted(() => element.value && player.attach(element.value))
onUnmounted(() => player.detach())
</script>
<template>
  <footer class="player" aria-label="音乐播放器">
    <audio ref="element" preload="metadata" />
    <div v-if="player.current" class="now">
      <Cover
        :key="player.current.id"
        :url="player.current.cover_url"
        :title="player.current.title"
      />
      <div class="now-text">
        <b>{{ player.current.title }}</b
        ><small
          >{{ player.current.artist }} ·
          {{ player.session?.play_source_name || sourceNames[player.current.source] }}</small
        >
      </div>
    </div>
    <div v-else class="now">
      <div class="placeholder"><Headphones :size="20" /></div>
      <div class="now-text"><b>让好音乐，陪你一会儿</b><small>选择一首歌曲，开始聆听</small></div>
    </div>
    <div class="controls">
      <div>
        <button aria-label="上一首" @click="player.next(-1)" :disabled="!player.current">
          <SkipBack :size="17" /></button
        ><button
          class="main-play"
          :aria-label="player.playing ? '暂停' : player.failed ? '重试播放' : '播放'"
          @click="player.toggle()"
          :disabled="!player.current || player.loading"
        >
          <LoaderCircle v-if="player.loading" class="spin" :size="19" /><RotateCcw
            v-else-if="player.failed"
            :size="18"
          /><Pause v-else-if="player.playing" :size="18" fill="currentColor" /><Play
            v-else
            :size="18"
            fill="currentColor"
          /></button
        ><button aria-label="下一首" @click="player.next(1)" :disabled="!player.current">
          <SkipForward :size="17" />
        </button>
      </div>
      <label class="timeline"
        ><span>{{ time(player.position) }}</span
        ><input
          type="range"
          min="0"
          :max="player.duration || 1"
          :value="player.position"
          :disabled="!player.seekable"
          aria-label="播放进度"
          @change="player.seek(Number(($event.target as HTMLInputElement).value))"
        /><span>{{ time(player.duration) }}</span></label
      >
    </div>
    <label class="volume"
      ><Volume2 :size="17" /><input
        type="range"
        min="0"
        max="1"
        aria-label="音量"
        step=".01"
        :value="player.volume"
        @input="player.setVolume(Number(($event.target as HTMLInputElement).value))"
    /></label>
    <div v-if="player.message" class="player-message" role="status">
      {{ player.message }}
      <button v-if="player.needsGesture" @click="player.toggle">继续播放</button>
    </div>
  </footer>
</template>
