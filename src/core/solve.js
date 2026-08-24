// =====================================================================
//  TOLYQ — ОРКЕСТРАЦИЯ. ПУБЛИЧНЫЙ API ДВИЖКА
// ---------------------------------------------------------------------
//  Единственный модуль, который импортирует UI. Всё остальное — внутренности.
//
//  СЛОЙ 1 (текущий): маршрутизация по Парето, автомобильная база,
//  выбор по весам, объяснение. Политика остановки и упаковка отдаются
//  в вырожденной, но ЧЕСТНОЙ форме: горизонт ожидания равен нулю,
//  то есть «отправить немедленно, попутного груза не ждём».
//  Это корректный ответ при отсутствии модели потока, а не заглушка
//  с выдуманными числами. Слой 2 заменяет их полноценным ДП.
// =====================================================================

import { paretoRoutes, pickByWeights, wagonShare, wagonsNeeded } from './pareto.js';
import { getNetwork, WAGON_CAP_T, ASSUMED_WAGON_FILL_T } from './network.js';
import { trucksNeeded } from './co2.js';

export { getNetwork } from './network.js';

// ---------------------------------------------------------------------
//  НОРМАЛИЗАЦИЯ ЗАЯВКИ
// ---------------------------------------------------------------------

/**
 * Приводит вход от UI к внутреннему виду и подставляет разумные умолчания.
 * UI — источник недоверенных данных: ползунки, поля ввода, чужие моки.
 * Всё, что пришло оттуда, здесь зажимается в допустимые границы.
 */
function normalizeRequest(raw = {}) {
  const tons = clamp(num(raw.tons, 8), 0, 5000);
  return {
    from: String(raw.from || 'AST'),
    to: String(raw.to || 'ALA'),
    tons,
    // Если объём не задан — оцениваем по типовой плотности генгруза 6.5 м³/т
    volumeM3: clamp(num(raw.volumeM3, tons * 6.5), 0, 40000),
    cargoType: ['food', 'general', 'chemical'].includes(raw.cargoType) ? raw.cargoType : 'general',
    deadlineH: clamp(num(raw.deadlineH, 96), 1, 24 * 60),
    weights: {
      cost: clamp(num(raw.weights?.cost, 1 / 3), 0, 1),
      time: clamp(num(raw.weights?.time, 1 / 3), 0, 1),
      co2: clamp(num(raw.weights?.co2, 1 / 3), 0, 1),
    },
    assumedWagonFillT: clamp(num(raw.assumedWagonFillT, ASSUMED_WAGON_FILL_T), 1, WAGON_CAP_T),
    seed: raw.seed ?? 'tolyq',
  };
}

const num = (v, def) => (typeof v === 'number' && Number.isFinite(v) ? v : def);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---------------------------------------------------------------------
//  БАЗА СРАВНЕНИЯ: «КАК ВОЗЯТ СЕГОДНЯ»
// ---------------------------------------------------------------------

/**
 * Автомобильный вариант — то, что отправитель делает по умолчанию:
 * берёт фуру и едет. Самый дешёвый чисто автомобильный маршрут.
 * Может отсутствовать: к Достыку автодороги нет.
 */
function findTruckBaseline(all) {
  const roadOnly = all.filter((r) => r.legs.length > 0 && r.legs.every((l) => l.mode === 'road'));
  if (roadOnly.length === 0) return null;
  return roadOnly.reduce((a, b) => (a.costKzt <= b.costKzt ? a : b));
}

// ---------------------------------------------------------------------
//  ОБЪЯСНЕНИЕ ПО-РУССКИ
// ---------------------------------------------------------------------

const fmtKzt = (v) => Math.round(v).toLocaleString('ru-RU') + ' ₸';
const fmtH = (h) => {
  const d = Math.floor(h / 24);
  const r = Math.round(h % 24);
  return d > 0 ? `${d} сут ${r} ч` : `${Math.round(h)} ч`;
};
const fmtKg = (v) => `${Math.round(v)} кг`;

/**
 * Собирает человеческую фразу из чисел. Никаких оценочных прилагательных,
 * которые не подкреплены расчётом: каждое утверждение — из результата.
 */
