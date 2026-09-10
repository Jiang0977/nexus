// Keep Unicode in the inactive primary buffer as well as the active TUI.
process.stdout.write('PRIMARY_Cafe\u0301_中🙂\r\n')
require('./tmux-tui-state.cjs')
process.stdin.on('data', data => {
  for (const byte of data) {
    if (byte === 117) process.stdout.write('\x1b[4;15HCafe\u0301 A\u0308\u0323 中\u0301 🙂 UNICODE_READY')
    if (byte === 118) process.stdout.write('\x1b[38;2;12;')
    if (byte === 119) process.stdout.write('34;56m\x1b[5;15HPARSER_CONTINUED\x1b[0m')
    if (byte === 106) process.stdout.write('\x1b[7;15HCOMBINE_e')
    if (byte === 107) process.stdout.write('\u0301_JOINED')
    if (byte === 105) process.stdout.write('\x1b[9;1HINSERT_TAIL\x1b[9;1H\x1b[1m\x1b[4h中')
    if (byte === 111) process.stdout.write('\x1b[4l\x1b[0m')
    if (byte === 98) process.stdout.write('\x1b]52;c;' + Buffer.from('Clipboard 中文🙂 e\u0301\n'.repeat(400)).toString('base64') + '\x07')
    if (byte === 120) process.exit(0)
  }
})
