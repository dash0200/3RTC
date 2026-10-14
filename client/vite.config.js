import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'
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
// Files for search engines and link previews; the app itself never needs them
const NOT_PRECACHED = /^(og-image\.png|robots\.txt|sitemap\.xml|404\.html)$/

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
            if (NOT_PRECACHED.test(rel)) continue
            files.push(rel)
            hash.update(rel)
            hash.update(fs.readFileSync(full))
          }
        }
      }
      if (publicDir && fs.existsSync(publicDir)) walk(publicDir)

      // Pages are cached under their clean URLs (/ and /about, not /index.html and /about.html):
      // the host redirects the .html addresses, and a service worker can't serve a redirect
      const cleanUrl = (file) => (file === 'index.html' ? '' : file.replace(/\.html$/, ''))
      const urls = [...new Set(files.map(cleanUrl))].sort().map((file) => `${base}${file}`)
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

// Build number: when it was built, India time, YYMMDD.HHMM (always goes up), plus the commit.
// Shown in the app and served as /version.json so a deploy can be checked from anywhere.
function buildInfo(command) {
  if (command !== 'build') return { number: 'dev', sha: '', branch: '', time: '' }
  const git = (args) => {
    try { return execSync(`git ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() } catch { return '' }
  }
  const now = new Date()
  const ist = new Date(now.getTime() + 330 * 60 * 1000)
  const two = (n) => String(n).padStart(2, '0')
  const number = `${String(ist.getUTCFullYear()).slice(2)}${two(ist.getUTCMonth() + 1)}${two(ist.getUTCDate())}.${two(ist.getUTCHours())}${two(ist.getUTCMinutes())}`
  return {
    number,
    sha: (process.env.VERCEL_GIT_COMMIT_SHA || git('rev-parse HEAD')).slice(0, 7),
    branch: process.env.VERCEL_GIT_COMMIT_REF || git('rev-parse --abbrev-ref HEAD'),
    time: now.toISOString(),
  }
}

function versionFile(info) {
  return {
    name: '3rtc-version-file',
    apply: 'build',
    writeBundle(options) {
      fs.writeFileSync(path.join(options.dir, 'version.json'), JSON.stringify(info, null, 2))
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode, command }) => {
  const build = buildInfo(command)
  return {
    plugins: [react(), pwaServiceWorker(), versionFile(build)],
    define: { __APP_BUILD__: JSON.stringify(build) },
    // Keep the browser console empty in the live app. Vite 8 minifies with Oxc, which ignores the
    // old `esbuild.drop` option, so console/debugger are dropped by the minifier itself.
    build: {
      rolldownOptions: {
        output: {
          minify: mode === 'production'
            ? { compress: { dropConsole: true, dropDebugger: true } }
            : false,
        },
      },
    },
  }
})