function buildExplanation({ req, rec, baseline, savingKzt, savingCo2Kg }) {
  if (!rec) {
    return `Маршрут ${req.from} → ${req.to} не найден: узлы не связаны в сети. Проверьте пункты отправления и назначения.`;
  }

  const parts = [];
  parts.push(
    `Партия ${round1(req.tons)} т, ${req.from} → ${req.to}. Рекомендуем: ${rec.label} — ${fmtKzt(rec.costKzt)}, ${fmtH(rec.hours)}, ${fmtKg(rec.co2Kg)} CO₂.`
  );

  if (!rec.feasible) {
    parts.push(
      `Внимание: в дедлайн ${fmtH(req.deadlineH)} не укладывается ни один вариант — быстрейший идёт ${fmtH(rec.hours)}. Показываем ближайшее возможное.`
    );
  }

  if (baseline && baseline.id !== rec.id) {
    const pct = baseline.costKzt > 0 ? Math.round((savingKzt / baseline.costKzt) * 100) : 0;
    if (savingKzt > 0) {
      parts.push(
        `Против привычной фуры (${fmtKzt(baseline.costKzt)}, ${fmtH(baseline.hours)}) экономия ${fmtKzt(savingKzt)} — это ${pct}% — и ${fmtKg(savingCo2Kg)} CO₂.`
      );
    } else {
      parts.push(
        `Фура обошлась бы в ${fmtKzt(baseline.costKzt)} за ${fmtH(baseline.hours)}: по деньгам она здесь не хуже, выигрыш только по срокам.`
      );
    }
  }

  const hasRail = rec.legs.some((l) => l.mode === 'rail');
  if (hasRail && wagonsNeeded(req.tons, req.volumeM3) === 1) {
    parts.push(
      `Цена посчитана как доля вагона при загрузке ${round1(req.assumedWagonFillT)} т из ${WAGON_CAP_T}. В одиночку тот же вагон стоил бы ${fmtKzt(rec.costSoloKzt)}.`
    );
  }

  return parts.join(' ');
}

const round1 = (x) => Math.round(x * 10) / 10;

// ---------------------------------------------------------------------
//  ВЫРОЖДЕННЫЕ ПОЛИТИКА И УПАКОВКА (СЛОЙ 1)
// ---------------------------------------------------------------------

/**
 * Политика при нулевом горизонте ожидания: отправляем сейчас.
 * Порог равен нашему тоннажу — «накопленного уже достаточно, ждать негде».
 * Формально корректно для модели без потока попутных заявок.
 * СЛОЙ 2 заменит на ДП по market.js.
 */
function immediateStopping(req, railHours) {
  return {
    thresholdByHour: [req.tons],
    expectedValueKzt: 0,
    dispatchAtH: 0,
    probability: 0,
    horizonH: 0,
    method: 'слой 1: без модели потока, отправка немедленно',
  };
}

/**
 * Упаковка, когда попутных заявок ещё не смоделировано: в вагоне только мы.
 * СЛОЙ 3 заменит на отжиг по потоку из market.js.
 */
function soloPacking(req) {
  const fill = Math.min(1, req.tons / WAGON_CAP_T);
  return {
    accepted: [],
    rejected: [],
    tonsTotal: req.tons,
    fillPct: Math.round(fill * 1000) / 10,
    baselineFillPct: Math.round(fill * 1000) / 10,
    iterations: 0,
    method: 'слой 1: только собственный груз',
  };
}

// ---------------------------------------------------------------------
//  ГЛАВНАЯ ФУНКЦИЯ
// ---------------------------------------------------------------------

/**
 * Полное решение по заявке.
 * @param {Object} rawRequest ShipmentRequest из types.js
 * @returns {Object} Solution из types.js
 */
export function solve(rawRequest) {
  const req = normalizeRequest(rawRequest);

  const { pareto, dominated, stats } = paretoRoutes(req.from, req.to, req);

  // Сеть не связывает эти узлы — отдаём валидный пустой ответ, не бросаем.
  if (pareto.length === 0) {
    return {
      pareto: [],
      dominated: [],
      truckBaseline: null,
      recommended: null,
      stopping: immediateStopping(req, 0),
      packing: soloPacking(req),
      savingKzt: 0,
      savingCo2Kg: 0,
      explanation: buildExplanation({ req, rec: null }),
      request: req,
      stats,
    };
  }

  const truckBaseline = findTruckBaseline(pareto.concat(dominated));

  // Выбираем из укладывающихся в дедлайн; если таких нет — из всего фронта,
  // но флаг feasible остаётся false и объяснение об этом скажет.
  const feasible = pareto.filter((r) => r.feasible);
  const recommended = pickByWeights(feasible.length ? feasible : pareto, req.weights);

  const savingKzt = truckBaseline ? truckBaseline.costKzt - recommended.costKzt : 0;
  const savingCo2Kg = truckBaseline
    ? Math.round((truckBaseline.co2Kg - recommended.co2Kg) * 10) / 10
    : 0;

  const railHours = recommended.legs
    .filter((l) => l.mode === 'rail')
    .reduce((s, l) => s + l.hours, 0);

  return {
    pareto,
    dominated,
    truckBaseline,
    recommended,
    stopping: immediateStopping(req, railHours),
    packing: soloPacking(req),
    savingKzt,
    savingCo2Kg,
    explanation: buildExplanation({ req, rec: recommended, baseline: truckBaseline, savingKzt, savingCo2Kg }),
    request: req, // нормализованная заявка — UI полезно видеть, что реально считали
    stats,
  };
}
