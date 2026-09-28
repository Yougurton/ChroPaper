/**
 * In-page UI localization. Deliberately separate from Wallpaper Engine's own official property
 * translation mechanism (the `localization` block in project.json, driven by `ui_*` tokens) — that
 * one only translates the *property panel* (what you see when you right-click → Properties in WE),
 * and has no way to reach anything we render ourselves inside index.html. This module is what
 * translates the wallpaper's own on-screen interface: the now-playing panel, buttons, badges, and
 * toast messages.
 */

export type Language = 'ru' | 'en';

const messages = {
  ru: {
    badge_unsupported: '⚠ Окружение не поддерживается — показан зал по умолчанию',
    badge_no_lightshow: '⚠ Нет лайтшоу',
    badge_no_audio: '⚠ Нет музыки — карта повреждена',
    badge_gls: '✨ V3-лайтшоу',
    badge_chroma: '✨ Chroma',
    badge_noodle: '🍜 Noodle Extensions',

    phase_playing: 'Сейчас играет:',
    phase_idle: 'Ничего не играет',
    epilepsy_title: '⚠ Предупреждение о светочувствительности',
    epilepsy_text:
      'Обои содержат яркие вспышки и быстро меняющийся свет. У людей со светочувствительной эпилепсией они могут вызвать приступ. Это предупреждение можно отключить в настройках обоев.',
    ui_hint: 'Наведите сюда курсор, чтобы открыть плеер',

    sync_status_searching: '🔎 Ищу карту…',
    sync_status_downloading: '⬇️ Загружаю карту…{percent}',
    sync_status_aligning: '🔄 Синхронизация…',
    sync_status_paused: '⏸ На паузе',
    sync_status_not_found: '🚫 Карта не найдена',
    sync_status_download_failed: '⚠ Не удалось скачать карту',

    track_mapper_by: 'Карта от: {mapper}',

    link_copied: 'Ссылка на карту скопирована',
    link_copy_failed: 'Не удалось скопировать ссылку',
    app_about: 'Об обоях',
    app_about_title: 'Информация об обоях',
    about_description: 'Световые шоу Beat Saber в виде живых обоев',
    about_lead_developer: 'Адаптация для Wallpaper Engine',
    about_version: 'Версия',
    about_thanks: 'Спасибо',
    about_chroviewer_team: 'Разработчики ChroViewer',
    about_beatsaver_team: 'Команда BeatSaver',
    about_based_on: 'ChroPaper основан на',
    about_asset_credits: 'Авторы текстур',
    about_source: 'Исходный код',
    about_link_copied: 'Ссылка скопирована: {url}',

    media_integration_hint: 'Нет данных о треке, лайтшоу идёт по звуку. Проверьте Media Integration в настройках Wallpaper Engine',
    no_audio_hint: 'Нет звука от Wallpaper Engine — проверьте устройство записи звука в настройках',
    listen_unknown_track: 'Без названия',
    size_gb: '{value} ГБ',
    cache_size_pending: 'Размер кеша станет {size} через {seconds} с — верните прежнее значение, чтобы отменить',
    cache_size_applied: 'Размер кеша изменён: {size}',
    cache_size_cancelled: 'Изменение размера кеша отменено',
    size_mb: '{value} МБ',

  },
  en: {
    badge_unsupported: '⚠ Environment not supported — showing the default one',
    badge_no_lightshow: '⚠ No lightshow',
    badge_no_audio: '⚠ No audio — map is broken',
    badge_gls: '✨ V3 lightshow',
    badge_chroma: '✨ Chroma',
    badge_noodle: '🍜 Noodle Extensions',

    phase_playing: 'Now playing:',
    phase_idle: 'Nothing playing',
    epilepsy_title: '⚠ Photosensitivity warning',
    epilepsy_text:
      'This wallpaper contains bright flashes and rapidly changing lights, which may trigger seizures in people with photosensitive epilepsy. You can turn this warning off in the wallpaper settings.',
    ui_hint: 'Move the cursor here to open the player',

    sync_status_searching: '🔎 Searching for a map…',
    sync_status_downloading: '⬇️ Downloading map…{percent}',
    sync_status_aligning: '🔄 Syncing…',
    sync_status_paused: '⏸ Paused',
    sync_status_not_found: '🚫 No map found',
    sync_status_download_failed: "⚠ Couldn't download the map",

    track_mapper_by: 'Map by: {mapper}',

    link_copied: 'Map link copied',
    link_copy_failed: "Couldn't copy the link",
    app_about: 'About',
    app_about_title: 'About the wallpaper',
    about_description: 'Beat Saber lightshows as a live wallpaper',
    about_lead_developer: 'Wallpaper Engine adaptation',
    about_version: 'Version',
    about_thanks: 'Thanks',
    about_chroviewer_team: 'ChroViewer developers',
    about_beatsaver_team: 'BeatSaver team',
    about_based_on: 'ChroPaper is based on',
    about_asset_credits: 'Asset credits',
    about_source: 'Source code',
    about_link_copied: 'Link copied: {url}',

    media_integration_hint: "No track info, so the lightshow follows the sound. Check Media Integration in Wallpaper Engine's settings",
    no_audio_hint: 'No audio from Wallpaper Engine — check the recording device in the settings',
    listen_unknown_track: 'Unknown track',
    size_gb: '{value} GB',
    cache_size_pending: 'The cache size becomes {size} in {seconds} s — set it back to cancel',
    cache_size_applied: 'Cache size changed: {size}',
    cache_size_cancelled: 'Cache size change cancelled',
    size_mb: '{value} MB',

  },
} as const;

export type MessageKey = keyof (typeof messages)['ru'];

let currentLanguage: Language = 'ru';

/** 'auto' isn't stored as its own state — it's resolved once, here, into a concrete language.
 *  navigator.language reflects the OS's own configured display language in Wallpaper Engine's
 *  Chromium-based web runtime, the same underlying source Wallpaper Engine's own General-tab
 *  language setting typically starts from — so this is a reasonable stand-in for "the same
 *  automatic detection Wallpaper Engine itself does" without needing a WE-specific API for it
 *  (there isn't a documented one for reading WE's *own* configured language back from JS). */
export function resolveAutoLanguage(): Language {
  const candidates = navigator.languages ?? [navigator.language];
  for (const candidate of candidates) {
    if (candidate.toLowerCase().startsWith('ru')) return 'ru';
  }
  return 'en';
}

export function setLanguage(language: Language) {
  if (currentLanguage === language) return;
  currentLanguage = language;
  applyStaticTranslations();
}

export function getLanguage(): Language {
  return currentLanguage;
}

export function t(key: MessageKey, vars?: Record<string, string>): string {
  const template = messages[currentLanguage][key] ?? messages.ru[key];
  if (vars === undefined) return template;
  let result: string = template;
  for (const [name, value] of Object.entries(vars)) result = result.split(`{${name}}`).join(value);
  return result;
}

/** Applies the current language to every element in the document tagged data-i18n="<key>" — used
 *  for the small amount of static label text that lives directly in index.html (button labels,
 *  badges whose text never changes once shown) rather than being set from TypeScript. Called once
 *  at startup and again whenever the language actually changes. */
export function applyStaticTranslations() {
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((element) => {
    const key = element.dataset.i18n;
    if (key !== undefined && key in messages.ru) element.textContent = t(key as MessageKey);
  });
}
