// =====================================================================
//  TOLYQ / UI — РАЗБОР И ОБЪЯСНЕНИЕ
// ---------------------------------------------------------------------
//  Адаптер, а не реализация. Порядок такой:
//
//    1) пробуем ../core/explain.js — файл разработчика B;
//    2) если его нет или он молчит дольше таймаута — работаем на шаблонах.
//
//  UI зовёт только этот модуль и никогда не знает, кто ответил. Когда B
//  положит свой explain.js, он подхватится сам, править здесь нечего.
//
//  Ожидаемый контракт ../core/explain.js:
//    parseRequest(text)              -> частичный ShipmentRequest | null
//    explainSolution(solution, req)  -> string | { text, paragraphs }
//    getModelInfo()                  -> { text } | { observations, corridors }
//  Любая из трёх может быть асинхронной.
// =====================================================================

import { NODES, CARGO_TYPES } from '../core/types.js';
import * as fmt from './format.js';

const TIMEOUT_MS = 4000;

let engine = null;          // модуль движка, если он есть
let engineChecked = false;
let lastSource = 'template';

async function core() {
  if (engineChecked) return engine;
  engineChecked = true;
  try {
    const mod = await import('../core/explain.js');
    engine = (mod && typeof mod.parseRequest === 'function') ? mod : null;
  } catch {
    engine = null;          // файла ещё нет — это нормальный рабочий режим
  }
  return engine;
}

/** Движок может ходить в сеть. Интерфейс ждать не обязан. */
function withTimeout(promise, ms = TIMEOUT_MS) {
  return Promise.race([
    Promise.resolve(promise),
    new Promise(res => setTimeout(() => res(undefined), ms)),
  ]);
}

/** Кто ответил в прошлый раз: 'engine' или 'template'. */
export function source() { return lastSource; }

// ---------------------------------------------------------------------
//  1. РАЗБОР СВОБОДНОГО ВВОДА
// ---------------------------------------------------------------------
export async function parseRequest(text) {
  const raw = String(text || '').trim();
  if (raw.length < 4) return null;

  const mod = await core();
  if (mod) {
    try {
      const res = await withTimeout(mod.parseRequest(raw));
      if (res && typeof res === 'object' && Object.keys(res).length) {
        lastSource = 'engine';
        return res;
      }
    } catch { /* падаем на шаблон */ }
  }
  lastSource = 'template';
  return parseByRules(raw);
}

