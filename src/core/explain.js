// =====================================================================
//  TOLYQ — ОПЦИОНАЛЬНЫЙ СЛОЙ LLM
// ---------------------------------------------------------------------
//  Два удобства поверх движка:
//    parseRequest(text)      — свободный текст в ShipmentRequest;
//    explainSolution(sol)    — два-три предложения, почему рекомендован
//                              именно этот вариант.
//
//  ГЛАВНОЕ ПРАВИЛО МОДУЛЯ: продукт работает оффлайн ВСЕГДА.
//  Нет ключа, нет сети, ключ протух, ответ — мусор, таймаут — движок
//  не должен этого заметить. Поэтому:
//    * у обеих функций есть СИНХРОННЫЙ откат без единого сетевого вызова;
//    * parseRequestOffline() — разбор регулярными выражениями, он же
//      база: результат LLM всегда проходит через ту же валидацию;
//    * explainOffline() — шаблонная фраза из чисел solution;
//    * ни одно исключение из сети наружу не выходит.
//
//  Ключ живёт в localStorage под ключом TOLYQ_LLM_KEY и в репозиторий
//  не попадает. Если localStorage недоступен (файловый протокол,
//  приватный режим) — молча работаем оффлайн.
// =====================================================================

import { NODES, CARGO_TYPES } from './types.js';
import { m3PerTon } from './network.js';

/** Имя ключа в localStorage. Значение в репозиторий не коммитится. */
export const LLM_KEY_NAME = 'TOLYQ_LLM_KEY';
/** Таймаут сетевого вызова. Дольше ждать нельзя — UI интерактивный. */
export const LLM_TIMEOUT_MS = 6000;
const LLM_MODEL = 'claude-sonnet-4-5';
const LLM_URL = 'https://api.anthropic.com/v1/messages';

// ---------------------------------------------------------------------
//  ДОСТУП К КЛЮЧУ
// ---------------------------------------------------------------------

/** Ключ из localStorage либо null. Любая ошибка доступа — это null. */
export function getApiKey() {
  try {
    if (typeof localStorage === 'undefined') return null;
    const v = localStorage.getItem(LLM_KEY_NAME);
    return v && v.trim() ? v.trim() : null;
  } catch {
    return null; // приватный режим, file://, запрет политикой — не наша беда
  }
}

/** Доступен ли слой LLM. UI прячет по этому флагу соответствующие элементы. */
export function isLlmAvailable() {
  return getApiKey() !== null && typeof fetch === 'function';
}

// ---------------------------------------------------------------------
//  СЛОВАРИ ДЛЯ ОФФЛАЙН-РАЗБОРА
// ---------------------------------------------------------------------

/**
 * Города в косвенных падежах. Разбираем «из Астаны в Алматы», поэтому
 * нужны родительный и винительный, а не только именительный.
 * Сопоставление идёт по основе: «астан» покрывает и Астану, и Астаны.
 */
const CITY_STEMS = {
  AST: ['астан', 'нур-султан', 'нурсултан', 'целиноград', 'ast'],
  ALA: ['алмат', 'алма-ат', 'алма ат', 'ala'],
  SHY: ['шымкент', 'чимкент', 'shy'],
  KGF: ['караганд', 'кgf', 'kgf'],
  AKX: ['актюб', 'актобе', 'akx'],
  ATX: ['атырау', 'гурьев', 'atx'],
  KSN: ['костана', 'кустана', 'ksn'],
  PWQ: ['павлодар', 'pwq'],
  DMB: ['тараз', 'джамбул', 'жамбыл', 'dmb'],
  SCO: ['актау', 'sco'],
  KHG: ['хоргос', 'khg'],
  DOS: ['достык', 'дружб', 'dos'],
};

/** Ключевые слова типов груза. Порядок важен: сначала более специфичные. */
const CARGO_STEMS = [
  ['food', ['мук', 'зерн', 'пшениц', 'продукт', '食', '食品', 'консерв', 'сахар', 'масл', 'молок', 'мяс', 'овощ', 'фрукт', 'крупа', 'рис', 'ячмен']],
  ['chemical', ['хими', 'реагент', 'кислот', 'щёлоч', 'щелоч', 'удобрен', 'селитр', 'полимер', 'пластик', 'растворител', 'нефтехим']],
  ['general', ['генеральн', 'сборн', 'оборудован', 'запчаст', 'метиз', 'металл', 'труб', 'стройматериал', 'мебел', 'техник', 'товар']],
];

