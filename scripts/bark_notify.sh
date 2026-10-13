#!/bin/bash
# ANTIGRAVITY NOTIFICATION: Optimized for Simultaneous Dispatch

KEY1="yiowARSQr2795BwRcWLVEb"
KEY2="5dfBYaBrQcwtgk2afxDKrF"
MSG=${1:-"Notification from Antigravity"}
ENCODED_MSG=$(node -e "console.log(encodeURIComponent(\"$MSG\"))" 2>/dev/null || echo "$MSG")
ICON_URL="https://cdn-icons-png.flaticon.com/512/2103/2103633.png"

# URL Construction
URL1="https://api.day.app/$KEY1/$ENCODED_MSG?level=critical&sound=Bubble-ding&icon=$ICON_URL&isArchive=1"
URL2="https://api.day.app/$KEY2/$ENCODED_MSG?level=critical&sound=Bubble-ding&icon=$ICON_URL&isArchive=1"

# Fire both requests instantly in background subshells, silencing output to avoid I/O delay
(curl -s "$URL1" > /dev/null &) 
(curl -s "$URL2" > /dev/null &)

echo "Dispatched: $MSG"
