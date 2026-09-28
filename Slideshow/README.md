# Slideshow

A small Node.js tool that shows the images in a folder as a fullscreen slideshow in your browser, one at a time on a black background. It has no dependencies. You need Node 18.3 or newer.

```
node slideshow.js "C:\Photos\Holiday" --interval 5 --order shuffle
```

Then open http://localhost:3000/ and press **F** to go fullscreen.

## Options

| Option | Values | Default | |
| --- | --- | --- | --- |
| `-f, --fit` | `stretch` \| `center` | `stretch` | `stretch` scales every image to fill the screen, keeping its aspect ratio. `center` shows images at actual size and only shrinks the ones larger than the screen. |
| `-i, --interval` | seconds | `0` (off) | Move to the next image automatically every N seconds. |
| `-t, --fade` | seconds | `0.5` | Length of the cross-fade between images. `0` switches instantly. |
| `-o, --order` | `alpha` \| `shuffle` | `alpha` | Alphabetical order is "natural", so `img2` comes before `img10`. |
| `-r, --recursive` | | off | Also include images in subfolders. |
| `-p, --port` | number | `3000` | |
| `--host` | address | `127.0.0.1` | Use `0.0.0.0` to let other devices on your network view the slideshow. |

Supported formats: jpg, jpeg, png, gif, webp, avif, bmp, svg.

The folder is scanned again each time the page loads. Refreshing the browser picks up new images and reshuffles them.

## Keys

| Key | Action |
| --- | --- |
| Left / Right (or Page Up / Page Down) | Previous / next image |
| Space | Pause / resume the timer |
| F, or double-click | Toggle fullscreen |

To start fullscreen with no browser UI, open the page in kiosk mode, e.g. `chrome --kiosk http://localhost:3000/`.
