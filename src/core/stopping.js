// =====================================================================
//  TOLYQ — МАРКОВСКИЙ ПРОЦЕСС ПРИНЯТИЯ РЕШЕНИЙ (MDP)
//  ОБ ОПТИМАЛЬНОЙ ОСТАНОВКЕ. ИНТЕЛЛЕКТУАЛЬНЫЙ ЦЕНТР ПРОЕКТА
// ---------------------------------------------------------------------
//  Вопрос: в каждый час — отправлять вагон с тем, что накоплено,
//  или ждать ещё час в надежде на попутный груз?
//
//  Это марковский процесс принятия решений с конечным горизонтом,
//  который мы решаем МЕТОДОМ ИТЕРАЦИИ ПО ЦЕННОСТИ (value iteration)
//  в форме обратной индукции по времени. Точные термины, каждому —
//  своя сущность в коде:
//
//  ПРОСТРАНСТВО СОСТОЯНИЙ  S = {(t, q)}
//      t — прошедшие часы, 0..T;
//      q — накопленный в вагоне тоннаж, дискретизирован по BIN_T тонн.
//      Марковость: стоимость и переходы зависят только от (t, q),
//      история накопления не важна. Это выполняется, потому что поток
//      заявок пуассоновский — он не помнит прошлого.
//
//  ПРОСТРАНСТВО ДЕЙСТВИЙ   A = { ОТПРАВИТЬ, ЖДАТЬ }
//      В терминальном состоянии t = T допустимо только ОТПРАВИТЬ.
//
//  ФУНКЦИЯ ПЕРЕХОДОВ       P(s' | s, a)   — transitionKernel()
//      ОТПРАВИТЬ: процесс поглощается, дальнейших переходов нет.
//      ЖДАТЬ:     (t, q) -> (t+1, q+Δ) с вероятностью P(Δ),
//                 где Δ — приход за час из market.js. Партия НЕДЕЛИМА:
//                 не влезла — состояние не изменилось.
//
//  ФУНКЦИЯ ВОЗНАГРАЖДЕНИЯ  (у нас — издержек)
//      ОТПРАВИТЬ: dispatchCost(q) = wagonCost · myTons / q.
//      ЖДАТЬ:     holdPerHour — плата за час ожидания.
//      Дисконтирования нет: горизонт конечный и короткий (часы),
//      вводить γ означало бы придумать ставку, которой у нас нет.
//
//  ФУНКЦИЯ ЦЕННОСТИ        V(t, q)  — минимальные ожидаемые издержки
//      Уравнение оптимальности Беллмана:
//        V(t,q) = min( dispatchCost(q),  holdPerHour + Σ P(Δ)·V(t+1, q+Δ) )
//        V(T,q) = dispatchCost(q)
//
//  ОПТИМАЛЬНАЯ ПОЛИТИКА    π*(t, q) ∈ A
//      Аргминимум того же выражения. Благодаря монотонности издержек
//      по q политика имеет ПОРОГОВУЮ структуру: существует q*(t) такое,
//      что π* = ОТПРАВИТЬ ⟺ q ≥ q*(t). Наружу отдаём именно пороги —
//      это компактное и читаемое представление всей политики.
//
//  Итерация по ценности здесь сходится за один проход назад по времени:
//  горизонт конечен, поэтому обратная индукция даёт точный оптимум,
//  а не приближение, — итерировать до сходимости не требуется.
//
//  ДВЕ НЕЗАВИСИМЫЕ ПРОВЕРКИ. Политику считает MDP по аналитическому
//  распределению переходов. Вероятность собрать вагон и фактическую
//  загрузку — Монте-Карло по сгенерированным потокам. Методы не имеют
//  общего кода за пределами market.js, поэтому расхождение их ответов
//  означает ошибку в одном из них. Совпадение — взаимное подтверждение.
//  Этой связкой найдены три реальные ошибки: обрезка неделимой партии
//  до вместимости, сравнение непрерывного тоннажа с сеточным порогом
//  и расчёт на недостижимую по кубатуре массу.
// =====================================================================