/** Дни недели для дедлайнов вида «до четверга». */
const WEEKDAYS = [
  ['воскресен', 0], ['понедельник', 1], ['вторник', 2], ['сред', 3],
  ['четверг', 4], ['пятниц', 5], ['суббот', 6],
];

// ---------------------------------------------------------------------
//  ОФФЛАЙН-РАЗБОР
// ---------------------------------------------------------------------

/** Приводит к нижнему регистру и сводит ё к е — иначе «щёлочь» мимо. */
const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е');

// ---------------------------------------------------------------------
//  ГРАНИЦЫ СЛОВ ДЛЯ КИРИЛЛИЦЫ
// ---------------------------------------------------------------------
//  В JavaScript \b определена через \w = [A-Za-z0-9_]: кириллица для неё
//  не буква. Поэтому /\bиз\b/ НЕ находит «из» в русском тексте — движок
//  ищет переход латиница↔не-латиница, которого там нет, и предлог молча
//  не распознаётся. Ошибка тихая: разбор не падает, а возвращает мусор.
//  Границы задаём явными классами символов.
// ---------------------------------------------------------------------

/** Начало слова: начало строки либо не-буква перед ним. */
const BOW = '(?:^|[^а-яa-z])';
/** Конец слова: опережающая проверка на не-букву. */
const EOW = '(?![а-яa-z])';

/**
 * Ищет город по основе. Возвращает { id, at } — позицию вхождения,
 * она нужна, чтобы отличить «из Астаны» от «в Астану» по порядку слов.
 */
function findCities(text) {
  const t = norm(text);
  const hits = [];
  for (const [id, stems] of Object.entries(CITY_STEMS)) {
    let best = -1;
    for (const stem of stems) {
      const at = t.indexOf(norm(stem));
      if (at >= 0 && (best < 0 || at < best)) best = at;
    }
    if (best >= 0) hits.push({ id, at: best });
  }
  return hits.sort((a, b) => a.at - b.at);
}

/**
 * Определяет откуда и куда.
 * Сначала по предлогам «из X» / «в Y» — это надёжно. Если предлоги не
 * распознались, берём порядок упоминания: первый город — отправление.
 */
function resolveRoute(text) {
  const t = norm(text);
  const hits = findCities(t);
  if (hits.length === 0) return { from: null, to: null };

  let from = null;
  let to = null;

  for (const h of hits) {
    // Смотрим до 12 символов перед названием: там стоит предлог
    const before = t.slice(Math.max(0, h.at - 12), h.at);
    if (new RegExp(`${BOW}(?:из|от|с)\\s+\\S*$`).test(before) && !from) from = h.id;
    else if (new RegExp(`${BOW}(?:в|во|до|на)\\s+\\S*$`).test(before) && !to) to = h.id;
  }

  if (!from && !to) {
    from = hits[0].id;
    to = hits[1] ? hits[1].id : null;
  } else if (!from) {
    from = hits.find((h) => h.id !== to)?.id ?? null;
  } else if (!to) {
    to = hits.find((h) => h.id !== from)?.id ?? null;
  }

  return { from, to: from === to ? null : to };
}

