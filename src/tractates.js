// All tractates in seder order. lastDaf/lastAmud validated against shas.org API.
export const TRACTATES = [
  // Seder Zeraim
  { slug: 'berachos',      he: 'ברכות',      en: 'Berakhot',     lastDaf: 64,  lastAmud: 'a' },
  // Seder Moed
  { slug: 'shabbos',       he: 'שבת',         en: 'Shabbat',      lastDaf: 157, lastAmud: 'b' },
  { slug: 'eruvin',        he: 'עירובין',     en: 'Eruvin',       lastDaf: 105, lastAmud: 'b' },
  { slug: 'pesachim',      he: 'פסחים',       en: 'Pesachim',     lastDaf: 121, lastAmud: 'b' },
  { slug: 'shekalim',      he: 'שקלים',       en: 'Shekalim',     lastDaf: 22,  lastAmud: 'b' },
  { slug: 'yoma',          he: 'יומא',        en: 'Yoma',         lastDaf: 88,  lastAmud: 'a' },
  { slug: 'sukkah',        he: 'סוכה',        en: 'Sukkah',       lastDaf: 56,  lastAmud: 'b' },
  { slug: 'beitzah',       he: 'ביצה',        en: 'Beitzah',      lastDaf: 40,  lastAmud: 'b' },
  { slug: 'rosh-hashanah', he: 'ראש השנה',   en: 'Rosh Hashanah',lastDaf: 35,  lastAmud: 'b' },
  { slug: 'taanis',        he: 'תענית',       en: 'Taanit',       lastDaf: 31,  lastAmud: 'a' },
  { slug: 'megillah',      he: 'מגילה',       en: 'Megillah',     lastDaf: 32,  lastAmud: 'a' },
  { slug: 'moed-katan',    he: 'מועד קטן',   en: 'Moed Katan',   lastDaf: 29,  lastAmud: 'a' },
  { slug: 'chagigah',      he: 'חגיגה',       en: 'Chagigah',     lastDaf: 27,  lastAmud: 'a' },
  // Seder Nashim
  { slug: 'yevamos',       he: 'יבמות',       en: 'Yevamot',      lastDaf: 122, lastAmud: 'b' },
  { slug: 'kesuvos',       he: 'כתובות',      en: 'Ketubot',      lastDaf: 112, lastAmud: 'b' },
  { slug: 'nedarim',       he: 'נדרים',       en: 'Nedarim',      lastDaf: 91,  lastAmud: 'b' },
  { slug: 'nazir',         he: 'נזיר',        en: 'Nazir',        lastDaf: 66,  lastAmud: 'b' },
  { slug: 'sotah',         he: 'סוטה',        en: 'Sotah',        lastDaf: 49,  lastAmud: 'b' },
  { slug: 'gittin',        he: 'גיטין',       en: 'Gittin',       lastDaf: 90,  lastAmud: 'b' },
  { slug: 'kiddushin',     he: 'קידושין',     en: 'Kiddushin',    lastDaf: 82,  lastAmud: 'b' },
  // Seder Nezikin
  { slug: 'bava-kamma',    he: 'בבא קמא',    en: 'Bava Kamma',   lastDaf: 119, lastAmud: 'b' },
  { slug: 'bava-metziah',  he: 'בבא מציעא',  en: 'Bava Metzia',  lastDaf: 119, lastAmud: 'a' },
  { slug: 'bava-basra',    he: 'בבא בתרא',   en: 'Bava Batra',   lastDaf: 176, lastAmud: 'b' },
  { slug: 'sanhedrin',     he: 'סנהדרין',     en: 'Sanhedrin',    lastDaf: 113, lastAmud: 'b' },
  { slug: 'makkos',        he: 'מכות',        en: 'Makkot',       lastDaf: 24,  lastAmud: 'b' },
  { slug: 'shevuos',       he: 'שבועות',      en: 'Shevuot',      lastDaf: 49,  lastAmud: 'b' },
  { slug: 'avodah-zarah',  he: 'עבודה זרה',  en: 'Avodah Zarah', lastDaf: 76,  lastAmud: 'b' },
  { slug: 'horayos',       he: 'הוריות',      en: 'Horayot',      lastDaf: 14,  lastAmud: 'a' },
  // Seder Kodashim
  { slug: 'zevachim',      he: 'זבחים',       en: 'Zevachim',     lastDaf: 120, lastAmud: 'b' },
  { slug: 'menachos',      he: 'מנחות',       en: 'Menahot',      lastDaf: 110, lastAmud: 'a' },
  { slug: 'chullin',       he: 'חולין',       en: 'Hullin',       lastDaf: 142, lastAmud: 'a' },
  { slug: 'bechoros',      he: 'בכורות',      en: 'Bekhorot',     lastDaf: 61,  lastAmud: 'a' },
  { slug: 'arachin',       he: 'ערכין',       en: 'Arakhin',      lastDaf: 34,  lastAmud: 'a' },
  { slug: 'temurah',       he: 'תמורה',       en: 'Temurah',      lastDaf: 34,  lastAmud: 'a' },
  { slug: 'kereisos',      he: 'כריתות',      en: 'Keritot',      lastDaf: 28,  lastAmud: 'b' },
  { slug: 'meilah',        he: 'מעילה',       en: 'Meilah',       lastDaf: 22,  lastAmud: 'a' },
  // Seder Taharot
  { slug: 'niddah',        he: 'נידה',        en: 'Niddah',       lastDaf: 73,  lastAmud: 'a' },
];

