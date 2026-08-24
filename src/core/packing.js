// =====================================================================
//  TOLYQ — УПАКОВКА ВАГОНА
// ---------------------------------------------------------------------
//  Задача: из потока попутных заявок выбрать подмножество, которое
//  максимально загружает вагон, не нарушая ограничений.
//
//  Это задача о рюкзаке с двумя ресурсами (масса и объём) плюс
//  ограничение совместимости — NP-трудная. Точного решения не ищем,
//  ищем хорошее и быстро.
//
//  ДВЕ РЕАЛИЗАЦИИ, и обе нужны:
//    FFD (first-fit decreasing) — жадная база. Быстрая, детерминированная,
//        понятная. Даёт нижнюю границу качества.
//    ИМИТАЦИЯ ОТЖИГА — стартует от решения FFD и улучшает его.
//        Отжиг НИКОГДА не хуже базы, потому что мы явно храним лучшее
//        встреченное решение и стартуем от жадного.
//
//  Разница `fillPct − baselineFillPct` — то самое «отжиг дал +N
//  процентных пунктов». Оба числа мерят ТОННАЖ — ровно ту величину,
//  которую отжиг максимизирует. Сравнивать его результат в другой мере
//  (например, в занятости по объёму) было бы подтасовкой в обе стороны:
//  там отжиг может и проиграть, ничего при этом не ухудшив.
// =====================================================================

import { makeRng } from './random.js';
import { WAGON_CAP_T, WAGON_CAP_M3 } from './network.js';

// ---------------------------------------------------------------------
//  ПАРАМЕТРЫ ОТЖИГА
// ---------------------------------------------------------------------
/** Итераций отжига. 4000 — середина заявленного диапазона 3000–5000. */
export const ANNEAL_ITERATIONS = 4000;
/**
 * Начальная температура в тоннах: при ней ухудшение на тонну
 * принимается с вероятностью e^(−1) ≈ 0,37. Масштаб выбран по величине
 * целевой функции, а не «на глаз»: температура должна быть соизмерима
 * с типичным изменением загрузки от одного хода, то есть с размером
 * партии (медиана 9 т).
 */
export const T_START = 9;
/** Конечная температура: 0,05 т — ходы, ухудшающие результат, уже не проходят. */
export const T_END = 0.05;

// ---------------------------------------------------------------------
//  ОГРАНИЧЕНИЯ
// ---------------------------------------------------------------------

/**
 * Химия не едет вместе с продуктами.
 * Отношение симметрично и не транзитивно: general совместим с обоими.
 */
export function incompatible(typeA, typeB) {
  return (
    (typeA === 'chemical' && typeB === 'food') ||
    (typeA === 'food' && typeB === 'chemical')
  );
}

/**
 * Проверка допустимости набора. Единственная точка правды об ограничениях:
 * и FFD, и отжиг, и тесты спрашивают именно её.
 *
 * @param {Array} items выбранные заявки
 * @param {Object} mine наш груз — он в вагоне всегда
 * @returns {{ok:boolean, tons:number, volumeM3:number, reason:string|null}}
 */
export function checkFeasible(items, mine) {
  let tons = mine ? mine.tons : 0;
  let volumeM3 = mine ? mine.volumeM3 : 0;
  const types = new Set(mine ? [mine.cargoType] : []);

  for (const it of items) {
    tons += it.tons;
    volumeM3 += it.volumeM3;
    types.add(it.cargoType);
  }

  if (tons > WAGON_CAP_T + 1e-9) {
    return { ok: false, tons, volumeM3, reason: 'перегруз по массе' };
  }
  if (volumeM3 > WAGON_CAP_M3 + 1e-9) {
    return { ok: false, tons, volumeM3, reason: 'перегруз по объёму' };
  }
  if (types.has('chemical') && types.has('food')) {
    return { ok: false, tons, volumeM3, reason: 'химия вместе с продуктами' };
  }
  return { ok: true, tons, volumeM3, reason: null };
}

