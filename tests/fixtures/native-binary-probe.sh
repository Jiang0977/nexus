#!/bin/sh
# Isolated PTY integration fixture: inspect input without echo/line discipline,
# then deliberately split multibyte output across separate kernel reads.
stty raw -echo
printf READY
head -c 256 | od -An -v -tx1
printf 'DONE\nUTF8:\344'
sleep 0.03
printf '\270'
sleep 0.03
printf '\255\360\237'
sleep 0.03
printf '\231\202:\344\270'
