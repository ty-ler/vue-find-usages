<template>
  <div>
    <!-- PascalCase usage -->
    <UserCard :user="alice" />
    <!-- kebab-case usage of the same component -->
    <user-card :user="bob" />
    <!-- must NOT be counted (different component, shares a prefix) -->
    <UserCardList />
  </div>
</template>

<script setup lang="ts">
import UserCard from '../components/UserCard.vue';

const alice = { name: 'Alice' };
const bob = { name: 'Bob' };
</script>