import { deltaPmfByHour, simulateArrivals } from './market.js';
import { paretoRoutes, wagonsNeeded } from './pareto.js';
import {
  WAGON_CAP_T,
  WAGON_CAP_M3,
  MIN_WAGON_SHARE,
  HOLDING_KZT_PER_TON_HOUR,
  MARKET_M3_PER_TON,
  effectiveWagonCapacityT,
} from './network.js';

// ---------------------------------------------------------------------
//  ДИСКРЕТИЗАЦИЯ
// ---------------------------------------------------------------------
/** Шаг сетки по тоннажу. 2 т на 68 т вместимости — 35 состояний. */
export const BIN_T = 2;
/** Число состояний по тоннажу: 0, 2, ..., 68. */
export const Q_BINS = Math.round(WAGON_CAP_T / BIN_T) + 1;
/** Потолок горизонта, часов. Держит ДП и Монте-Карло в бюджете времени. */
export const MAX_HORIZON_H = 168;
/** Прогонов Монте-Карло для оценки вероятности. */
export const MC_RUNS = 500;

const tonsOfBin = (b) => b * BIN_T;
const binOfTons = (t) => Math.min(Q_BINS - 1, Math.max(0, Math.round(t / BIN_T)));

// ---------------------------------------------------------------------
//  ПАРАМЕТРЫ ПЛЕЧА
// ---------------------------------------------------------------------

/**
 * Достаёт из фронта Парето то, что нужно задаче об остановке:
 * стоимость рейса вагона, время хода по ЖД и стоимость автомобильной
 * альтернативы. Вызывающий может передать их готовыми (solve() так и
 * делает), чтобы не считать фронт дважды.
 */
function railContext(request, opts = {}) {
  if (opts.railWagonCostKzt != null && opts.railHours != null) {
    return {
      railWagonCostKzt: opts.railWagonCostKzt,
      railHours: opts.railHours,
      truckCostKzt: opts.truckCostKzt ?? Infinity,
    };
  }

  const { pareto, dominated } = paretoRoutes(request.from, request.to, request);
  const all = pareto.concat(dominated);

  // Лучший железнодорожный вариант — самый дешёвый маршрут целиком по ЖД.
  const railRoutes = all.filter((r) => r.legs.length > 0 && r.legs.every((l) => l.mode === 'rail'));
  const rail = railRoutes.length
    ? railRoutes.reduce((a, b) => (a.costSoloKzt <= b.costSoloKzt ? a : b))
    : null;

  const roadRoutes = all.filter((r) => r.legs.length > 0 && r.legs.every((l) => l.mode === 'road'));
  const truck = roadRoutes.length ? roadRoutes.reduce((a, b) => (a.costKzt <= b.costKzt ? a : b)) : null;

  return {
    // costSoloKzt железнодорожного маршрута и есть цена рейса вагона целиком
    railWagonCostKzt: rail ? rail.costSoloKzt : null,
    railHours: rail ? rail.hours : null,
    truckCostKzt: truck ? truck.costKzt : Infinity,
  };
}

// ---------------------------------------------------------------------
//  ФУНКЦИЯ ПЕРЕХОДОВ P(s' | s, ЖДАТЬ)
// ---------------------------------------------------------------------

/**
 * Ядро переходов MDP для действия ЖДАТЬ.
 *
 * Возвращает для каждого часа t распределение прихода Δ по корзинам
 * тоннажа. Переход из (t, q) в (t+1, q+Δ) происходит с вероятностью
 * kernel[t][Δ]. Действие ОТПРАВИТЬ поглощающее и ядра не требует.
 *
 * Распределение АНАЛИТИЧЕСКОЕ, а не выборочное: иначе политика зависела
 * бы от seed, а Монте-Карло перестал быть независимой проверкой —
 * оба метода питались бы одной и той же случайностью.
 */
function transitionKernel(request, horizonH, opts = {}) {
  return deltaPmfByHour(request, horizonH, {
    binT: BIN_T,
    maxBins: Q_BINS,
    stationary: opts.stationary,
  });
}

// ---------------------------------------------------------------------
//  ФУНКЦИЯ ИЗДЕРЖЕК ДЕЙСТВИЯ «ОТПРАВИТЬ»
// ---------------------------------------------------------------------

