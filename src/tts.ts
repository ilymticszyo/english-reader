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
