<template>
  <div class="user-card">
    <strong>{{ user.name }}</strong>
  </div>
</template>

<script setup lang="ts">
defineProps<{ user: { name: string } }>();
</script>
