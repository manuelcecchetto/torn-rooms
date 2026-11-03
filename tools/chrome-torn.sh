#!/bin/sh
# Focus (and optionally reload) the user's torn.com tab in Chrome: tools/chrome-torn.sh [reload]
osascript - "$1" <<'OSA'
on run argv
  tell application "Google Chrome"
    repeat with w in windows
      set i to 0
      repeat with t in tabs of w
        set i to i + 1
        if URL of t contains "torn.com" then
          set active tab index of w to i
          set index of w to 1
          if (item 1 of argv) is "reload" then tell t to reload
          return "ok"
        end if
      end repeat
    end repeat
  end tell
  return "no torn tab"
end run
OSA