/** Масса в тоннах. Понимает «8 тонн», «8,5 т», «12000 кг». */
function resolveTons(text) {
  const t = norm(text);

  const kg = t.match(/(\d+(?:[.,]\d+)?)\s*(?:кг|килограмм)/);
  if (kg) return parseFloat(kg[1].replace(',', '.')) / 1000;

  const tn = t.match(new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*(?:тонн|тн${EOW}|т${EOW})`));
  if (tn) return parseFloat(tn[1].replace(',', '.'));

  return null;
}

/** Тип груза по ключевым словам. */
function resolveCargoType(text) {
  const t = norm(text);
  for (const [type, stems] of CARGO_STEMS) {
    for (const stem of stems) if (t.includes(norm(stem))) return type;
  }
  return null;
}

/**
 * Дедлайн в часах от «сейчас».
 * Понимает «за 3 дня», «до четверга», «через 48 часов», «за неделю».
 * Опорное время передаётся явно — иначе функция недетерминирована
 * и её нельзя протестировать.
 */
function resolveDeadlineH(text, now = new Date()) {
  const t = norm(text);

  const hours = t.match(new RegExp(`(?:за|через|в течение)\\s*(\\d+)\\s*(?:час|ч${EOW})`));
  if (hours) return parseInt(hours[1], 10);

  const days = t.match(/(?:за|через|в течение)\s*(\d+)\s*(?:дн|сут)/);
  if (days) return parseInt(days[1], 10) * 24;

  if (new RegExp(`${BOW}(?:за|через)\\s*недел`).test(t)) return 7 * 24;
  // «послезавтра» проверяем первым: иначе его хвост совпадёт с «завтра»
  if (new RegExp(`${BOW}послезавтра${EOW}`).test(t)) return 48;
  if (new RegExp(`${BOW}завтра${EOW}`).test(t)) return 24;
  if (new RegExp(`${BOW}срочно${EOW}`).test(t)) return 24;

  // «до четверга» — считаем часы до ближайшего такого дня, 18:00
  const dow = t.match(new RegExp(`${BOW}до\\s+(\\S+)`));
  if (dow) {
    const word = norm(dow[1]);
    for (const [stem, idx] of WEEKDAYS) {
      if (word.startsWith(stem.slice(0, 5))) {
        const cur = now.getDay();
        let delta = (idx - cur + 7) % 7;
        if (delta === 0) delta = 7; // «до вторника» во вторник — через неделю
        const target = new Date(now);
        target.setDate(target.getDate() + delta);
        target.setHours(18, 0, 0, 0);
        return Math.max(1, Math.round((target - now) / 3600000));
      }
    }
  }

  return null;
}

/**
 * Оффлайн-разбор свободного текста. Никакой сети.
 *
 * Возвращает ShipmentRequest либо null, если не удалось определить
 * главное — откуда, куда и сколько. Частичный разбор наружу не отдаём:
 * UI лучше показать пустую форму, чем форму с наполовину угаданными
 * полями, которые пользователь не заметит и не исправит.
 *
 * @param {string} text
 * @param {Date} [now] опорное время для относительных сроков
 * @returns {Object|null} ShipmentRequest
 */
export function parseRequestOffline(text, now = new Date()) {
  if (!text || typeof text !== 'string') return null;

  const { from, to } = resolveRoute(text);
  const tons = resolveTons(text);
  if (!from || !to || !tons || !(tons > 0)) return null;

  const cargoType = resolveCargoType(text) || 'general';
  const deadlineH = resolveDeadlineH(text, now) ?? 96;

  return normalizeParsed({ from, to, tons, cargoType, deadlineH }, 'offline');
}

/**
 * Приводит разобранное к валидному ShipmentRequest.
 * Через неё проходит И оффлайн-разбор, И ответ модели: доверять выводу
 * LLM без проверки нельзя — он может вернуть несуществующий город,
 * отрицательный вес или тип груза, которого у нас нет.
 */
function normalizeParsed(raw, source) {
  const ids = new Set(NODES.map((n) => n.id));
  if (!raw || !ids.has(raw.from) || !ids.has(raw.to) || raw.from === raw.to) return null;

  const tons = Number(raw.tons);
  if (!Number.isFinite(tons) || tons <= 0 || tons > 5000) return null;

  const cargoType = Object.keys(CARGO_TYPES).includes(raw.cargoType) ? raw.cargoType : 'general';

  let deadlineH = Number(raw.deadlineH);
  if (!Number.isFinite(deadlineH) || deadlineH <= 0) deadlineH = 96;
  deadlineH = Math.min(deadlineH, 24 * 60);

  return {
    from: raw.from,
    to: raw.to,
    tons: Math.round(tons * 100) / 100,
    volumeM3: Math.round(tons * m3PerTon(cargoType) * 10) / 10,
    cargoType,
    deadlineH: Math.round(deadlineH),
    source, // 'offline' | 'llm' — UI может показать, чем разобрано
  };
}

// ---------------------------------------------------------------------
//  ШАБЛОННОЕ ОБЪЯСНЕНИЕ
// ---------------------------------------------------------------------

const fmtKzt = (v) => Math.round(v).toLocaleString('ru-RU') + ' ₸';
const fmtH = (h) => {
  const d = Math.floor(h / 24);
  const r = Math.round(h % 24);
  return d > 0 ? `${d} сут ${r} ч` : `${Math.round(h)} ч`;
};

/**
 * Объяснение без сети: собирается из чисел solution.
 *
 * Это не запасной вариант «на всякий случай», а основной: именно он
 * работает на защите, если интернета в зале не будет. Слой LLM лишь
 * переписывает то же самое живее.
 *
 * @param {Object} solution
 * @returns {string}
 */
export function explainOffline(solution) {
  if (!solution || !solution.recommended) {
    return 'Маршрут не найден: узлы не связаны в сети. Проверьте пункты отправления и назначения.';
  }

  const r = solution.recommended;
  const base = solution.truckBaseline;
  const st = solution.stopping;
  const parts = [];

  parts.push(
    `Рекомендуем «${r.label}»: ${fmtKzt(r.costKzt)}, ${fmtH(r.hours)}, ${Math.round(r.co2Kg)} кг CO₂.`
  );

  if (base && base.id !== r.id && solution.savingKzt > 0) {
    const pct = Math.round((solution.savingKzt / base.costKzt) * 100);
    parts.push(
      `Против фуры за ${fmtKzt(base.costKzt)} это экономит ${fmtKzt(solution.savingKzt)} (${pct}%) и ${Math.round(solution.savingCo2Kg)} кг выбросов.`
    );
  }

  if (st && !st.degenerate && st.horizonH > 0) {
    parts.push(
      `Отправлять выгоднее на ${st.dispatchAtH}-м часу: к этому моменту в вагоне ожидается ${st.expectedFillT} т, и ваша доля тарифа падает до ${fmtKzt(st.expectedValueKzt)}.`
    );
  } else if (st && st.degenerate && st.reason) {
    parts.push(`Ждать попутный груз смысла нет: ${st.reason}.`);
  }

  if (!r.feasible) {
    parts.push('Внимание: в заявленный срок не укладывается ни один вариант.');
  }

  return parts.join(' ');
}

// ---------------------------------------------------------------------
//  СЕТЕВОЙ СЛОЙ
// ---------------------------------------------------------------------

/**
 * Один запрос к модели с жёстким таймаутом.
 * Любая неудача — это null, наружу исключения не летят.
 */
async function callLlm(system, user, maxTokens = 400) {
  const key = getApiKey();
  if (!key || typeof fetch !== 'function') return null;

  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), LLM_TIMEOUT_MS) : null;

  try {
    const res = await fetch(LLM_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        // Ключ пользователя, вызов из браузера — иначе API отклонит запрос
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
      }),
      signal: ctrl ? ctrl.signal : undefined,
    });

    if (!res.ok) return null;
    const data = await res.json();
    const text = data?.content?.[0]?.text;
    return typeof text === 'string' && text.trim() ? text.trim() : null;
  } catch {
    return null; // нет сети, таймаут, отказ CORS, протухший ключ — всё сюда
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Достаёт первый JSON-объект из ответа: модель любит обрамлять его текстом. */
function extractJson(text) {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------
//  ПУБЛИЧНОЕ API
// ---------------------------------------------------------------------

const NODE_LIST = NODES.map((n) => `${n.id} — ${n.name}`).join(', ');

const PARSE_SYSTEM = `Ты разбираешь заявки на грузоперевозку по Казахстану.
Верни ТОЛЬКО JSON без пояснений, в формате:
{"from":"<id>","to":"<id>","tons":<число>,"cargoType":"food|general|chemical","deadlineH":<целое>}
Допустимые id узлов: ${NODE_LIST}.
tons — масса в тоннах. deadlineH — срок доставки в часах от текущего момента.
Если чего-то в тексте нет: cargoType = "general", deadlineH = 96.
Если непонятно откуда или куда везти или сколько тонн — верни {"error":true}.`;

/**
 * Разбор свободного текста в ShipmentRequest.
 *
 * Порядок: сначала оффлайн-разбор, он бесплатный и мгновенный. Если он
 * справился — сеть не трогаем вовсе. Если нет и ключ есть — пробуем LLM,
 * а его ответ прогоняем через ту же валидацию.
 *
 * @param {string} text
 * @param {Object} [opts] { now, forceLlm }
 * @returns {Promise<Object|null>} ShipmentRequest либо null
 */
export async function parseRequest(text, opts = {}) {
  const now = opts.now || new Date();

  const offline = parseRequestOffline(text, now);
  if (offline && !opts.forceLlm) return offline;

  if (!isLlmAvailable()) return offline; // null или частичный оффлайн-результат

  const raw = await callLlm(PARSE_SYSTEM, String(text || '').slice(0, 2000), 300);
  const parsed = extractJson(raw);
  if (!parsed || parsed.error) return offline;

  return normalizeParsed(parsed, 'llm') || offline;
}

/**
 * Синхронный разбор — для случаев, когда ждать нельзя вовсе.
 * Всегда доступен, сети не касается.
 */
export function parseRequestSync(text, now = new Date()) {
  return parseRequestOffline(text, now);
}

const EXPLAIN_SYSTEM = `Ты объясняешь грузоотправителю в Казахстане, почему система
рекомендовала именно этот вариант перевозки. Пиши по-русски, два-три предложения,
деловым тоном без восклицаний и без маркетинга.
Опирайся ТОЛЬКО на переданные числа, ничего не добавляй от себя и не округляй
в выгодную сторону. Валюта — тенге.`;

/**
 * Живое объяснение решения.
 *
 * Всегда возвращает строку. Если LLM недоступна или ответила плохо —
 * возвращает шаблонное объяснение, и вызывающий не обязан это различать.
 *
 * @param {Object} solution ответ solve()
 * @returns {Promise<string>}
 */
export async function explainSolution(solution) {
  const fallback = explainOffline(solution);
  if (!isLlmAvailable() || !solution || !solution.recommended) return fallback;

  const facts = compactFacts(solution);
  const raw = await callLlm(EXPLAIN_SYSTEM, JSON.stringify(facts), 400);
  if (!raw) return fallback;

  // Отсекаем явно испорченный ответ: слишком короткий, слишком длинный
  // или не на кириллице. Лучше шаблон, чем мусор на экране защиты.
  const clean = raw.replace(/\s+/g, ' ').trim();
  if (clean.length < 40 || clean.length > 1200) return fallback;
  if (!/[а-я]/i.test(clean)) return fallback;

  return clean;
}

/** Синхронное объяснение. Идентично откату explainSolution(). */
export function explainSolutionSync(solution) {
  return explainOffline(solution);
}

/**
 * Сжимает solution до чисел, которые нужны для объяснения.
 * Отправляем в модель только это: во-первых, полный ответ движка
 * не влезет в разумный запрос, во-вторых, лишние поля модель начинает
 * пересказывать вместо объяснения.
 */
function compactFacts(s) {
  const r = s.recommended;
  const b = s.truckBaseline;
  const st = s.stopping;
  return {
    рекомендация: {
      маршрут: r.label,
      стоимость_тенге: r.costKzt,
      часов: r.hours,
      co2_кг: r.co2Kg,
      загрузка_процентов: r.fillPct,
      успевает_в_срок: r.feasible,
    },
    фура_сегодня: b
      ? { стоимость_тенге: b.costKzt, часов: b.hours, co2_кг: b.co2Kg }
      : null,
    экономия: { тенге: s.savingKzt, co2_кг: s.savingCo2Kg },
    когда_отправлять: st && !st.degenerate
      ? {
          час_отправки: st.dispatchAtH,
          ожидаемая_загрузка_т: st.expectedFillT,
          ожидаемая_стоимость_тенге: st.expectedValueKzt,
          вероятность_собрать_вагон: st.probability,
        }
      : null,
    вариантов_во_фронте: s.pareto.length,
    отброшено_вариантов: s.dominated.length,
  };
}
