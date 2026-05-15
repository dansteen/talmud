// Tiny i18n: strings per locale + a `t(key)` lookup. Subscribers are notified
// when the locale changes so the UI can re-render.
//
// Masechta names and daf labels remain in Hebrew/Aramaic regardless of UI
// locale (per the design intent — the *content* doesn't get translated).

const STORAGE_KEY = 'talmud:locale';

export const LOCALES = [
  { code: 'en', name: 'English',  flag: '🇺🇸' },
  // Spanish-speaking Latin America rather than Spain — Argentine flag stands
  // in as a recognizable South American Spanish marker.
  { code: 'es', name: 'Español',  flag: '🇦🇷' },
  { code: 'fr', name: 'Français', flag: '🇫🇷' },
  { code: 'he', name: 'עברית',    flag: '🇮🇱' },
  { code: 'ru', name: 'Русский',  flag: '🇷🇺' },
];

const STRINGS = {
  en: {
    'app.title': 'Talmud',
    'welcome.guide.doubleTap': 'Double-tap to zoom into a column',
    'welcome.guide.pinch': 'Pinch to zoom freely',
    'welcome.guide.swipe': 'Two-finger swipe for next or previous page',
    'welcome.guide.pull': 'Pull up from the bottom to pick a masechta',
    'welcome.openBtn': 'Open',
    'drawer.empty': 'Pick a masechta to open',
    'drawer.addMasechta': '+ Add another masechta',
    'picker.title': 'Pick a masechta',
    'picker.sederPrefix': 'Seder',
    'language.label': 'Language',
    'settings.title': 'Settings',
    'settings.debug': 'Show debug overlay',
    'a11y.close': 'Close',
    'a11y.back': 'Back',
    'a11y.settings': 'Settings',
  },
  es: {
    'app.title': 'Talmud',
    'welcome.guide.doubleTap': 'Doble toque para acercar una columna',
    'welcome.guide.pinch': 'Pellizque para acercar libremente',
    'welcome.guide.swipe': 'Deslice con dos dedos para la página siguiente o anterior',
    'welcome.guide.pull': 'Tire hacia arriba desde abajo para elegir un masejet',
    'welcome.openBtn': 'Abrir',
    'drawer.empty': 'Elija un masejet para abrir',
    'drawer.addMasechta': '+ Agregar otro masejet',
    'picker.title': 'Elija un masejet',
    'picker.sederPrefix': 'Seder',
    'language.label': 'Idioma',
    'settings.title': 'Configuración',
    'settings.debug': 'Mostrar superposición de depuración',
    'a11y.close': 'Cerrar',
    'a11y.back': 'Atrás',
    'a11y.settings': 'Configuración',
  },
  fr: {
    'app.title': 'Talmud',
    'welcome.guide.doubleTap': 'Double-tapez pour zoomer sur une colonne',
    'welcome.guide.pinch': 'Pincez pour zoomer librement',
    'welcome.guide.swipe': 'Glissez à deux doigts pour la page suivante ou précédente',
    'welcome.guide.pull': 'Tirez vers le haut depuis le bas pour choisir un massekhet',
    'welcome.openBtn': 'Ouvrir',
    'drawer.empty': 'Choisissez un massekhet à ouvrir',
    'drawer.addMasechta': '+ Ajouter un autre massekhet',
    'picker.title': 'Choisissez un massekhet',
    'picker.sederPrefix': 'Seder',
    'language.label': 'Langue',
    'settings.title': 'Paramètres',
    'settings.debug': 'Afficher la superposition de débogage',
    'a11y.close': 'Fermer',
    'a11y.back': 'Retour',
    'a11y.settings': 'Paramètres',
  },
  he: {
    'app.title': 'תלמוד',
    'welcome.guide.doubleTap': 'הקש פעמיים לזום לטור',
    'welcome.guide.pinch': 'צביטה להגדלה חופשית',
    'welcome.guide.swipe': 'החלקה בשתי אצבעות לדף הבא או הקודם',
    'welcome.guide.pull': 'משוך מלמטה לבחירת מסכת',
    'welcome.openBtn': 'פתח',
    'drawer.empty': 'בחר מסכת לפתיחה',
    'drawer.addMasechta': '+ הוסף עוד מסכת',
    'picker.title': 'בחר מסכת',
    'picker.sederPrefix': 'סדר',
    'language.label': 'שפה',
    'settings.title': 'הגדרות',
    'settings.debug': 'הצג שכבת ניפוי',
    'a11y.close': 'סגור',
    'a11y.back': 'חזרה',
    'a11y.settings': 'הגדרות',
  },
  ru: {
    'app.title': 'Талмуд',
    'welcome.guide.doubleTap': 'Двойное касание для увеличения колонки',
    'welcome.guide.pinch': 'Сведение пальцев для свободного масштабирования',
    'welcome.guide.swipe': 'Свайп двумя пальцами для следующей или предыдущей страницы',
    'welcome.guide.pull': 'Потяните снизу, чтобы выбрать масехет',
    'welcome.openBtn': 'Открыть',
    'drawer.empty': 'Выберите масехет, чтобы открыть',
    'drawer.addMasechta': '+ Добавить ещё один масехет',
    'picker.title': 'Выберите масехет',
    'picker.sederPrefix': 'Седер',
    'language.label': 'Язык',
    'settings.title': 'Настройки',
    'settings.debug': 'Показать наложение отладки',
    'a11y.close': 'Закрыть',
    'a11y.back': 'Назад',
    'a11y.settings': 'Настройки',
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
