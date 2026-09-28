# Установка ChroPaper

[English version](SETUP.md) · [Назад к README](README.ru.md)

## Что понадобится

- [Node.js](https://nodejs.org/) версии 20 или новее (вместе с npm).
- [Wallpaper Engine](https://store.steampowered.com/app/431960/Wallpaper_Engine/) в Steam, чтобы запустить проект как обои.

## Получение кода

```bash
git clone https://github.com/Yougurton/ChroPaper.git
cd ChroPaper
```

Или скачайте репозиторий архивом с GitHub (**Code → Download ZIP**) и распакуйте.

## Установка зависимостей

1. Установите [Node.js](https://nodejs.org/) (подойдёт LTS-версия), npm ставится вместе с ним. Проверьте, что всё работает:

   ```bash
   node -v
   npm -v
   ```

2. В папке проекта выполните:

   ```bash
   npm install
   ```

   npm скачает всё, что указано в `package.json` (three.js, Vite, TypeScript и остальное), в папку `node_modules/`. Это нужно сделать один раз и повторять после изменений в `package.json`.

## Сборка

```bash
npm run build
```

Готовые обои появятся в папке `dist/`. Там же будут `project.json` (настройки для Wallpaper Engine) и `preview.jpg`.

## Установка в Wallpaper Engine

1. Создайте папку для обоев в папке проектов Wallpaper Engine, например:
   `…\Steam\steamapps\common\wallpaper_engine\projects\myprojects\ChroPaper\`
2. Скопируйте в неё **всё содержимое** `dist/`, чтобы `index.html` и `project.json` лежали прямо в этой папке.
3. Перезапустите Wallpaper Engine (или заново откройте его окно). ChroPaper появится во вкладке **Установленные**, и её можно выбрать как обычные обои. Все настройки находятся в панели свойств справа.

Для обновления пересоберите проект и замените содержимое папки. Настройки Wallpaper Engine сохранит.

## Разработка

```bash
npm run dev       # сервер разработки с горячей перезагрузкой
npm run build     # сборка в dist/
npm run preview   # локальный просмотр собранной dist/
```

В обычном браузере обои работают с настройками по умолчанию. API Wallpaper Engine (настройки, аудиовход, данные медиаплеера) там недоступны, поэтому заставка не реагирует на звук. Эти функции проверяйте на сборке, установленной в Wallpaper Engine, как описано выше.
