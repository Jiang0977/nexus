import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

for (const scenario of ['user', 'system', 'both']) {
  test(`restart selects ${scenario} installation without crossing service scopes`, () => {
    const root = mkdtempSync(join(tmpdir(), 'nexus-service-scope-'))
    try {
      mkdirSync(join(root, 'bin'))
      for (const file of ['nexus-systemd.sh', 'restart-nexus-service.sh']) copyFileSync(new URL(`../scripts/${file}`, import.meta.url), join(root, file))
      writeFileSync(join(root, 'bin/systemctl'), `#!/bin/sh
printf '%s\\n' "$*" >> "$TEST_LOG"
scope=system
if [ "$1" = --user ]; then scope=user; shift; fi
if [ "$1" = show ]; then
  if [ "$TEST_SCENARIO" = "$scope" ] || [ "$TEST_SCENARIO" = both ]; then echo /opt/nexus; fi
fi
`, { mode: 0o755 })
      writeFileSync(join(root, 'bin/sudo'), '#!/bin/sh\necho SUDO >> "$TEST_LOG"\nshift\nexec "$@"\n', { mode: 0o755 })
      writeFileSync(join(root, 'bin/curl'), '#!/bin/sh\nprintf 401\n', { mode: 0o755 })
      const log = join(root, 'log')
      const result = spawnSync('bash', [join(root, 'restart-nexus-service.sh')], { env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, TEST_LOG: log, TEST_SCENARIO: scenario, NEXUS_SERVICE_SCOPE: 'auto' }, encoding: 'utf8' })
      const calls = readFileSync(log, 'utf8')
      if (scenario === 'both') {
        assert.equal(result.status, 1)
        assert.match(result.stderr, /Both user and system/)
        assert.doesNotMatch(calls, /restart|SUDO/)
      } else {
        assert.equal(result.status, 0, result.stderr)
        assert.match(result.stdout, /Healthcheck ok: HTTP 401/)
        if (scenario === 'user') {
          assert.match(calls, /--user restart nexus/)
          assert.doesNotMatch(calls, /SUDO/)
        } else {
          assert.match(calls, /SUDO\nrestart nexus/)
          assert.doesNotMatch(calls, /--user restart/)
        }
      }
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
}
