import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const root = path.resolve(__dirname, '..')

const candidates = [
  path.join(root, 'node_modules', '@excalidraw', 'excalidraw', 'dist', 'prod'),
  path.join(root, 'node_modules', '@excalidraw', 'excalidraw', 'dist'),
]

const target = path.join(root, 'public', 'canvex-assets')

const source = candidates.find((dir) => fs.existsSync(dir))
if (!source) {
  console.warn('[sync-canvex-assets] source not found, skip')
  process.exit(0)
}

fs.mkdirSync(target, { recursive: true })
fs.cpSync(source, target, { recursive: true, force: true })
console.log(`[sync-canvex-assets] copied from ${source} -> ${target}`)
