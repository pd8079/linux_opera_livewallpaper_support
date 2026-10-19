# GX Local Live Wallpaper

This project is a **local-only Manifest V3 browser extension** for Opera GX on
Linux. It replaces the normal new-tab page with a dark, Opera GX-inspired
wallpaper page. It is a browser-page workaround, not a desktop wallpaper and
not a restoration of Opera GX's native Live Wallpapers feature.

## What it does

- Uses a packaged `chrome_url_overrides.newtab` page.
- Imports local MP4 and WebM files through the browser's file picker.
- Checks that a selected video reaches a playable state before replacing the
  current wallpaper.
- Persists imported video `Blob`s in IndexedDB, and small settings in
  `chrome.storage.local`.
- Provides a built-in animated-looking gradient fallback when no video is
  saved or a video cannot be decoded.
- Includes a wallpaper library, reset/remove controls, play/pause, mute,
  volume, scaling, playback speed, and accent-color controls.
- Starts muted and handles autoplay rejection with a visible Play button.
- Respects `prefers-reduced-motion`, keyboard focus, visible focus indicators,
  and an `aria-live` status message.
- Makes no network requests, embeds no external media, uses no remote scripts,
  and requests only the `storage` permission.

The extension replaces Opera GX Speed Dial for normal windows while enabled.
Chrome documents that extensions cannot override the New Tab page in Incognito
windows; test that behavior in your Opera GX build rather than expecting the
workaround to apply there.

## Requirements and local checks

The project has no runtime dependencies. Node.js `22.23.3` is pinned in
`.nvmrc`; `package-lock.json` is intentionally dependency-free.

Run the offline source checks from this directory:

```bash
make test
# or: npm test
```

The check validates the Manifest V3 shape, required files, local-only source,
and the important persistence/playback paths. It does **not** emulate a browser
media decoder.

An optional reproducible test container is included:

```bash
docker build -t gx-live-wallpaper-test .
docker run --rm gx-live-wallpaper-test
```

The browser flow still needs a real Opera GX installation and a real local
video fixture.

## Install in Opera GX from Bazaar/Flatpak

Do not guess the Flatpak application ID. First run this exact command in a
host terminal:

```bash
flatpak list --app
```

Find the Opera GX row and copy the **Application ID** shown by your machine.
The current Flathub package is commonly named `com.opera.opera-gx`, but the
installed ID is the authority. The commands below use `APP_ID` as a placeholder
so that an incorrectly guessed ID is not silently used.

Optional package/runtime inspection after identifying it:

```bash
APP_ID="paste-the-application-id-from-flatpak-list"
flatpak info "$APP_ID"
flatpak info --show-runtime "$APP_ID"
```

### Load the extension

1. Keep this project folder in a stable location. Do not move it after loading
   the extension unless you are prepared to re-check extension storage.
2. Open Opera GX and visit `opera://extensions`.
3. Turn on **Developer mode**.
4. Select **Load unpacked** and choose this project folder, the folder that
   contains `manifest.json`.
5. Open a normal new tab. The fallback page should appear immediately.
6. Open **Controls**, select **Import MP4 / WebM**, and choose a local file.
7. Use the Play button if Opera blocks autoplay. The default is muted by design.

This extension does not need “Allow access to file URLs”. The file picker
provides a `File` object to the extension, which is stored as an IndexedDB Blob;
it does not read arbitrary host paths and does not request filesystem access.
The only extension permission is `storage`.

### Test the real flow

Use a short, known-good local fixture first:

- MP4 containing H.264 video and AAC audio, or
- WebM containing VP8/VP9 video and Opus audio.

Import it, wait for the “ready and saved locally” status, open another new tab,
reload the page, then close and reopen Opera GX. The same wallpaper should be
available. Select **Use fallback** to stop using the video, or **Remove selected
video** to delete it from the extension's IndexedDB library.

## Inspect errors and browser behavior

When something fails, do not treat a black area as a useful diagnostic:

1. Visit `opera://extensions`, find the extension, and inspect its errors.
2. Open the new-tab page, open DevTools for that extension page, and inspect
   the Console. The page reports import, decoder, IndexedDB, and autoplay
   failures in its status area.
3. Check `opera://gpu` for renderer/GPU information.
4. Check `opera://media-internals` while importing or playing a video. Look for
   decoder errors, unsupported codecs, or a failed media pipeline.
5. Try a small VP9 WebM and a small H.264 MP4 separately. MP4 and WebM are
   containers, not guarantees that every codec/profile is available.
6. If the extension works with the built-in fallback but not with a video,
   suspect media decoding or the selected file before changing GPU settings.

For Flatpak diagnostics, use the exact ID found above:

```bash
flatpak permission-show "$APP_ID"
flatpak ps
```

The Flathub Opera GX package documents a bundled FFmpeg library, but that does
not guarantee every codec, profile, hardware decoder, or host GPU combination.
The extension uses the normal file-picker portal, so do **not** add a broad
filesystem override as a first step. If you need to inspect the sandbox for a
specific, reproducible issue, follow Flatpak's debug-shell documentation and
keep any temporary override user-scoped and narrowly targeted.

