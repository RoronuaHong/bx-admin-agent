<script setup lang="ts">
import { RouterView } from "vue-router";
import { provideTheme } from "./theme";

provideTheme();
</script>

<template>
  <RouterView />
</template>
