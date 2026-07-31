<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { heroQuotes } from './hero-quotes'

const quote = ref(heroQuotes[0])

onMounted(() => {
  if (heroQuotes.length <= 1) return
  const index = Math.floor(Math.random() * heroQuotes.length)
  quote.value = heroQuotes[index]
})
</script>

<template>
  <h1>{{ quote }}</h1>
</template>
