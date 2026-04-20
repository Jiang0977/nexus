import { execFileSync } from 'node:child_process'

function readStatus() {
  return execFileSync('git', ['status', '--short', '--', 'frontend/dist'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  }).trim()
}

const status = readStatus()

if (status) {
  console.error('frontend/dist is out of sync with frontend/src. Rebuild and commit the vendored bundle.')
  console.error(status)
  process.exit(1)
}