/** Быстрая проверка одной заявки против уже набранного состояния. */
function fitsInto(state, item) {
  if (state.tons + item.tons > WAGON_CAP_T + 1e-9) return false;
  if (state.volumeM3 + item.volumeM3 > WAGON_CAP_M3 + 1e-9) return false;
  if (state.hasChemical && item.cargoType === 'food') return false;
  if (state.hasFood && item.cargoType === 'chemical') return false;
  return true;
}

/** Пересчитывает агрегаты набора с нуля. */
function summarize(selected, mine) {
  let tons = mine ? mine.tons : 0;
  let volumeM3 = mine ? mine.volumeM3 : 0;
  let hasFood = mine ? mine.cargoType === 'food' : false;
  let hasChemical = mine ? mine.cargoType === 'chemical' : false;

  for (const it of selected) {
    tons += it.tons;
    volumeM3 += it.volumeM3;
    if (it.cargoType === 'food') hasFood = true;
    if (it.cargoType === 'chemical') hasChemical = true;
  }
  return { tons, volumeM3, hasFood, hasChemical };
}

// ---------------------------------------------------------------------
//  ЖАДНАЯ БАЗА: FIRST-FIT DECREASING
// ---------------------------------------------------------------------

/**
 * Сортируем партии по убыванию массы и кладём подряд всё, что влезает.
 *
 * Почему по убыванию: крупные партии труднее разместить, и если начинать
 * с мелких, к моменту появления крупной места уже нет. Классический
 * результат для упаковки в контейнеры — сортировка по убыванию заметно
 * улучшает жадность и почти ничего не стоит.
 *
 * @param {Array} candidates попутные заявки
 * @param {Object} mine наш груз
 * @returns {{selected:Array, tons:number, volumeM3:number}}
 */
export function packFFD(candidates, mine) {
  // Сортируем КОПИЮ: вход мутировать нельзя, его ещё покажет UI.
  // При равной массе — по возрастанию объёма: из двух одинаковых
  // по тоннажу партий полезнее компактная.
  const sorted = candidates
    .slice()
    .sort((a, b) => b.tons - a.tons || a.volumeM3 - b.volumeM3);

  const state = summarize([], mine);
  const selected = [];

  for (const it of sorted) {
    if (!fitsInto(state, it)) continue;
    selected.push(it);
    state.tons += it.tons;
    state.volumeM3 += it.volumeM3;
    if (it.cargoType === 'food') state.hasFood = true;
    if (it.cargoType === 'chemical') state.hasChemical = true;
  }

  return { selected, tons: state.tons, volumeM3: state.volumeM3 };
}

// ---------------------------------------------------------------------
//  ЦЕЛЕВАЯ ФУНКЦИЯ
// ---------------------------------------------------------------------

/**
 * Загруженный тоннаж со штрафом за нарушения.
 *
 * Штраф, а не запрет: отжигу полезно проходить через недопустимые
 * состояния — иногда единственный путь к лучшему решению лежит через
 * временный перегруз. Штраф сделан заведомо больше любого возможного
 * выигрыша (коэффициент 100 при тоннаже до 68), поэтому итоговое лучшее
 * решение недопустимым остаться не может.
 */
function objective(state) {
  let score = state.tons;
  const overT = Math.max(0, state.tons - WAGON_CAP_T);
  const overV = Math.max(0, state.volumeM3 - WAGON_CAP_M3);
  score -= 100 * overT;
  score -= 100 * overV;
  if (state.hasFood && state.hasChemical) score -= 100 * WAGON_CAP_T;
  return score;
}

// ---------------------------------------------------------------------
//  ИМИТАЦИЯ ОТЖИГА
// ---------------------------------------------------------------------

