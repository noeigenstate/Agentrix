These small, synthetic video fixtures are generated locally from FFmpeg's
`testsrc2=size=320x180:rate=12` source (four seconds, no audio).

- `preview.webm`: VP8, libvpx, 160 kb/s.
- `preview.mp4`: H.264, libx264, yuv420p, faststart.

The desktop smoke test uses them to verify actual decoding, playback, pause and
seeking in Electron. They contain no user media and require no network access.

`preview-large.png` is the former generated sky-and-canopy background (1672×941,
about 3 MB), retained only to test large PNG previews. It is not bundled as an
application wallpaper.
