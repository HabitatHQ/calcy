// ESLint is scoped to `**/*.svelte` only — Biome (see biome.json) owns
// `.ts`/`.js` linting and formatting. eslint-plugin-svelte is the only
// linter with real Svelte-template awareness (a11y, reactivity, markup
// correctness), so it fills the gap Biome deliberately leaves open.
//
// eslint-plugin-svelte's `recommended` preset also ships a config block for
// `*.svelte.js`/`*.svelte.ts` (Svelte 5 rune modules with no template) — we
// drop that block and force every remaining block to `**/*.svelte` so plain
// `.ts` files (e.g. src/lib/state/sheet.svelte.ts) stay entirely with Biome.

import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import svelteParser from 'svelte-eslint-parser';
import tseslint from 'typescript-eslint';
import svelteConfig from './svelte.config.js';

const svelteOnly = svelte.configs.recommended
  .filter((config) => config.name !== 'svelte:base:setup-for-svelte-script')
  .map((config) => ({ ...config, files: ['**/*.svelte'] }));

export default tseslint.config(
  {
    ignores: [
      '.worktrees/',
      '.svelte-kit/',
      'build/',
      'dist/',
      'node_modules/',
      'static/',
      '**/*.md'
    ]
  },
  ...svelteOnly,
  {
    files: ['**/*.svelte'],
    languageOptions: {
      // The app is a client-side PWA (see svelte.config.js) — script
      // blocks reference browser globals (window, localStorage, etc.).
      globals: { ...globals.browser },
      parser: svelteParser,
      parserOptions: {
        parser: tseslint.parser,
        svelteConfig
      }
    }
  }
);