Do not disable Opera's sandbox, run Opera as root, overwrite protected browser
files, or use a random `--disable-*` flag as a permanent fix.

## Update and remove

### Update

1. Close any open new-tab pages using the extension.
2. Replace the project files with the new version without changing its folder
   location.
3. Visit `opera://extensions` and press **Reload** for this unpacked extension.
4. Open a new tab and run the import/persistence smoke test again.

Unpacked-extension identity and storage can be affected by moving the folder or
loading a copy as a different extension. IndexedDB is profile/extension scoped;
it is not a portable video backup. Export the original video yourself if you
need a backup.

### Remove

1. Visit `opera://extensions`.
2. Disable the extension and confirm that Opera's normal new-tab page returns.
3. Select **Remove** to uninstall it. This removes the extension's saved
   IndexedDB and `chrome.storage.local` data according to Opera's extension
   lifecycle. Keep the original video files if you want to reinstall later.

## Native Opera GX Live Wallpapers: investigation result

### Confirmed

Opera's official Linux page currently says:

> “The current Linux release does not yet include Live Wallpapers and system
> icon customization.”

That is a product/platform limitation, not evidence of a missing preference or
one Flatpak permission. No official flag, extension API, or script was found
that restores the proprietary native renderer on Linux. This project therefore
does not claim to restore native GX wallpaper settings or make a desktop-level
wallpaper.

Opera's GX Mods repository documents a separate GX Mod package format. A mod
has a `manifest.json` plus resources, and the template can describe a video
wallpaper and a `first_frame` image. The guidelines recommend VP9 and a first
frame for animated wallpapers. That confirms how GX Store content is packaged;
it does **not** prove that the native GX wallpaper renderer is present in the
Linux build.

Current primary sources:

- [Opera GX for Linux](https://www.opera.com/gx/linux) — official Linux
  feature limitations, including the explicit Live Wallpapers statement.
- [Opera GX lands on Linux](https://blogs.opera.com/news/2026/03/opera-gx-lands-on-linux/)
  — official Linux release announcement.
- [GX Mods repository](https://github.com/opera-gaming/gxmods) and its
  [mod documentation](https://github.com/opera-gaming/gxmods/tree/main/documentation)
  — package structure, wallpaper resources, and first-frame guidance.
- [Flathub Opera GX](https://flathub.org/en/apps/com.opera.opera-gx) and the
  [Flathub manifest](https://github.com/flathub/com.opera.opera-gx) — package
  channel and bundled codec packaging. Verify the installed version locally.
- [Opera extension API support](https://help.opera.com/en/extensions/apis/)
  — Opera's documented extension API support and storage limitations.
- [Chrome New Tab overrides](https://developer.chrome.com/docs/extensions/develop/ui/override-chrome-pages)
  — the Chromium API this workaround uses; Opera GX compatibility still needs
  testing on the installed build.
- [Chrome storage API](https://developer.chrome.com/docs/extensions/reference/api/storage)
  — small settings storage; video data is deliberately kept in IndexedDB.
- [Chromium audio/video](https://www.chromium.org/audio-video/) and
  [Chromium autoplay](https://www.chromium.org/audio-video/autoplay/) — codec
  and muted-autoplay constraints.
- [Flatpak sandbox permissions](https://docs.flatpak.org/en/latest/sandbox-permissions.html)
  and [debugging](https://docs.flatpak.org/en/latest/debugging.html) — the
  relevant sandbox model and diagnostic commands.

### Confirmed versus hypotheses

| Finding | Status |
| --- | --- |
| The current Opera GX Linux release omits native Live Wallpapers. | Confirmed by Opera's official Linux page. |
| GX Mods have a documented manifest/resource format with video wallpaper and first-frame fields. | Confirmed by Opera Gaming's repository. |
| Chromium documents MV3, new-tab overrides, storage, muted autoplay, and media APIs used here. | Confirmed for Chromium. |
| This exact Opera GX Linux build accepts a generic MV3 `chrome_url_overrides.newtab` extension. | Must be tested locally; not guaranteed by Opera's public docs. |
| A particular black native wallpaper area is caused by Flatpak, GPU, autoplay, or codecs. | A hypothesis until the build and logs identify the failure. |
| A flag or script can restore native GX Live Wallpapers. | No supported mechanism found; do not claim this. |

## What was and was not tested here

Verified in the project environment:

- Manifest and source files are present.
- The extension uses MV3, a local new-tab page, IndexedDB Blob persistence,
  `chrome.storage.local` preferences, local object URLs, and no remote code.
- JavaScript syntax and offline smoke checks pass with `npm test` / `make test`.

Not runnable in the provided container:

- `flatpak list --app` (the `flatpak` command is not installed here).
- Opera GX's extension loader, New Tab override, DevTools, or exact version.
- Real MP4/WebM decoding, autoplay policy, GPU acceleration, Flatpak portals,
  persistence across an Opera restart, and Incognito behavior.

Those are the user-side acceptance tests and are intentionally not described as
passed. If Opera rejects the manifest or refuses the New Tab override, the
native Linux limitation remains and this generic extension workaround is not
compatible with that installed build without an Opera-specific supported API.