/**
 * Издержки действия ОТПРАВИТЬ в состоянии с накопленными q тоннами.
 *
 * Доля вагона по нашему тоннажу, но не ниже минимальной тарифицируемой.
 * Автомобильная альтернатива доступна всегда: если доля вагона обходится
 * дороже целой фуры, оптимально уехать фурой, и модель обязана это видеть.
 */
function makeDispatchCost(myTons, wagonCost, truckCost) {
  return (qTons) => {
    const q = Math.max(qTons, myTons); // наш груз всегда в вагоне
    // При нулевой партии и нулевом накоплении отношение myTons/q даёт 0/0 = NaN,
    // и NaN расползается по всей функции ценности, превращая ответ движка
    // в нечисло. Вырожденный вход обязан давать конечный результат.
    const ratio = q > 0 ? myTons / q : 0;
    const share = Math.max(MIN_WAGON_SHARE, Math.min(1, ratio));
    return Math.min(wagonCost * share, truckCost);
  };
}

/**
 * ИТЕРАЦИЯ ПО ЦЕННОСТИ обратной индукцией по времени.
 *
 * Один проход от терминального слоя t = T к t = 0. Для конечного горизонта
 * этого достаточно: значение V(t, ·) полностью определяется уже посчитанным
 * V(t+1, ·), поэтому повторять проходы до сходимости, как в бесконечном
 * горизонте, не нужно — результат точен.
 *
 * @returns {{V:Float64Array[], dispatch:Uint8Array[], threshold:number[]}}
 *   V         — функция ценности V(t, q);
 *   dispatch  — оптимальная политика π*(t, q): 1 = ОТПРАВИТЬ, 0 = ЖДАТЬ;
 *   threshold — пороговое представление той же политики q*(t).
 */
function backwardInduction({ horizonH, pmfByHour, dispatchCost, holdPerHour, capBin }) {
  const T = horizonH;
  // Выше фактической вместимости состояния недостижимы: лёгкий груз
  // закубатуривает вагон задолго до паспортных 68 т, и ДП не должно
  // рассчитывать на массу, которую вагон физически не примет.
  const top = Math.min(capBin ?? Q_BINS - 1, Q_BINS - 1);

  // V[t][b] — функция ценности: минимальные ожидаемые издержки из (t, b).
  const V = new Array(T + 1);
  // doDispatch[t][b] — оптимальная политика π*(t, b).
  const doDispatch = new Array(T + 1);

  // ТЕРМИНАЛЬНОЕ УСЛОВИЕ: в t = T множество допустимых действий сужается
  // до одного — ОТПРАВИТЬ, поэтому V(T, q) = dispatchCost(q).
  V[T] = new Float64Array(Q_BINS);
  doDispatch[T] = new Uint8Array(Q_BINS).fill(1);
  for (let b = 0; b < Q_BINS; b++) V[T][b] = dispatchCost(tonsOfBin(b));

  for (let t = T - 1; t >= 0; t--) {
    const Vt = new Float64Array(Q_BINS);
    const Dt = new Uint8Array(Q_BINS);
    const next = V[t + 1];
    const pmf = pmfByHour[t] || pmfByHour[pmfByHour.length - 1];

    for (let b = 0; b <= top; b++) {
      // Ожидаемая стоимость ожидания: час хранения плюс матожидание по приходу.
      //
      // Партия НЕДЕЛИМА. Если пришедший груз не влезает в остаток вагона,
      // он уезжает другим вагоном целиком, а состояние не меняется.
      // Обрезать приход до вместимости (min(top, b+d)) было бы молчаливым
      // предположением, что чужую партию можно разделить: ДП тогда считает
      // накопление быстрее, чем оно идёт, и советует ждать меньше, чем нужно.
      let wait = holdPerHour;
      for (let d = 0; d < pmf.length; d++) {
        const p = pmf[d];
        if (p === 0) continue;
        const nb = b + d;
        wait += p * next[nb <= top ? nb : b];
      }

      // Уравнение Беллмана: сравниваем издержки двух действий и берём
      // минимум; аргминимум и есть оптимальное действие в этом состоянии.
      const now = dispatchCost(tonsOfBin(b));
      if (now <= wait) {
        Vt[b] = now;
        Dt[b] = 1;
      } else {
        Vt[b] = wait;
        Dt[b] = 0;
      }
    }

    // Состояния выше фактической вместимости недостижимы, но массив
    // держим полной длины: UI рисует таблицу целиком и не должен
    // спотыкаться о дырки.
    for (let b = top + 1; b < Q_BINS; b++) {
      Vt[b] = dispatchCost(tonsOfBin(b));
      Dt[b] = 1;
    }

    V[t] = Vt;
    doDispatch[t] = Dt;
  }

  // ПОРОГОВОЕ ПРЕДСТАВЛЕНИЕ ПОЛИТИКИ.
  // q*(t) — наименьший тоннаж, при котором оптимально ОТПРАВИТЬ.
  // Порог всегда существует: при полном вагоне ждать бессмысленно —
  // приход уже некуда девать, а час ожидания оплачивать придётся.
  // Эквивалентность «π* = ОТПРАВИТЬ ⟺ q ≥ q*(t)» опирается на то, что
  // издержки отправки не возрастают по q, а ценность ожидания не убывает
  // медленнее; тест на монотонность порога это свойство и проверяет.
  const threshold = new Array(T + 1);
  for (let t = 0; t <= T; t++) {
    let q = tonsOfBin(top);
    for (let b = 0; b <= top; b++) {
      if (doDispatch[t][b]) {
        q = tonsOfBin(b);
        break;
      }
    }
    threshold[t] = q;
  }

  return { V, dispatch: doDispatch, threshold };
}

