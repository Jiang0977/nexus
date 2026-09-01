import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

test('frontend main.tsx registers /sw.js and does not clear service workers or caches', () => {
  const mainTsxPath = path.resolve(process.cwd(), 'frontend/src/main.tsx')
  const content = fs.readFileSync(mainTsxPath, 'utf8')

  assert.match(
    content,
    /navigator\.serviceWorker\.register\(['"]\/sw\.js['"]\)/,
    'main.tsx must register /sw.js'
  )
  assert.doesNotMatch(content, /getRegistrations/, 'main.tsx must not unregister service workers')
  assert.doesNotMatch(content, /unregister/, 'main.tsx must not unregister service workers')
  assert.doesNotMatch(content, /caches\.keys/, 'main.tsx must not inspect cache keys')
  assert.doesNotMatch(content, /caches\.delete/, 'main.tsx must not delete caches')
})
