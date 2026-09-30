/**
 * Kana → romaji (Hepburn), for matching a song's Japanese name against the romanized one maps
 * often use: "マイマイマイ" → "maimaimai" (the map is "Mai Mai Mai"). Kanji can't be read this way,
 * so a title that has any is left alone (hasOnlyKana).
 */

const BASE: Record<string, string> = {
  あ: 'a', い: 'i', う: 'u', え: 'e', お: 'o',
  か: 'ka', き: 'ki', く: 'ku', け: 'ke', こ: 'ko', が: 'ga', ぎ: 'gi', ぐ: 'gu', げ: 'ge', ご: 'go',
  さ: 'sa', し: 'shi', す: 'su', せ: 'se', そ: 'so', ざ: 'za', じ: 'ji', ず: 'zu', ぜ: 'ze', ぞ: 'zo',
  た: 'ta', ち: 'chi', つ: 'tsu', て: 'te', と: 'to', だ: 'da', ぢ: 'ji', づ: 'zu', で: 'de', ど: 'do',
  な: 'na', に: 'ni', ぬ: 'nu', ね: 'ne', の: 'no',
  は: 'ha', ひ: 'hi', ふ: 'fu', へ: 'he', ほ: 'ho', ば: 'ba', び: 'bi', ぶ: 'bu', べ: 'be', ぼ: 'bo',
  ぱ: 'pa', ぴ: 'pi', ぷ: 'pu', ぺ: 'pe', ぽ: 'po',
  ま: 'ma', み: 'mi', む: 'mu', め: 'me', も: 'mo',
  や: 'ya', ゆ: 'yu', よ: 'yo',
  ら: 'ra', り: 'ri', る: 'ru', れ: 're', ろ: 'ro',
  わ: 'wa', ゐ: 'i', ゑ: 'e', を: 'o', ん: 'n', ゔ: 'vu',
  ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o', ゎ: 'wa',
};
const SMALL_Y: Record<string, string> = { ゃ: 'a', ゅ: 'u', ょ: 'o' };
const SMALL_VOWEL = new Set(['ぁ', 'ぃ', 'ぅ', 'ぇ', 'ぉ']);

/** Katakana → hiragana (same sounds, one table). */
function toHiragana(text: string): string {
  return text.replace(/[ァ-ヶ]/gu, (char) => String.fromCharCode(char.charCodeAt(0) - 0x60));
}

/** Whether the text (letters only) is written in kana alone — something toRomaji can read. */
export function hasOnlyKana(text: string): boolean {
  const letters = text.normalize('NFKC').replace(/[^\p{L}\p{N}ー]/gu, '');
  return letters !== '' && /^[ぁ-ゖァ-ヺー]+$/u.test(letters);
}

/** Hepburn romaji of the kana in `text` (anything else is kept as is). Long-vowel marks are
 *  dropped — the comparison this is for ignores vowel length anyway. */
export function toRomaji(text: string): string {
  const chars = [...toHiragana(text.normalize('NFKC'))];
  let out = '';
  let doubleNext = false;
  for (let index = 0; index < chars.length; index++) {
    const char = chars[index] ?? '';
    const next = chars[index + 1] ?? '';
    if (char === 'っ') {
      doubleNext = true;
      continue;
    }
    if (char === 'ー') continue;
    let syllable = BASE[char];
    if (syllable === undefined) {
      out += char;
      doubleNext = false;
      continue;
    }
    // きゃ → kya, しゃ → sha, ちゃ → cha, じゃ → ja
    const smallY = SMALL_Y[next];
    if (smallY !== undefined && syllable.endsWith('i') && syllable.length > 1) {
      const stem = syllable.slice(0, -1);
      syllable = /(?:sh|ch|j)$/.test(stem) ? stem + smallY : `${stem}y${smallY}`;
      index++;
    } else if (SMALL_VOWEL.has(next) && syllable.length > 1) {
      // ファ → fa, ティ → ti, ヴィ → vi
      syllable = syllable.slice(0, -1).replace(/^ts$/, 't').replace(/^ch$/, 't') + (BASE[next] ?? '');
      index++;
    }
    if (doubleNext) syllable = (syllable.startsWith('ch') ? 't' : syllable[0] ?? '') + syllable;
    doubleNext = false;
    out += syllable;
  }
  return out;
}