// ---------------------------------------------------------------------
//  МОНТЕ-КАРЛО: НЕЗАВИСИМАЯ ПРОВЕРКА
// ---------------------------------------------------------------------

/**
 * Прогоняет оптимальную политику π* по сгенерированным реализациям потока.
 *
 * Считает не только вероятность, ради которой затевался, но и фактическую
 * загрузку и среднюю реализованную стоимость. Последняя сверяется с
 * ожидаемой стоимостью из ДП — это и есть взаимная проверка двух методов.
 *
 * Совместимость груза учитывается: химия не едет с продуктами, поэтому
 * несовместимые заявки в накопление не идут. Тонкую упаковку по объёму
 * делает packing.js, здесь нужна только суммарная масса.
 */
function monteCarlo({ request, horizonH, threshold, myTons, dispatchCost, holdPerHour, runs, seed, truckCostKzt, wagonCost, capT }) {
  let wagonRuns = 0;
  let costSum = 0;
  let fillSum = 0;
  let dispatchHourSum = 0;

  const myType = request.cargoType || 'general';
  const conflicts = (type) =>
    (myType === 'chemical' && type === 'food') || (myType === 'food' && type === 'chemical');

  for (let r = 0; r < runs; r++) {
    const arrivals = simulateArrivals(request, horizonH, `${seed}:mc:${r}`);

    let q = myTons;
    let volume = request.volumeM3 || 0;
    let idx = 0;
    let dispatchedAt = horizonH;

    for (let t = 0; t <= horizonH; t++) {
      // Добираем всё, что пришло к часу t
      while (idx < arrivals.length && arrivals[idx].atH <= t) {
        const a = arrivals[idx++];
        if (conflicts(a.cargoType)) continue;
        if (q + a.tons > capT) continue;
        if (volume + a.volumeM3 > WAGON_CAP_M3) continue;
        q += a.tons;
        volume += a.volumeM3;
      }

      // Политика читается на СЕТКЕ КОРЗИН, в которой её посчитало ДП.
      // Сравнивать непрерывный тоннаж с порогом нельзя: 17 т не дотягивают
      // до порога 18 т, хотя ДП считает их одним и тем же состоянием, —
      // Монте-Карло тогда ждёт до конца горизонта и завышает стоимость.
      const qState = Math.min(capT, tonsOfBin(binOfTons(q)));
      if (t >= horizonH || qState >= threshold[Math.min(t, threshold.length - 1)]) {
        dispatchedAt = t;
        break;
      }
    }

    // Дискретизируем так же, как ДП, иначе сравнение двух методов
    // поймает не ошибку, а разницу округлений.
    const qBinned = Math.min(capT, tonsOfBin(binOfTons(q)));
    const share = Math.max(MIN_WAGON_SHARE, Math.min(1, myTons / Math.max(qBinned, myTons)));
    const wagonPrice = wagonCost * share;

    // «Откат на фуру» — когда доля вагона обходится дороже целой машины.
    if (wagonPrice <= truckCostKzt) wagonRuns++;

    costSum += dispatchCost(qBinned) + holdPerHour * dispatchedAt;
    fillSum += Math.min(q, capT);
    dispatchHourSum += dispatchedAt;
  }

  return {
    probability: runs > 0 ? wagonRuns / runs : 0,
    mcExpectedCostKzt: runs > 0 ? costSum / runs : 0,
    expectedFillT: runs > 0 ? fillSum / runs : myTons,
    meanDispatchH: runs > 0 ? dispatchHourSum / runs : 0,
    runs,
  };
}

