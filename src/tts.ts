import { getSettings } from './store.ts';

export const ttsSupported = typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';

let voices: SpeechSynthesisVoice[] = [];
if (ttsSupported) {
  const load = () => (voices = speechSynthesis.getVoices());
  load();
  speechSynthesis.addEventListener?.('voiceschanged', load);
}

function pickVoice(lang: string): SpeechSynthesisVoice | undefined {
  const same = voices.filter((v) => v.lang.replace('_', '-').toLowerCase() === lang.toLowerCase());
  return same.find((v) => v.localService) ?? same[0] ?? voices.find((v) => v.lang.toLowerCase().startsWith('en'));
}

export function speak(word: string) {
  if (!ttsSupported) return;
  const lang = getSettings().accent;
  speechSynthesis.cancel(); // never stack utterances
  const u = new SpeechSynthesisUtterance(word);
  u.lang = lang;
  const v = pickVoice(lang);
  if (v) u.voice = v;
  u.rate = 0.9;
  speechSynthesis.speak(u);
}

/** null = unknown yet (voices load asynchronously in some browsers) */
export function hasEnglishVoice(): boolean | null {
  if (!ttsSupported) return false;
  const v = speechSynthesis.getVoices();
  return v.length ? v.some((x) => x.lang.toLowerCase().startsWith('en')) : null;
}
export function onVoicesChanged(fn: () => void) {
  if (ttsSupported) speechSynthesis.addEventListener?.('voiceschanged', fn);
}
