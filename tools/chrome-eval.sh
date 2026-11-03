#!/bin/sh
# Run a JS file (or stdin) in the user's open torn.com Chrome tab and print the result.
# Needs Chrome > View > Developer > Allow JavaScript from Apple Events.
set -e
js=$(if [ -n "$1" ]; then cat "$1"; else cat; fi)
JS="$js" osascript <<'OSA'
set js to system attribute "JS"
tell application "Google Chrome"
  repeat with w in windows
    repeat with t in tabs of w
      if URL of t contains "torn.com" then return (execute t javascript js)
    end repeat
  end repeat
end tell
return "no torn tab"
OSA