export function getTractate(slug) {
  return TRACTATES.find(t => t.slug === slug);
}

// Total amudim for a tractate (each daf has 2 amudim except possibly the last)
export function totalAmudim(tractate) {
  const inner = (tractate.lastDaf - 2) * 2;
  return inner + (tractate.lastAmud === 'b' ? 2 : 1);
}

// Convert daf/amud to a 0-based linear amud index
// (2a → 0, 2b → 1, 3a → 2, …)
export function amudToIndex(daf, amud) {
  return (daf - 2) * 2 + (amud === 'b' ? 1 : 0);
}

// Convert a 0-based linear amud index back to daf/amud
export function indexToAmud(index) {
  return {
    daf: 2 + Math.floor(index / 2),
    amud: index % 2 === 0 ? 'a' : 'b',
  };
}

// Last valid amud index for a tractate
export function lastAmudIndex(tractate) {
  return amudToIndex(tractate.lastDaf, tractate.lastAmud);
}

// Clamp daf/amud to valid range for a tractate
export function clampLocation(tractate, daf, amud) {
  const d = Math.max(2, Math.min(daf, tractate.lastDaf));
  const a = d === tractate.lastDaf && tractate.lastAmud === 'a' ? 'a' : amud;
  return { daf: d, amud: a };
}

// Advance one amud forward; returns null if already at end
export function nextAmud(tractate, daf, amud) {
  if (daf === tractate.lastDaf && amud === tractate.lastAmud) return null;
  if (amud === 'a') return { daf, amud: 'b' };
  return { daf: daf + 1, amud: 'a' };
}

// Go one amud back; returns null if at beginning
export function prevAmud(_tractate, daf, amud) {
  if (daf === 2 && amud === 'a') return null;
  if (amud === 'b') return { daf, amud: 'a' };
  return { daf: daf - 1, amud: 'b' };
}

// Hebrew daf label (e.g. daf=5 → "ה")
const HE_DIGITS = ['', 'א','ב','ג','ד','ה','ו','ז','ח','ט','י',
  'יא','יב','יג','יד','טו','טז','יז','יח','יט','כ',
  'כא','כב','כג','כד','כה','כו','כז','כח','כט','ל',
  'לא','לב','לג','לד','לה','לו','לז','לח','לט','מ',
  'מא','מב','מג','מד','מה','מו','מז','מח','מט','נ',
  'נא','נב','נג','נד','נה','נו','נז','נח','נט','ס',
  'סא','סב','סג','סד','סה','סו','סז','סח','סט','ע',
  'עא','עב','עג','עד','עה','עו','עז','עח','עט','פ',
  'פא','פב','פג','פד','פה','פו','פז','פח','פט','צ',
  'צא','צב','צג','צד','צה','צו','צז','צח','צט','ק',
  'קא','קב','קג','קד','קה','קו','קז','קח','קט','קי',
  'קיא','קיב','קיג','קיד','קטו','קטז','קיז','קיח','קיט','קכ',
  'קכא','קכב','קכג','קכד','קכה','קכו','קכז','קכח','קכט','קל',
  'קלא','קלב','קלג','קלד','קלה','קלו','קלז','קלח','קלט','קמ',
  'קמא','קמב','קמג','קמד','קמה','קמו','קמז','קמח','קמט','קנ',
  'קנא','קנב','קנג','קנד','קנה','קנו','קנז','קנח','קנט','קס',
  'קסא','קסב','קסג','קסד','קסה','קסו','קסז','קסח','קסט','קע',
  'קעא','קעב','קעג','קעד','קעה','קעו'];

export function dafToHebrew(daf) {
  return HE_DIGITS[daf] ?? String(daf);
}

// Standard talmud reference notation: "ה." for amud aleph, "ה:" for amud beis
export function dafLabel(daf, amud) {
  return `${dafToHebrew(daf)}${amud === 'a' ? '.' : ':'}`;
}

export function locationLabel(tractate, daf, amud) {
  return `${tractate.he} ${dafLabel(daf, amud)}`;
}

// Sedarim grouping for the picker. Slugs listed in their canonical seder order
// (matching the order they appear in TRACTATES above).
export const SEDARIM = [
  { he: 'זרעים',  en: 'Zeraim',   slugs: ['berachos'] },
  { he: 'מועד',   en: 'Moed',     slugs: ['shabbos','eruvin','pesachim','shekalim','yoma','sukkah','beitzah','rosh-hashanah','taanis','megillah','moed-katan','chagigah'] },
  { he: 'נשים',   en: 'Nashim',   slugs: ['yevamos','kesuvos','nedarim','nazir','sotah','gittin','kiddushin'] },
  { he: 'נזיקין', en: 'Nezikin',  slugs: ['bava-kamma','bava-metziah','bava-basra','sanhedrin','makkos','shevuos','avodah-zarah','horayos'] },
  { he: 'קדשים',  en: 'Kodashim', slugs: ['zevachim','menachos','chullin','bechoros','arachin','temurah','kereisos','meilah'] },
  { he: 'טהרות',  en: 'Tahoros',  slugs: ['niddah'] },
];

export function apiUrl(tractate, daf, amud) {
  return `/shas-api/?masechta=${tractate.slug}&daf=${daf}&amud=${amud}`;
}
