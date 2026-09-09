// A deterministic real-PTY TUI for redraw/continuation verification.
process.stdin.setRawMode(true)
process.stdin.resume()
const write = (data) => process.stdout.write(data)
let count = 0
let inTui = true
function draw() {
  if (!inTui) return
  const rows = process.stdout.rows || 24
  const cols = process.stdout.columns || 80
  write('\x1b[?1049h\x1b[2J\x1b[?1000;1006h\x1b[?2004h\x1b[?25l')
  for (let row = 1; row <= rows; row++) {
    write(`\x1b[${row};1H\x1b[38;5;${30 + row}mROW ${String(row).padStart(2, '0')} ${'中🙂.'.repeat(Math.max(1, Math.floor((cols - 12) / 5)))}\x1b[0m`)
  }
  // Saved cursor and scrolling margins remain in the tmux pane state, not
  // in the browser's replay. A continuation after reattach must still work.
  write(`\x1b[3;7H\x1b7\x1b[6;${rows - 2}r\x1b[1;1HFRAME_READY_${count}\x1b[${rows};1HEND_FRAME`)
}
draw()
process.stdout.on('resize', draw)
process.stdin.on('data', (data) => {
  for (const byte of data) {
    if (byte === 110) {
      count++
      write(`\x1b8CONTINUED_${count}\x1b[1;1HFRAME_READY_${count}`)
    } else if (byte === 101) {
      inTui = false
      write('\x1b[?1000l\x1b[?1006l\x1b[?2004l\x1b[?25h\x1b[r\x1b[?1049l\r\nSHELL_READY\r\n')
    } else if (byte === 104 && !inTui) {
      for (let line = 0; line < 150; line++) write(`HISTORY_${String(line).padStart(3, '0')}\r\n`)
    }
  }
})