/**
 * Упаковка вагона отжигом.
 *
 * Старт — решение FFD, а не случайный набор: незачем тратить итерации
 * на то, что жадный алгоритм даёт мгновенно.
 *
 * Соседнее состояние выбирается из трёх ходов:
 *   ВКЛЮЧИТЬ  — добавить случайную отвергнутую партию;
 *   ИСКЛЮЧИТЬ — убрать случайную принятую;
 *   ОБМЕНЯТЬ  — поменять принятую на отвергнутую.
 * Обмен нужен отдельно: через последовательность «убрать + добавить»
 * отжиг проходил бы только если промежуточное состояние не хуже, а оно
 * почти всегда хуже — теряется тоннаж. Один ход вместо двух снимает
 * этот барьер.
 *
 * Температура падает геометрически от T_START к T_END.
 *
 * @param {Array} candidates попутные заявки
 * @param {Object} mine наш груз
 * @param {number|string} seed
 * @param {Object} [opts] { iterations }
 * @returns {Object} PackResult по контракту
 */
export function packAnneal(candidates, mine, seed = 'pack', opts = {}) {
  const iterations = Math.max(0, opts.iterations ?? ANNEAL_ITERATIONS);
  const rng = makeRng(seed);

  const all = candidates.slice();
  const n = all.length;

  // База FFD — и стартовая точка, и то, с чем сравниваем в отчёте.
  const ffd = packFFD(all, mine);
  const baseline = { tons: ffd.tons, volumeM3: ffd.volumeM3 };

  const inWagon = new Array(n).fill(false);
  const ffdSet = new Set(ffd.selected);
  for (let i = 0; i < n; i++) if (ffdSet.has(all[i])) inWagon[i] = true;

  let cur = stateOf(inWagon, all, mine);
  let curScore = objective(cur);

  // Лучшее встреченное решение храним отдельно: отжиг блуждает и в конце
  // может оказаться хуже, чем был в середине. Без этого «отжиг не хуже
  // жадного» перестало бы выполняться.
  let bestMask = inWagon.slice();
  let bestScore = curScore;

  const cooling = iterations > 1 ? Math.pow(T_END / T_START, 1 / (iterations - 1)) : 1;
  let T = T_START;
  let steps = 0;

  for (let k = 0; k < iterations && n > 0; k++) {
    steps++;

    const accepted = [];
    const rejected = [];
    for (let i = 0; i < n; i++) (inWagon[i] ? accepted : rejected).push(i);

    // Выбор хода зависит от того, какие вообще возможны.
    let move;
    if (accepted.length === 0) move = 'add';
    else if (rejected.length === 0) move = rng.bool(0.5) ? 'drop' : 'noop';
    else {
      const r = rng.float();
      move = r < 0.4 ? 'add' : r < 0.7 ? 'drop' : 'swap';
    }

    let flipped = [];
    if (move === 'add') {
      const i = rejected[rng.int(0, rejected.length - 1)];
      inWagon[i] = true;
      flipped = [i];
    } else if (move === 'drop') {
      const i = accepted[rng.int(0, accepted.length - 1)];
      inWagon[i] = false;
      flipped = [i];
    } else if (move === 'swap') {
      const i = accepted[rng.int(0, accepted.length - 1)];
      const j = rejected[rng.int(0, rejected.length - 1)];
      inWagon[i] = false;
      inWagon[j] = true;
      flipped = [i, j];
    } else {
      T *= cooling;
      continue;
    }

    const next = stateOf(inWagon, all, mine);
    const nextScore = objective(next);
    const delta = nextScore - curScore;

    // Критерий Метрополиса: улучшение принимаем всегда, ухудшение —
    // с вероятностью e^(Δ/T). Отсюда и требование к масштабу температуры:
    // при T порядка размера партии ухудшение на одну партию проходит
    // в начале и почти не проходит в конце.
    if (delta >= 0 || rng.float() < Math.exp(delta / Math.max(T, 1e-9))) {
      cur = next;
      curScore = nextScore;
      if (nextScore > bestScore) {
        bestScore = nextScore;
        bestMask = inWagon.slice();
      }
    } else {
      for (const i of flipped) inWagon[i] = !inWagon[i]; // откат хода
    }

    T *= cooling;
  }

  return buildResult(bestMask, all, mine, baseline, steps);
}

