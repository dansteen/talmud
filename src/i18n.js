// Tiny i18n: strings per locale + a `t(key)` lookup. Subscribers are notified
// when the locale changes so the UI can re-render.
//
// Masechta names and daf labels remain in Hebrew/Aramaic regardless of UI
// locale (per the design intent — the *content* doesn't get translated).

const STORAGE_KEY = 'talmud:locale';

export const LOCALES = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Español' },
  { code: 'fr', name: 'Français' },
  { code: 'he', name: 'עברית' },
  { code: 'ru', name: 'Русский' },
];

const STRINGS = {
  en: {
    'app.title': 'Talmud',
    'welcome.guide.doubleTap': 'Double-tap to zoom into a column',
    'welcome.guide.pinch': 'Pinch to zoom freely',
    'welcome.guide.swipe': 'Three-finger swipe for next or previous page',
    'welcome.guide.pull': 'Pull up from the bottom to pick a masechta',
    'welcome.openBtn': 'Open',
    'drawer.empty': 'Pick a masechta to open',
    'drawer.addMasechta': '+ Add masechta',
    'picker.title': 'Pick a masechta',
    'picker.sederPrefix': 'Seder',
    'language.label': 'Language',
    'a11y.close': 'Close',
    'a11y.back': 'Back',
  },
  es: {
    'app.title': 'Talmud',
    'welcome.guide.doubleTap': 'Doble toque para acercar una columna',
    'welcome.guide.pinch': 'Pellizque para acercar libremente',
    'welcome.guide.swipe': 'Deslice con tres dedos para la página siguiente o anterior',
    'welcome.guide.pull': 'Tire hacia arriba desde abajo para elegir un masejet',
    'welcome.openBtn': 'Abrir',
    'drawer.empty': 'Elija un masejet para abrir',
    'drawer.addMasechta': '+ Agregar masejet',
    'picker.title': 'Elija un masejet',
    'picker.sederPrefix': 'Seder',
    'language.label': 'Idioma',
    'a11y.close': 'Cerrar',
    'a11y.back': 'Atrás',
  },
  fr: {
    'app.title': 'Talmud',
    'welcome.guide.doubleTap': 'Double-tapez pour zoomer sur une colonne',
    'welcome.guide.pinch': 'Pincez pour zoomer librement',
    'welcome.guide.swipe': 'Glissez à trois doigts pour la page suivante ou précédente',
    'welcome.guide.pull': 'Tirez vers le haut depuis le bas pour choisir un massekhet',
    'welcome.openBtn': 'Ouvrir',
    'drawer.empty': 'Choisissez un massekhet à ouvrir',
    'drawer.addMasechta': '+ Ajouter un massekhet',
    'picker.title': 'Choisissez un massekhet',
    'picker.sederPrefix': 'Seder',
    'language.label': 'Langue',
    'a11y.close': 'Fermer',
    'a11y.back': 'Retour',
  },
  he: {
    'app.title': 'תלמוד',
    'welcome.guide.doubleTap': 'הקש פעמיים לזום לטור',
    'welcome.guide.pinch': 'צביטה להגדלה חופשית',
    'welcome.guide.swipe': 'החלקה בשלוש אצבעות לדף הבא או הקודם',
    'welcome.guide.pull': 'משוך מלמטה לבחירת מסכת',
    'welcome.openBtn': 'פתח',
    'drawer.empty': 'בחר מסכת לפתיחה',
    'drawer.addMasechta': '+ הוסף מסכת',
    'picker.title': 'בחר מסכת',
    'picker.sederPrefix': 'סדר',
    'language.label': 'שפה',
    'a11y.close': 'סגור',
    'a11y.back': 'חזרה',
  },
  ru: {
    'app.title': 'Талмуд',
    'welcome.guide.doubleTap': 'Двойное касание для увеличения колонки',
    'welcome.guide.pinch': 'Сведение пальцев для свободного масштабирования',
    'welcome.guide.swipe': 'Свайп тремя пальцами для следующей или предыдущей страницы',
    'welcome.guide.pull': 'Потяните снизу, чтобы выбрать масехет',
    'welcome.openBtn': 'Открыть',
    'drawer.empty': 'Выберите масехет, чтобы открыть',
    'drawer.addMasechta': '+ Добавить масехет',
    'picker.title': 'Выберите масехет',
    'picker.sederPrefix': 'Седер',
    'language.label': 'Язык',
    'a11y.close': 'Закрыть',
    'a11y.back': 'Назад',
  },
};

function detectInitial() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && STRINGS[saved]) return saved;
  } catch { /* ignore */ }

  // Browser language → first matching locale
  const langs = navigator.languages || [navigator.language || 'en'];
  for (const l of langs) {
    const code = l.toLowerCase().split('-')[0];
    if (STRINGS[code]) return code;
  }
  return 'en';
}

let current = detectInitial();
const subscribers = new Set();

export function getLocale() {
  return current;
}

export function setLocale(code) {
  if (!STRINGS[code] || code === current) return;
  current = code;
  try { localStorage.setItem(STORAGE_KEY, code); } catch { /* ignore */ }
  for (const fn of subscribers) fn(current);
}

export function onLocaleChange(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function t(key) {
  return STRINGS[current][key] ?? STRINGS.en[key] ?? key;
}

// Dictionary of all keys for `current` locale — useful for one-shot snapshots.
export function all() {
  return STRINGS[current];
}
