# ChroPaper setup

[Русская версия](SETUP.ru.md) · [Back to README](README.md)

## Requirements

- [Node.js](https://nodejs.org/) 20 or newer, with npm.
- [Wallpaper Engine](https://store.steampowered.com/app/431960/Wallpaper_Engine/) on Steam, to run it as a wallpaper.

## Get the code

```bash
git clone https://github.com/Yougurton/ChroPaper.git
cd ChroPaper
```

Or download the repository as a ZIP from GitHub (**Code → Download ZIP**) and unpack it.

## Install dependencies

1. Install [Node.js](https://nodejs.org/) (the LTS version is fine). npm comes with it. Check that it works:

   ```bash
   node -v
   npm -v
   ```

2. In the project folder, run:

   ```bash
   npm install
   ```

   npm downloads everything listed in `package.json` (three.js, Vite, TypeScript and the rest) into `node_modules/`. This is needed once, and again after `package.json` changes.

## Build

```bash
npm run build
```

The finished wallpaper is written to `dist/`, together with `project.json` (the Wallpaper Engine settings) and `preview.jpg`.

## Install into Wallpaper Engine

1. Create a folder for the wallpaper inside Wallpaper Engine's projects folder, for example:
   `…\Steam\steamapps\common\wallpaper_engine\projects\myprojects\ChroPaper\`
2. Copy **everything inside** `dist/` into that folder, so that `index.html` and `project.json` are directly in it.
3. Restart Wallpaper Engine (or reopen its window). ChroPaper appears under **Installed** and can be selected like any other wallpaper. All its settings are in the wallpaper's properties panel on the right.

When you update, rebuild and replace the folder's contents. Wallpaper Engine keeps your settings.

## Development

```bash
npm run dev       # dev server with hot reload
npm run build     # production build into dist/
npm run preview   # serve the built dist/ locally
```

In a regular browser the wallpaper runs with its default settings. Wallpaper Engine's APIs (settings, audio input, media info) aren't available there, so the screensaver can't react to sound. To test those features, install the build into Wallpaper Engine as described above.