// ---------------------------------------------------------------------
//  ПУБЛИЧНОЕ API
// ---------------------------------------------------------------------

/**
 * Решает MDP и возвращает оптимальную политику по контракту StoppingPolicy.
 *
 * @param {Object} request ShipmentRequest
 * @param {number|string} [seed]
 * @param {Object} [opts] railWagonCostKzt / railHours / truckCostKzt / mcRuns
 * @returns {Object} StoppingPolicy плюс диагностические поля
 */
export function computeStopping(request = {}, seed = 'tolyq', opts = {}) {
  const myTons = Math.max(0, request.tons || 0);
  const ctx = railContext(request, opts);

  // Вырожденный случай: железнодорожного варианта нет вовсе.
  if (ctx.railWagonCostKzt == null) {
    return degenerate('нет железнодорожного маршрута — консолидировать нечего', myTons);
  }

  // Вырожденный случай: партия не помещается в вагон. Делить не с кем,
  // ждать попутный груз бессмысленно — отправляем немедленно.
  if (wagonsNeeded(myTons, request.volumeM3 || 0) > 1) {
    return degenerate('партия больше вагона — попутный груз не нужен', myTons);
  }

  // Горизонт: сколько часов можно ждать, чтобы всё ещё успеть к сроку.
  const deadlineH = request.deadlineH ?? 96;
  const rawHorizon = Math.floor(deadlineH - ctx.railHours);
  const horizonH = Math.max(0, Math.min(MAX_HORIZON_H, rawHorizon));

  // Вырожденный случай: срок не оставляет времени на ожидание.
  if (horizonH <= 0) {
    const policy = degenerate(
      rawHorizon <= 0
        ? `дедлайн ${Math.round(deadlineH)} ч меньше времени хода ${Math.round(ctx.railHours)} ч — ждать нельзя`
        : 'на ожидание не остаётся времени',
      myTons
    );
    policy.horizonH = 0;
    policy.expectedValueKzt = Math.round(
      makeDispatchCost(myTons, ctx.railWagonCostKzt, ctx.truckCostKzt)(myTons)
    );
    return policy;
  }

  const dispatchCost = makeDispatchCost(myTons, ctx.railWagonCostKzt, ctx.truckCostKzt);
  const holdPerHour = HOLDING_KZT_PER_TON_HOUR * myTons;
  const pmfByHour = transitionKernel(request, horizonH, opts);

  // Фактическая вместимость: сколько тонн вагон реально примет.
  // Остаток вагона заполняется ПОТОКОМ, поэтому считаем по
  // среднерыночной плотности, а не по плотности нашего груза.
  const capT = effectiveWagonCapacityT(myTons, request.volumeM3 || 0, MARKET_M3_PER_TON);
  const capBin = binOfTons(capT);

  const { V, threshold } = backwardInduction({
    horizonH,
    pmfByHour,
    dispatchCost,
    holdPerHour,
    capBin,
  });

  const startBin = binOfTons(myTons);
  const expectedValueKzt = V[0][startBin];

  // Рекомендуемый час отправки «при среднем сценарии»: детерминированный
  // прогон, где вместо случайного прихода берётся его матожидание.
  const dispatchAtH = expectedPathDispatchHour(pmfByHour, threshold, myTons, horizonH, capT);

  const mc = monteCarlo({
    request,
    horizonH,
    threshold,
    myTons,
    dispatchCost,
    holdPerHour,
    runs: opts.mcRuns ?? MC_RUNS,
    seed,
    truckCostKzt: ctx.truckCostKzt,
    wagonCost: ctx.railWagonCostKzt,
    capT,
  });

  return {
    // Контракт StoppingPolicy
    thresholdByHour: threshold,
    expectedValueKzt: Math.round(expectedValueKzt),
    dispatchAtH,
    probability: mc.probability,
    horizonH,

    // Диагностика и данные для solve(): поля добавочные, контракт не ломают
    effectiveCapT: Math.round(capT * 10) / 10,
    expectedFillT: Math.round(mc.expectedFillT * 10) / 10,
    mcExpectedCostKzt: Math.round(mc.mcExpectedCostKzt),
    meanDispatchH: Math.round(mc.meanDispatchH * 10) / 10,
    mcRuns: mc.runs,
    railWagonCostKzt: ctx.railWagonCostKzt,
    railHours: ctx.railHours,
    truckCostKzt: Number.isFinite(ctx.truckCostKzt) ? ctx.truckCostKzt : null,
    holdingPerHourKzt: holdPerHour,
    binT: BIN_T,
    degenerate: false,
  };
}

