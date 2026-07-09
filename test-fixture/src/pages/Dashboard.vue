<template>
  <div>
    <!-- static dynamic-component usage -->
    <component is="UserCard" :user="me" />
    <!-- literal :is binding -->
    <component :is="'UserCard'" :user="me" />
    <!-- genuinely dynamic — must NOT be counted -->
    <component :is="whatever" />
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import UserCard from '../components/UserCard.vue';

export default defineComponent({
  components: { UserCard },
  data() {
    return { me: { name: 'Me' }, whatever: 'Something' };
  },
});
</script>
