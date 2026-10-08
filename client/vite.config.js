import react from '@vitejs/plugin-react'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { defineConfig } from 'vite'

// Feature 5.1: builds dist/sw.js from src/pwa/sw.js with a precache list of every emitted
// file (hashed JS/CSS, index.html) plus everything in public/, and a version derived from
// their contents so each deploy ships a new service worker.
// Optional on-demand assets (the RNNoise voice isolation model and its worklet) are left out
// of the precache so visitors who never enable it don't download them; the service worker
// caches them on first use instead.
const ON_DEMAND_ASSET = /(^|\/)(rnnoise[^/]*\.wasm|workletProcessor-[^/]*\.js)$/

function pwaServiceWorker() {
  let config
  return {
    name: '3rtc-pwa-service-worker',
    apply: 'build',
    configResolved(resolved) {
      config = resolved
    },
    writeBundle(options, bundle) {
      const outDir = options.dir || config.build.outDir
      const base = config.base.endsWith('/') ? config.base : `${config.base}/`
      const hash = createHash('sha256')
      const files = []

      for (const [fileName, chunk] of Object.entries(bundle)) {
        if (fileName.endsWith('.map') || ON_DEMAND_ASSET.test(fileName)) continue
        files.push(fileName)
        hash.update(fileName)
        hash.update(chunk.type === 'chunk' ? chunk.code : chunk.source)
      }

      const publicDir = config.publicDir
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            walk(full)
          } else {
            const rel = path.relative(publicDir, full).split(path.sep).join('/')
            files.push(rel)
            hash.update(rel)
            hash.update(fs.readFileSync(full))
          }
        }
      }
      if (publicDir && fs.existsSync(publicDir)) walk(publicDir)

      const urls = [...new Set(files)].sort().map((file) => `${base}${file}`)
      const template = fs.readFileSync(path.resolve(config.root, 'src/pwa/sw.js'), 'utf8')
      const source = template
        .replace("const VERSION = '__SW_VERSION__';", `const VERSION = '${hash.digest('hex').slice(0, 12)}';`)
        .replace('const PRECACHE_URLS = __PRECACHE_URLS__;', `const PRECACHE_URLS = ${JSON.stringify(urls, null, 2)};`)
      if (source.includes('__SW_VERSION__') || source.includes('__PRECACHE_URLS__')) {
        throw new Error('[3rtc-pwa] service worker template placeholders were not replaced')
      }
      fs.writeFileSync(path.join(outDir, 'sw.js'), source)
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react(), pwaServiceWorker()],
  esbuild: {
    drop: mode === 'production' ? ['console', 'debugger'] : [],
  },
}))
