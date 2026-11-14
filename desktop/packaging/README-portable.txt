3RTC (portable)
===============

Run 3rtc.exe from this folder. Nothing is installed and no admin rights are needed.

Your settings are kept in settings.json next to 3rtc.exe (the empty file named "portable"
tells 3RTC to keep them here instead of in your user profile), so you can carry this folder
on a USB stick or keep several copies.

Updates: 3RTC checks https://3rtc.me for new versions and puts them in place in this folder by
itself (More > Desktop > Updates). Turn "Update automatically" off there to keep this version.

Windows may say "Windows protected your PC" the first time: 3RTC isn't signed yet. Click
"More info", then "Run anyway".

To remove 3RTC, delete this folder. (If you turned on "Start with Windows" or 3rtc:// links,
turn them off first in More > Desktop.)

Video files play with mpv: libmpv-2.dll is an unmodified LGPL build of mpv (https://mpv.io,
licence: LGPL 2.1 or later, source: https://github.com/mpv-player/mpv; the build comes from
https://github.com/zhongfly/mpv-winbuild). You may replace it with another libmpv-2.dll.

https://3rtc.me