/** Агрегаты набора по маске. */
function stateOf(mask, all, mine) {
  const sel = [];
  for (let i = 0; i < mask.length; i++) if (mask[i]) sel.push(all[i]);
  return summarize(sel, mine);
}

/** Собирает PackResult по контракту types.js. */
function buildResult(mask, all, mine, baseline, iterations) {
  const accepted = [];
  const rejected = [];
  for (let i = 0; i < all.length; i++) {
    // Заявки не мутируем: отдаём копии с проставленным accepted,
    // иначе повторный вызов упаковки увидел бы чужие пометки.
    const marked = { ...all[i], accepted: !!mask[i] };
    (mask[i] ? accepted : rejected).push(marked);
  }

  const s = summarize(accepted, mine);

  // ЧТО С ЧЕМ СРАВНИВАЕМ.
  //
  // Отжиг максимизирует ТОННАЖ — это и есть цель: больше тонн за один
  // и тот же рейс вагона. Поэтому `fillPct` и `baselineFillPct`, между
  // которыми UI считает разность «отжиг дал +N пунктов», обязаны мерить
  // именно тоннаж. Иначе набор с большей массой, но меньшей кубатурой
  // выглядел бы проигрышем, хотя везёт больше груза, — и гарантия
  // «отжиг не хуже жадного» переставала бы выполняться на отчётном числе.
  //
  // Занятость по объёму нужна отдельно: именно она объясняет, почему
  // вагон не добирает тонны, и её показываем своим полем.
  const massFill = Math.min(1, s.tons / WAGON_CAP_T);
  const baselineMassFill = Math.min(1, baseline.tons / WAGON_CAP_T);
  const volFill = Math.min(1, s.volumeM3 / WAGON_CAP_M3);

  return {
    accepted,
    rejected,
    tonsTotal: Math.round(s.tons * 100) / 100,
    volumeTotalM3: Math.round(s.volumeM3 * 10) / 10,
    // Контрактные поля: обе доли по тоннажу, разность осмысленна
    fillPct: Math.round(massFill * 1000) / 10,
    baselineFillPct: Math.round(baselineMassFill * 1000) / 10,
    gainPp: Math.round((massFill - baselineMassFill) * 1000) / 10,
    // Занятость по объёму и по лимитирующему ресурсу — для отрисовки вагона
    volumeFillPct: Math.round(volFill * 1000) / 10,
    limitingFillPct: Math.round(Math.max(massFill, volFill) * 1000) / 10,
    limitedBy: volFill > massFill ? 'объём' : 'масса',
    baselineTonsT: Math.round(baseline.tons * 100) / 100,
    iterations,
  };
}

/**
 * Публичная точка входа: упаковать вагон.
 * Возвращает PackResult с полями `fillPct` и `baselineFillPct`,
 * чтобы UI мог показать «отжиг дал +N процентных пунктов».
 *
 * @param {Array} arrivals попутные заявки
 * @param {Object} mine наш груз { tons, volumeM3, cargoType }
 * @param {number|string} [seed]
 * @param {Object} [opts]
 */
export function packing(arrivals = [], mine = null, seed = 'pack', opts = {}) {
  const my = mine
    ? {
        tons: Math.max(0, mine.tons || 0),
        volumeM3: Math.max(0, mine.volumeM3 || 0),
        cargoType: mine.cargoType || 'general',
      }
    : null;

  // Заявки, несовместимые с нашим грузом, отсекаем сразу: держать их
  // в пространстве поиска бессмысленно — они не могут попасть в вагон.
  const usable = arrivals.filter(
    (a) => a && a.tons > 0 && (!my || !incompatible(my.cargoType, a.cargoType))
  );

  return packAnneal(usable, my, seed, opts);
}
