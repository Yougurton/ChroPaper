<div align="center">

# ChroPaper

**A web wallpaper for Wallpaper Engine that shows Beat Saber lightshows**

[Русская версия](README.ru.md)

</div>

ChroPaper is a web wallpaper for [Wallpaper Engine](https://www.wallpaperengine.io/) that turns the music playing on your PC into a Beat Saber lightshow right on your desktop. It's built on [ChroViewer](https://github.com/Umbranoxio/chroviewer), a browser-based Beat Saber map viewer. ChroPaper keeps ChroViewer's rendering (environments, lighting, walls and Chroma/Noodle support) and adds what a wallpaper needs: a lightshow generated live from the audio, syncing with real BeatSaver maps, a compact player and settings in Wallpaper Engine.

## Features

- **Beat Saber environments.** More than 30 environments from the game, with live lighting, rings and mirrors.
- **Chroma, Noodle Extensions and V3.** Enhanced lighting and advanced environments.
- **Lightshow from your music.** The screensaver follows the tempo and beats of whatever plays on your computer and lights it the way a mapper would; a calm idle show runs when nothing plays.
- **Sync with BeatSaver maps.** When a map exists for the playing track, its real lightshow is shown, lined up with the music by the audio itself. Tracks synced before start from the cache without any server request.
- **Compact player.** Current track and cover; it opens when you hover over it.

## Setup

How to install the dependencies, build the project and add it to Wallpaper Engine is described in **[SETUP.md](SETUP.md)**.

## Project structure

| Path | Contents |
| --- | --- |
| `src/wallpaper/` | The wallpaper layer: the screensaver and its lightshow generator, sync (BeatSaver search, audio alignment), player UI, settings |
| `src/core/`, `src/renderer/`, `src/mapfile/`, `src/sources/` | ChroViewer's map parsing and three.js renderer, with fixes and optimizations for the wallpaper |
| `public/environments/` | Environment geometry and lighting data (from ChroMapper, through ChroViewer) |
| `public/project.json` | Wallpaper Engine manifest and user settings (keep its CRLF line endings and tab indentation) |
| `index.html` | Page layout and styles of the player |

## Credits

- **[ChroViewer](https://github.com/Umbranoxio/chroviewer)** by **Umbranoxio** and contributors: the original Beat Saber map and replay viewer ChroPaper is built on.
- **[ChroMapper](https://github.com/Caeden117/ChroMapper)** by **Caeden117** and contributors. ChroViewer's environment data, preview math, shaders, materials and lighting code come from ChroMapper.
- **Yougurton** adapted ChroViewer for Wallpaper Engine as ChroPaper: lightshow generation, sync, the interface and the settings.
- Texture authors are listed in [ATTRIBUTIONS.md](ATTRIBUTIONS.md).
- Maps come from [BeatSaver](https://beatsaver.com/), covers and alternative song names from the iTunes Search API.

## License

ChroPaper is distributed under the **GNU General Public License v2.0**. The full text is in [LICENSE](LICENSE). If you share a modified build, its source code must be available under the same license.

## Disclaimer

ChroPaper is an unofficial fan project. It isn't affiliated with or endorsed by Beat Games, Meta, Wallpaper Engine, ChroMapper, ChroViewer or BeatSaver. Beat Saber is a trademark of Beat Games. The maps and music you play belong to their respective authors.
