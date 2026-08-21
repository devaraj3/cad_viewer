import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// jsPDF's own LICENSE file (MIT) - Rollup's bundling step drops the source
// comment banner from node_modules/jspdf's ESM build before esbuild's
// minifier ever runs (confirmed by testing: even an UNMINIFIED build is
// already missing it), so preserving it isn't a matter of an esbuild/terser
// comment-retention flag - it has to be re-added explicitly instead.
const jspdfLicenseBanner = `/*!\n${readFileSync(
  fileURLToPath(new URL('./node_modules/jspdf/LICENSE', import.meta.url)),
  'utf-8',
).trim()}\n*/\n`

/**
 * Prepends jspdfLicenseBanner to any emitted chunk that actually bundles
 * jsPDF. Implemented as a plugin (generateBundle hook) rather than
 * `build.rollupOptions.output.banner` because this project's build
 * (`vite-react-ssg build`) runs `vite build` a second time internally with
 * its own `rollupOptions` override, and Vite's `mergeConfig` does not
 * reliably deep-merge a `rollupOptions.output` function past that second
 * override (confirmed by testing: the banner function ran and returned the
 * right text, but never reached the written file). `plugins` arrays, unlike
 * nested rollupOptions, are reliably concatenated across such merges, and
 * `generateBundle` runs after minification, directly on the final bundle
 * about to be written - so this is not vulnerable to the same loss.
 */
function jspdfLicenseBannerPlugin(): Plugin {
  return {
    name: 'jspdf-license-banner',
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type !== 'chunk') continue;
        const bundlesJspdf = Object.keys(file.modules).some((id) =>
          id.toLowerCase().includes('/node_modules/jspdf/'),
        );
        if (bundlesJspdf) file.code = jspdfLicenseBanner + file.code;
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), jspdfLicenseBannerPlugin()],
})