/** Политика для случаев, где ожидание бессмысленно или невозможно. */
function degenerate(reason, myTons) {
  return {
    thresholdByHour: [Math.max(myTons, 0)],
    expectedValueKzt: 0,
    dispatchAtH: 0,
    probability: 0,
    horizonH: 0,
    expectedFillT: myTons,
    mcExpectedCostKzt: 0,
    meanDispatchH: 0,
    mcRuns: 0,
    railWagonCostKzt: null,
    railHours: null,
    truckCostKzt: null,
    holdingPerHourKzt: 0,
    binT: BIN_T,
    degenerate: true,
    reason,
  };
}

/**
 * Час отправки при среднем сценарии: накапливаем матожидание прихода
 * и смотрим, когда пересечём порог. Это не то же самое, что средний час
 * отправки по Монте-Карло (среднее от функции ≠ функция от среднего),
 * и оба числа возвращаются отдельно.
 */
function expectedPathDispatchHour(pmfByHour, threshold, myTons, horizonH, capT = WAGON_CAP_T) {
  let q = myTons;
  for (let t = 0; t <= horizonH; t++) {
    if (q >= threshold[Math.min(t, threshold.length - 1)]) return t;
    if (t >= horizonH) break;
    const pmf = pmfByHour[t] || pmfByHour[pmfByHour.length - 1];
    let mean = 0;
    for (let d = 0; d < pmf.length; d++) mean += pmf[d] * tonsOfBin(d);
    q = Math.min(capT, q + mean);
  }
  return horizonH;
}

/**
 * Таблица ценностей целиком — для отладки и для графиков в UI.
 * Отдельная функция, чтобы computeStopping() не таскал за собой
 * мегабайты Float64Array в каждом ответе движка.
 */
export function stoppingValueTable(request = {}, opts = {}) {
  const myTons = Math.max(0, request.tons || 0);
  const ctx = railContext(request, opts);
  if (ctx.railWagonCostKzt == null) return null;

  const horizonH = Math.max(
    0,
    Math.min(MAX_HORIZON_H, Math.floor((request.deadlineH ?? 96) - ctx.railHours))
  );
  if (horizonH <= 0) return null;

  const dispatchCost = makeDispatchCost(myTons, ctx.railWagonCostKzt, ctx.truckCostKzt);
  const pmfByHour = transitionKernel(request, horizonH, opts);
  const capT = effectiveWagonCapacityT(myTons, request.volumeM3 || 0, MARKET_M3_PER_TON);

  const res = backwardInduction({
    horizonH,
    pmfByHour,
    dispatchCost,
    holdPerHour: HOLDING_KZT_PER_TON_HOUR * myTons,
    capBin: binOfTons(capT),
  });

  return {
    horizonH,
    binT: BIN_T,
    qBins: Q_BINS,
    effectiveCapT: capT,
    tonsOfBin: Array.from({ length: Q_BINS }, (_, b) => tonsOfBin(b)),
    V: res.V.map((row) => Array.from(row)),
    dispatch: res.dispatch.map((row) => Array.from(row)),
    threshold: res.threshold,
  };
}