/** Разбор правилами. Работает без сети — на защите это важнее точности. */
function parseByRules(text) {
  const s = ' ' + text.toLowerCase().replace(/ /g, ' ') + ' ';
  const out = {};

  // --- города: ищем по основе слова, чтобы ловить падежи --------------
  //  Предлог обязан начинаться с границы слова. Без этого «зерна Костанай»
  //  даёт предлог «на» — хвост предыдущего слова — и город уезжает в пункт
  //  назначения вместо отправления.
  const hits = [];
  for (const n of NODES) {
    const stem = n.name.toLowerCase().slice(0, Math.max(4, n.name.length - 2));
    const re = new RegExp('(?:(?:^|[^а-яё])(из|от|с|в|во|до|на|по)\\s+)?' + escape(stem) + '\\p{L}{0,3}', 'giu');
    let m;
    while ((m = re.exec(s)) !== null) {
      hits.push({ id: n.id, at: m.index, prep: (m[1] || '').trim() });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  hits.sort((a, b) => a.at - b.at);

  const fromHit = hits.find(h => h.prep === 'из' || h.prep === 'от' || h.prep === 'с');
  const toHit   = hits.find(h => (h.prep === 'в' || h.prep === 'во' || h.prep === 'до' || h.prep === 'на') && h.id !== fromHit?.id);
  if (fromHit) out.from = fromHit.id;
  if (toHit)   out.to   = toHit.id;
  // без предлогов: первый упомянутый — откуда, второй — куда
  if (!out.from && !out.to && hits.length >= 2 && hits[0].id !== hits[1].id) {
    out.from = hits[0].id;
    out.to   = hits[1].id;
  }
  if (out.from && out.from === out.to) delete out.to;

  // --- масса ----------------------------------------------------------
  //  Границу слова тут пишем как «дальше не кириллическая буква»: \b в
  //  JavaScript знает только латиницу, и «5 т» после неё не находится,
  //  хотя «5 тонн» находится. Ровно та же ловушка ниже с часами.
  const tons = s.match(/(\d+(?:[.,]\d+)?)\s*(?:тонн\w*|тн(?![а-яё])|т(?![а-яё]))/);
  if (tons) out.tons = clamp(numeric(tons[1]), 0.5, 68);
  else {
    const kg = s.match(/(\d+(?:[.,]\d+)?)\s*(?:кг|килограмм\w*)/);
    if (kg) out.tons = clamp(numeric(kg[1]) / 1000, 0.5, 68);
  }

  // --- объём ----------------------------------------------------------
  const vol = s.match(/(\d+(?:[.,]\d+)?)\s*(?:м3|м³|куб\w*)/);
  if (vol) out.volumeM3 = clamp(numeric(vol[1]), 1, 138);

  // --- срок -----------------------------------------------------------
  const deadline = parseDeadline(s);
  if (deadline) out.deadlineH = clamp(deadline, 6, 240);

  // --- тип груза ------------------------------------------------------
  if (/хим\w*|кислот\w*|удобрен\w*|реагент\w*|растворител\w*|опасн\w*/.test(s)) out.cargoType = 'chemical';
  else if (/продукт\w*|пищев\w*|еда|едой|молок\w*|молочн\w*|зерн\w*|мук[аи]|овощ\w*|фрукт\w*|мяс\w*|напитк\w*/.test(s)) out.cargoType = 'food';
  else if (/груз\w*|товар\w*|паллет\w*|коробк\w*|оборудован\w*|запчаст\w*|металл\w*|стройматериал\w*/.test(s)) out.cargoType = 'general';

  // --- приоритеты по интонации ---------------------------------------
  const urgent = /срочн\w*|скорее|быстрее|как можно быстр\w*|горит|вчера надо/.test(s);
  const cheap  = /дешев\w*|подешевле|экономн\w*|бюджет\w*|сэконом\w*/.test(s);
  const green  = /эколог\w*|зелён\w*|зелен\w*|выброс\w*|углеродн\w*|co2|со2/.test(s);
  if (urgent || cheap || green) {
    out.weights = urgent && !cheap ? { cost: 0.2, time: 0.65, co2: 0.15 }
                : cheap  && !urgent ? { cost: 0.7, time: 0.15, co2: 0.15 }
                : green  ? { cost: 0.3, time: 0.2, co2: 0.5 }
                : { cost: 0.4, time: 0.4, co2: 0.2 };
    if (green && !urgent && !cheap) out.weights = { cost: 0.3, time: 0.2, co2: 0.5 };
  }

  return Object.keys(out).length ? out : null;
}

const WORD_COUNT = {
  'сутки': 1, 'сутак': 1, 'день': 1, 'дня': 1, 'дней': 1,
  'двое': 2, 'два': 2, 'две': 2, 'трое': 3, 'три': 3,
  'четверо': 4, 'четыре': 4, 'пятеро': 5, 'пять': 5, 'неделю': 7, 'неделя': 7,
};

function parseDeadline(s) {
  // «за 36 часов», «36 ч»
  const h = s.match(/(\d+)\s*(?:час\w*|ч(?![а-яё]))/);
  if (h) return Number(h[1]);

  // «за 3 дня», «за 2 суток»
  const d = s.match(/(\d+)\s*(?:сут\w*|дн\w*|день)/);
  if (d) return Number(d[1]) * 24;

  // «за двое суток», «за неделю»
  const w = s.match(/(двое|трое|четверо|пятеро|два|две|три|четыре|пять|сутки|день|неделю|неделя)\s*(?:сут\w*|дн\w*|день)?/);
  if (w && WORD_COUNT[w[1]]) return WORD_COUNT[w[1]] * 24;

  return null;
}

const numeric = v => parseFloat(String(v).replace(',', '.'));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------------------------------------------------------------------
//  2. «ПОЧЕМУ ТАК»
// ---------------------------------------------------------------------
/** @returns {Promise<{paragraphs: string[], source: 'engine'|'template'}>} */
export async function explainSolution(solution, request) {
  const mod = await core();
  if (mod && typeof mod.explainSolution === 'function') {
    try {
      const res = await withTimeout(mod.explainSolution(solution, request));
      const text = typeof res === 'string' ? res : res?.text;
      const paras = res?.paragraphs || (text ? String(text).split(/\n{2,}/) : null);
      if (paras && paras.length && paras[0].trim()) {
        lastSource = 'engine';
        return { paragraphs: paras.map(p => p.trim()).filter(Boolean), source: 'engine' };
      }
    } catch { /* падаем на шаблон */ }
  }
  lastSource = 'template';
  return { paragraphs: explainByTemplate(solution, request), source: 'template' };
}

/**
 * Шаблонный разбор. Собран из чисел самого решения, поэтому он конкретен:
 * ни одной фразы, которая подошла бы к любому другому расчёту.
 */
function explainByTemplate(sol, req) {
  const rec  = sol.recommended;
  const base = sol.truckBaseline;
  const out = [];

  const from = nameOf(req.from), to = nameOf(req.to);

  // 1. В чём собственно потеря
  if (base.fillMassPct != null) {
    const volPart = base.fillVolPct != null && base.fillVolPct !== base.fillMassPct
      ? ` и ${fmt.pct(base.fillVolPct)} по объёму` : '';
    out.push(
      `Ваши <b>${fmt.tons(req.tons, req.tons % 1 ? 1 : 0)}</b> — это ${fmt.pct(base.fillMassPct)} кузова фуры по массе${volPart}. ` +
      `Счёт всё равно выставят за весь рейс ${from} — ${to}: <b>${fmt.kzt(base.costKzt)}</b>. ` +
      `Остальное вы оплачиваете воздухом.`);
  }

  // 2. Что предлагается взамен
  if (rec.id !== base.id) {
    const share = rec.fillPct
      ? `Вагон уходит заполненным на ${fmt.pct(rec.fillPct)}, и ваша доля в его тарифе — `
      : 'Ваша доля в тарифе — ';
    out.push(
      `<b>${rec.label}</b> идёт ${fmt.hoursShort(rec.hours)} по маршруту ${pathText(rec)}. ` +
      share + `<b>${fmt.kzt(rec.costKzt)}</b>. ` +
      `Разница — ${fmt.kzt(sol.savingKzt)} и ${fmt.co2(sol.savingCo2Kg)} несожжённого топлива.`);
  } else {
    out.push(
      `Срок ${fmt.hoursShort(req.deadlineH)} слишком жёсткий: железнодорожные варианты в него не укладываются, ` +
      `и выделенная фура остаётся единственным проходящим решением. ` +
      `Добавьте сутки — появится сборный вагон и с ним экономия.`);
  }

  // 3. Почему именно эта точка фронта, а не соседняя
  const feasible = sol.pareto.filter(r => r.feasible);
  const rival = nearestRival(sol, rec);
  const w = req.weights || { cost: .5, time: .3, co2: .2 };
  const weightsText = `деньги ${Math.round(w.cost * 100)} %, время ${Math.round(w.time * 100)} %, экология ${Math.round(w.co2 * 100)} %`;

  if (rival) {
    const dt = Math.abs(rival.hours - rec.hours);
    const dc = Math.abs(rival.costKzt - rec.costKzt);
    const faster = rival.hours < rec.hours;
    out.push(
      `При ваших приоритетах — ${weightsText} — из ${countText(feasible.length)} ` +
      `лучший балл у этого варианта. Ближайший соперник, «${rival.label}», ` +
      `${faster ? 'приходит на ' + fmt.hoursShort(dt) + ' раньше, но стоит на ' + fmt.kzt(dc) + ' дороже'
                : 'дешевле на ' + fmt.kzt(dc) + ', но опаздывает на ' + fmt.hoursShort(dt)}.`);
  } else {
    out.push(`При ваших приоритетах — ${weightsText} — из ${countText(feasible.length)} это единственный разумный выбор.`);
  }

  return out;
}

function nearestRival(sol, rec) {
  const others = sol.pareto.filter(r => r.id !== rec.id && r.feasible);
  if (!others.length) return null;
  return others.reduce((best, r) =>
    Math.abs(r.hours - rec.hours) < Math.abs(best.hours - rec.hours) ? r : best);
}

function countText(n) {
  return `${n} ${fmt.plural(n, 'маршрута', 'маршрутов', 'маршрутов')}, укладывающихся в срок,`
    .replace('1 маршрута', '1 маршрута');
}

function pathText(route) {
  return (route.path || []).map(nameOf).join(' — ');
}

const nameOf = id => NODES.find(n => n.id === id)?.name || id;

// ---------------------------------------------------------------------
//  3. СТАТУС МОДЕЛИ
// ---------------------------------------------------------------------
/** @returns {Promise<{text: string, live: boolean}>} */
export async function getModelInfo() {
  // Сначала explain.js движка, если он это умеет...
  const mod = await core();
  if (mod && typeof mod.getModelInfo === 'function') {
    const info = await tryInfo(() => mod.getModelInfo());
    if (info) return info;
  }

  // ...потом сам движок: показатели обученной модели он держит в solve.js
  // под именем modelInfo. Форма совпадает, переименования достаточно.
  const info = await tryInfo(async () => {
    const solve = await import('../core/solve.js');
    return typeof solve.modelInfo === 'function' ? solve.modelInfo() : solve.modelInfo;
  });
  if (info) return info;

  // Движка нет вовсе — показываем демонстрационные числа, индикатор серый.
  return { text: composeModelText(DEMO_MODEL), live: false };
}

async function tryInfo(get) {
  try {
    const info = await withTimeout(get(), 2000);
    if (!info) return null;
    const text = info.text || composeModelText(info);
    return text ? { text, live: true } : null;
  } catch {
    return null;
  }
}

const DEMO_MODEL = { observations: 4320, corridors: 12 };

function composeModelText(info) {
  const parts = [];
  if (info.observations != null) {
    parts.push(`обучена на ${fmt.num(info.observations)} ${fmt.plural(info.observations, 'наблюдении', 'наблюдениях', 'наблюдениях')}`);
  }
  if (info.corridors != null) {
    parts.push(`по ${fmt.num(info.corridors)} ${fmt.plural(info.corridors, 'коридору', 'коридорам', 'коридорам')}`);
  }
  if (!parts.length) return '';
  return 'Модель ' + parts.join(' ');
}
