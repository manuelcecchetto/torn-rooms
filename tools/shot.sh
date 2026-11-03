#!/bin/sh
# Screenshot Chrome's front window by window id (unaffected by windows above it):
#   tools/shot.sh out.png [WxH+X+Y crop in window points]
out=${1:-/tmp/tr-dev/shot.png}
wid=$(osascript -l JavaScript -e '
ObjC.import("CoreGraphics");
const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0)));
const w = list.find(w => w.kCGWindowOwnerName === "Google Chrome" && w.kCGWindowLayer === 0 && (w.kCGWindowName || "").length > 0);
w ? w.kCGWindowNumber : "";')
[ -z "$wid" ] && { echo "no chrome window"; exit 1; }
screencapture -x -o -l "$wid" "$out"
if [ -n "$2" ]; then
  w=$(echo $2 | cut -dx -f1); rest=$(echo $2 | cut -dx -f2); h=$(echo $rest | cut -d+ -f1); x=$(echo $rest | cut -d+ -f2); y=$(echo $rest | cut -d+ -f3)
  sips -c $((h*2)) $((w*2)) --cropOffset $((y*2)) $((x*2)) "$out" --out "$out" >/dev/null
fi
echo "$out"
