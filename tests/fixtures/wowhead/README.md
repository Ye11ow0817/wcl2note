# Wowhead integration test snapshots

Unmodified resources downloaded on 2026-10-29 from the official tooltip CDN:

- `tooltips.js.txt`: <https://wow.zamimg.com/js/tooltips.js>
- `universal.css`: <https://wow.zamimg.com/css/universal.css?19>

Electron integration tests intercept those URLs with these snapshots, while
mocking only spell data and scaling responses. The production app loads the
official CDN resources directly; these files are not included in its bundle.

Integration instructions: <https://www.wowhead.com/tooltips>.
