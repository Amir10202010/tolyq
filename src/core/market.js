// =====================================================================
//  TOLYQ — ПОТОК ПОПУТНЫХ ГРУЗОВ
// ---------------------------------------------------------------------
//  Неоднородный пуассоновский процесс: заявки приходят случайно, но
//  интенсивность зависит от времени суток. Ночью диспетчерские не
//  работают, днём поток в разы плотнее — без этого модель ожидания
//  была бы неверной именно там, где решение принимается.
//
//  Модуль отдаёт две вещи:
//    1. simulateArrivals() — реализации потока для анимации и Монте-Карло;
//    2. deltaPmfByHour()   — АНАЛИТИЧЕСКОЕ распределение прихода за час,
//                            на нём считает ДП в stopping.js.
//  Второе принципиально: ДП должно работать с распределением, а не с
//  выборкой, иначе политика начинает зависеть от seed.
// =====================================================================

import { makeRng } from './random.js';
import { arrivalsPerDayBetween, M3_PER_TON, m3PerTon } from './network.js';

// ---------------------------------------------------------------------
//  ЧАСОВАЯ СЕЗОННОСТЬ
// ---------------------------------------------------------------------
/**
 * Форма суточного профиля заявок, часы 0..23.
 *
 * Обоснование формы: заявка на догрузку вагона подаётся не грузом, а
 * человеком в диспетчерской отправителя. Отсюда:
 *   03:00–05:00 — почти ноль, работают только аварийные отправки;
 *   07:00–09:00 — резкий подъём с началом рабочего дня;
 *   10:00–12:00 — первый пик: разбор утренней почты и заявок;
 *   12:00–13:00 — провал на обед, видимый в любых логистических логах;
 *   14:00–17:00 — второй пик, выше первого: «успеть оформить сегодня»;
 *   после 18:00 — спад, к полуночи затухание.
 * Отношение пика к ночи ~27:1.
 *
 * Значения сырые: код нормирует их так, чтобы СРЕДНЕЕ было ровно 1.
 * Тогда суточная сумма интенсивности равна arrivalsPerDay ребра,
 * и параметр сети сохраняет смысл при любой правке формы профиля.
 */
const SEASONALITY_RAW = [
  0.15, 0.10, 0.08, 0.08, 0.10, 0.20, // 00–05
  0.45, 0.80, 1.40, 1.90, 2.20, 2.10, // 06–11
  1.50, 1.70, 2.00, 2.10, 1.90, 1.50, // 12–17
  1.05, 0.75, 0.55, 0.40, 0.30, 0.20, // 18–23
];

export const HOURLY_SEASONALITY = (() => {
  const mean = SEASONALITY_RAW.reduce((a, b) => a + b, 0) / 24;
  return SEASONALITY_RAW.map((v) => v / mean);
})();

/** Коэффициент сезонности в момент t (часов от начала горизонта). */
export function seasonalFactor(t, startHour = 8) {
  const h = ((Math.floor(t) + startHour) % 24 + 24) % 24;
  return HOURLY_SEASONALITY[h];
}

// ---------------------------------------------------------------------
//  РАЗМЕР ПАРТИИ
// ---------------------------------------------------------------------
/**
 * Логнормальное распределение с медианой 9 т, обрезка 2..18.
 * Логнормальное, а не нормальное: масса партии положительна и
 * распределена скошенно — много мелких, мало крупных. Это ровно та
 * форма, из-за которой одиночный отправитель не собирает вагон.
 */
export const LOT_MEDIAN_T = 9;
export const LOT_MU = Math.log(LOT_MEDIAN_T); // медиана логнормального = exp(mu)
export const LOT_SIGMA = 0.45; // при таком σ границы 2 и 18 отсекают ~12 % хвостов
export const LOT_MIN_T = 2;
export const LOT_MAX_T = 18;

/**
 * Плотность генгруза, м³/т. Определена в network.js, потому что от неё
 * зависит фактическая вместимость вагона. Здесь импорт плюс реэкспорт:
 * одна лишь форма `export ... from` не создаёт локальной привязки,
 * и обращение к имени внутри модуля упало бы в ReferenceError.
 */
export { M3_PER_TON };

/** Доли типов груза. Химия редка, но именно она ломает совместимость. */
export const CARGO_WEIGHTS = { general: 0.6, food: 0.3, chemical: 0.1 };
const CARGO_KEYS = ['general', 'food', 'chemical'];
const CARGO_PROBS = CARGO_KEYS.map((k) => CARGO_WEIGHTS[k]);

/** Правдоподобные казахстанские отправители. */
export const SHIPPERS = [
  'ТОО «Астана Агро Логистик»',
  'ТОО «Караганда Метиз»',
  'ИП Сеитов',
  'ТОО «Алтын Дән»',
  'ТОО «Шымкент Пласт»',
  'ИП Абдрахманова',
  'ТОО «Тараз Химпром»',
  'ТОО «Каспий Трейд»',
  'ТОО «Павлодар Профиль»',
  'ИП Мухамеджанов',
  'ТОО «Костанай Зерно»',
  'ТОО «Актобе Строй Ресурс»',
  'ТОО «Хоргос Транзит»',
  'ИП Нурланова',
  'ТОО «Атырау Нефтесервис»',
];

// ---------------------------------------------------------------------
//  ГЕНЕРАЦИЯ ПОТОКА
// ---------------------------------------------------------------------

/**
 * Размер партии: логнормальное с обрезкой ПЕРЕСЭМПЛИРОВАНИЕМ, а не зажимом.
 * Зажим (Math.min/max) свалил бы отсечённые хвосты в точки 2 и 18 и создал
 * там ложные пики массы — на ДП это влияет заметно, потому что пороги
 * как раз около границ. Пересэмплирование сохраняет форму усечённого
 * распределения точно.
 */
function drawLotTons(rng) {
  for (let i = 0; i < 50; i++) {
    const v = rng.lognormal(LOT_MU, LOT_SIGMA);
    if (v >= LOT_MIN_T && v <= LOT_MAX_T) return v;
  }
  return LOT_MEDIAN_T; // патологический seed — отдаём медиану, но не зацикливаемся
}

/**
 * Реализация неоднородного пуассоновского процесса методом прореживания
 * (Льюис — Шедлер).
 *
 * Почему прореживание, а не «розыгрыш числа событий в каждом часе»:
 * прореживание даёт точные МОМЕНТЫ событий в непрерывном времени, а не
 * их количество в часовых корзинах. Для анимации в UI и для проверки
 * политики по часам это принципиально — заявка приходит в 14:37, а не
 * «где-то в четырнадцатом часу».
 *
 * @param {Object} request заявка (нужны from/to для интенсивности плеча)
 * @param {number} horizonH горизонт наблюдения, часов
 * @param {number|string} seed
 * @param {Object} [opts]
 * @param {number} [opts.startHour] час суток на момент t=0 (по умолчанию 8)
 * @param {number} [opts.lambdaPerDay] переопределить интенсивность плеча
 * @param {boolean} [opts.stationary] отключить сезонность (однородный поток).
 *        Нужен для проверки теоретических свойств политики: монотонность
 *        порога доказывается именно для стационарного потока.
 * @returns {Array} Arrival[] по контракту, отсортированы по времени
 */
export function simulateArrivals(request = {}, horizonH = 48, seed = 'tolyq', opts = {}) {
  const H = Math.max(0, horizonH);
  if (H === 0) return [];

  const rng = makeRng(seed);
  const startHour = opts.startHour ?? 8;

  const perDay =
    opts.lambdaPerDay ?? arrivalsPerDayBetween(request.from || 'AST', request.to || 'ALA');
  const lambdaBase = perDay / 24; // средняя интенсивность, событий в час

  // Мажоранта: максимум интенсивности по суткам. Прореживание требует
  // огибающей сверху, иначе часть событий теряется.
  const stationary = !!opts.stationary;
  const peak = stationary ? 1 : Math.max(...HOURLY_SEASONALITY);
  const lambdaMax = lambdaBase * peak;
  if (!(lambdaMax > 0)) return [];

  const arrivals = [];
  let t = 0;
  // Страховка от бесконечного цикла на вырожденных параметрах.
  const guard = Math.ceil(lambdaMax * H * 20) + 1000;

  for (let i = 0; i < guard; i++) {
    t += rng.exp(1 / lambdaMax); // однородный поток с интенсивностью мажоранты
    if (t >= H) break;

    // Принимаем кандидата с вероятностью λ(t)/λmax — так однородный
    // поток превращается в неоднородный с нужным профилем.
    if (!stationary) {
      const accept = seasonalFactor(t, startHour) / peak;
      if (rng.float() >= accept) continue;
    }

    const tons = drawLotTons(rng);
    // Тип груза разыгрываем ДО объёма: от него зависит плотность.
    // Зерно и генеральный груз в таре занимают разный объём при равной массе,
    // и именно это определяет, чем закончится вагон — тоннами или кубами.
    const cargoType = rng.pick(CARGO_KEYS, CARGO_PROBS);
    // Шум объёма: партии разной укладки при одинаковой массе и типе.
    const density = m3PerTon(cargoType) * Math.max(0.6, rng.normal(1, 0.12));

    arrivals.push({
      atH: Math.round(t * 100) / 100,
      tons: Math.round(tons * 100) / 100,
      volumeM3: Math.round(tons * density * 10) / 10,
      cargoType,
      shipper: rng.pick(SHIPPERS),
      accepted: false, // проставит packing.js
    });
  }

  return arrivals;
}

/** Средняя интенсивность плеча, событий в час. Нужна и ДП, и тестам. */
export function baseIntensityPerHour(request = {}, opts = {}) {
  const perDay =
    opts.lambdaPerDay ?? arrivalsPerDayBetween(request.from || 'AST', request.to || 'ALA');
  return perDay / 24;
}

// ---------------------------------------------------------------------
//  МАТЕМАТИКА: НОРМАЛЬНОЕ РАСПРЕДЕЛЕНИЕ
// ---------------------------------------------------------------------

/**
 * Функция ошибок. В стандартном JS её нет, реализуем сами —
 * приближение Абрамовица — Стиган 7.1.26, точность ~1.5e-7.
 * Нужна для аналитической функции распределения логнормального.
 */
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

/** Функция распределения стандартного нормального. */
export function normalCdf(z) {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/** Функция распределения логнормального. */
function lognormalCdf(x, mu, sigma) {
  if (x <= 0) return 0;
  return normalCdf((Math.log(x) - mu) / sigma);
}

// ---------------------------------------------------------------------
//  АНАЛИТИЧЕСКОЕ РАСПРЕДЕЛЕНИЕ ПРИХОДА ЗА ЧАС
// ---------------------------------------------------------------------

/**
 * Дискретное распределение массы ОДНОЙ партии по корзинам ширины binT.
 *
 * Считаем аналитически по функции распределения усечённого логнормального,
 * а не сэмплированием: ДП не должно зависеть от того, сколько раз мы
 * бросили кубик.
 *
 * Корзины ЦЕНТРИРОВАННЫЕ: корзина b представляет массу b·binT и покрывает
 * [b·binT − binT/2, b·binT + binT/2). Это не косметика. При «напольной»
 * разбивке [b·binT, (b+1)·binT) партия в 9 т попала бы в корзину «8 т»,
 * и каждая заявка систематически теряла бы полкорзины массы. На горизонте
 * в двое суток ДП недосчитывало бы вагону около десяти тонн и рекомендовало
 * ждать дольше, чем нужно. Центрирование делает оценку несмещённой.
 *
 * @param {number} binT ширина корзины, тонн
 * @returns {number[]} pmf, индекс = номер корзины, масса корзины = b·binT
 */
export function lotSizePmf(binT = 2) {
  const lo = LOT_MIN_T;
  const hi = LOT_MAX_T;
  // Нормировка на усечение: вероятность попасть в [2,18].
  const mass = lognormalCdf(hi, LOT_MU, LOT_SIGMA) - lognormalCdf(lo, LOT_MU, LOT_SIGMA);

  const nBins = Math.round(hi / binT) + 1;
  const pmf = new Array(nBins).fill(0);

  for (let b = 0; b < nBins; b++) {
    const a = Math.max(lo, b * binT - binT / 2);
    const c = Math.min(hi, b * binT + binT / 2);
    if (c <= a) continue;
    pmf[b] =
      (lognormalCdf(c, LOT_MU, LOT_SIGMA) - lognormalCdf(a, LOT_MU, LOT_SIGMA)) / mass;
  }

  // Аккуратно добираем возможную невязку округления в самую вероятную корзину.
  const s = pmf.reduce((x, y) => x + y, 0);
  if (s > 0) for (let b = 0; b < nBins; b++) pmf[b] /= s;
  return pmf;
}

/** Пуассоновская вероятность ровно k событий при интенсивности λ. */
export function poissonPmf(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  // Через логарифмы: при больших k факториал переполняется.
  let logFact = 0;
  for (let i = 2; i <= k; i++) logFact += Math.log(i);
  return Math.exp(-lambda + k * Math.log(lambda) - logFact);
}

/** Свёртка двух дискретных распределений. */
function convolve(a, b) {
  const out = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === 0) continue;
    for (let j = 0; j < b.length; j++) {
      if (b[j] === 0) continue;
      out[i + j] += a[i] * b[j];
    }
  }
  return out;
}

/**
 * Распределение СУММАРНОЙ массы, пришедшей за один час, по корзинам binT.
 *
 * Смесь по числу заявок: P(Δ) = Σ_k P(k заявок) · P(сумма k партий = Δ).
 * Сумма k партий — k-кратная свёртка распределения размера партии.
 * Обрываем k, когда пуассоновский хвост становится пренебрежимым.
 *
 * @param {number} lambdaHour интенсивность в этот час, событий в час
 * @param {number} binT ширина корзины, тонн
 * @param {number} maxBins сколько корзин оставить (обрезка длинного хвоста)
 * @returns {number[]} pmf по корзинам, pmf[0] = «ничего не пришло»
 */
export function hourlyDeltaPmf(lambdaHour, binT = 2, maxBins = 36) {
  const lot = lotSizePmf(binT);

  // Сколько слагаемых учитывать: до накопления 0.9999 массы Пуассона,
  // но не меньше двух — спецификация требует минимум «ноль, одна, две».
  let kMax = 2;
  let acc = 0;
  for (let k = 0; k <= 12; k++) {
    acc += poissonPmf(k, lambdaHour);
    kMax = Math.max(kMax, k);
    if (acc > 0.9999) break;
  }

  const out = new Array(maxBins).fill(0);
  // k = 0: масса ноль, попадает в нулевую корзину.
  out[0] += poissonPmf(0, lambdaHour);

  let conv = lot.slice(); // распределение суммы одной партии
  for (let k = 1; k <= kMax; k++) {
    const p = poissonPmf(k, lambdaHour);
    if (p > 1e-12) {
      for (let b = 0; b < conv.length; b++) {
        if (conv[b] === 0) continue;
        // Всё, что вылезло за maxBins, сваливаем в последнюю корзину:
        // потерять массу нельзя, распределение должно остаться вероятностным.
        out[Math.min(b, maxBins - 1)] += p * conv[b];
      }
    }
    if (k < kMax) conv = convolve(conv, lot);
  }

  // Хвост Пуассона за kMax: добавляем к последней корзине, чтобы сумма = 1.
  const total = out.reduce((a, b) => a + b, 0);
  if (total < 1) out[maxBins - 1] += 1 - total;
  return out;
}

/**
 * Распределения прихода для каждого часа горизонта.
 * Возвращает массив длины horizonH: элемент t — pmf прихода в час t.
 * Именно это ест ДП в stopping.js.
 */
export function deltaPmfByHour(request = {}, horizonH = 24, opts = {}) {
  const binT = opts.binT ?? 2;
  const maxBins = opts.maxBins ?? 36;
  const startHour = opts.startHour ?? 8;
  const stationary = !!opts.stationary;
  const lambdaBase = baseIntensityPerHour(request, opts);

  // Кэш по интенсивности: часов много, а различных λ всего 24 —
  // без кэша ДП тратит время на пересчёт одних и тех же свёрток.
  const cache = new Map();
  const out = [];
  for (let t = 0; t < horizonH; t++) {
    const lam = stationary ? lambdaBase : lambdaBase * seasonalFactor(t, startHour);
    const key = lam.toFixed(6);
    if (!cache.has(key)) cache.set(key, hourlyDeltaPmf(lam, binT, maxBins));
    out.push(cache.get(key));
  }
  return out;
}

// ---------------------------------------------------------------------
//  ОЦЕНКА ПАРАМЕТРОВ ПО ДАННЫМ
// ---------------------------------------------------------------------

/**
 * Логарифм правдоподобия однородного пуассоновского процесса.
 *
 * Наблюдение: n событий на отрезке [0, T].
 *   L(λ)  = λⁿ · e^(−λT)
 *   ℓ(λ)  = n·ln λ − λT
 * Максимум по λ даёт λ̂ = n/T — но формулу мы не постулируем, а проверяем
 * численно в тестах: аналитический аргмаксимум обязан совпасть с найденным
 * перебором по сетке. Иначе «мы оцениваем параметры из данных» —
 * пустые слова.
 *
 * @param {number} lambda
 * @param {number} n число событий
 * @param {number} T длина отрезка наблюдения
 * @returns {number} ℓ(λ); −Infinity при λ=0 и n>0
 */
export function logLikelihood(lambda, n, T) {
  if (lambda <= 0) return n === 0 ? 0 : -Infinity;
  return n * Math.log(lambda) - lambda * T;
}

/**
 * Оценка интенсивности методом максимального правдоподобия.
 *
 * @param {Array|Object} history массив Arrival[] либо {arrivals, horizonH}
 * @param {Object} [opts]
 * @param {number} [opts.horizonH] длина наблюдения; если не задана —
 *                                 берём время последнего события (смещённая
 *                                 оценка, поэтому предупреждаем полем biased)
 * @returns {{lambdaHat:number, lambdaPerDay:number, n:number, horizonH:number,
 *            logLik:number, stdErr:number, ci95:[number,number], biased:boolean}}
 */
export function estimateIntensity(history, opts = {}) {
  const arrivals = Array.isArray(history) ? history : history?.arrivals || [];
  const n = arrivals.length;

  let T = opts.horizonH ?? (Array.isArray(history) ? null : history?.horizonH) ?? null;
  let biased = false;
  if (T == null) {
    // Без явного горизонта единственное, что известно, — момент последнего
    // события. Оценка по нему завышает λ: наблюдение обрывается на событии.
    T = n > 0 ? Math.max(...arrivals.map((a) => a.atH)) : 0;
    biased = true;
  }

  if (!(T > 0)) {
    return {
      lambdaHat: 0, lambdaPerDay: 0, n, horizonH: 0,
      logLik: 0, stdErr: 0, ci95: [0, 0], biased,
    };
  }

  const lambdaHat = n / T; // аргмаксимум ℓ(λ) = n·ln λ − λT

  // Информация Фишера I(λ) = T/λ ⇒ Var(λ̂) = λ̂/T.
  const stdErr = Math.sqrt(lambdaHat / T);
  const half = 1.96 * stdErr;

  return {
    lambdaHat,
    lambdaPerDay: lambdaHat * 24,
    n,
    horizonH: T,
    logLik: logLikelihood(lambdaHat, n, T),
    stdErr,
    ci95: [Math.max(0, lambdaHat - half), lambdaHat + half],
    biased,
  };
}

/**
 * Численный максимум правдоподобия перебором по сетке.
 * Существует только затем, чтобы тест мог сверить с ним аналитическую
 * формулу: если они разойдутся, значит, вывод где-то неверен.
 */
export function estimateIntensityNumeric(n, T, gridSteps = 20000) {
  if (!(T > 0)) return 0;
  const hi = Math.max(1e-6, (n / T) * 4 + 1);
  let best = 0;
  let bestLL = -Infinity;
  for (let i = 1; i <= gridSteps; i++) {
    const lam = (hi * i) / gridSteps;
    const ll = logLikelihood(lam, n, T);
    if (ll > bestLL) {
      bestLL = ll;
      best = lam;
    }
  }
  return best;
}

// ---------------------------------------------------------------------
//  ОБУЧАЕМАЯ МОДЕЛЬ ИНТЕНСИВНОСТИ
// ---------------------------------------------------------------------
//  Одно число λ на всю сеть — слишком грубо: поток на Астана—Караганда
//  и на Атырау—Актау различается втрое, а вторник в полдень не похож на
//  воскресенье в три ночи. Поэтому обучаем ТАБЛИЦУ интенсивностей:
//  для каждого плеча — 168 ячеек, час недели (7 суток × 24 часа).
//
//  Обучение — максимум правдоподобия по наблюдённой истории. Для
//  пуассоновского процесса оценка в ячейке равна (число событий) /
//  (экспозиция ячейки в часах). Ячеек много, данных в каждой мало,
//  поэтому сырая оценка шумит: одна заявка в четверг в 4 утра дала бы
//  λ = 1/ч, что абсурдно.
//
//  УСАДКА К ОБЩЕМУ СРЕДНЕМУ (эмпирический байес, сопряжённое гамма-
//  априорное распределение). Оценка ячейки притягивается к среднему по
//  плечу тем сильнее, чем меньше в ней экспозиции:
//      λ̂ = (n + α·λ_плечо) / (E + α)
//  При E ≫ α оценка сходится к сырому максимуму правдоподобия, при
//  E → 0 — к среднему по плечу. Параметр α измеряется в часах экспозиции
//  и означает «сколько данных нужно, чтобы ячейка заговорила сама».
// ---------------------------------------------------------------------

/** Часов в неделе — размер таблицы интенсивностей на одно плечо. */
export const HOURS_PER_WEEK = 168;

/**
 * Сила усадки, в часах экспозиции. При 24 часах наблюдений ячейка
 * наполовину доверяет себе и наполовину среднему по плечу.
 */
export const SHRINKAGE_ALPHA = 24;

/** Час недели по времени от начала горизонта. */
export function hourOfWeek(t, startHourOfWeek = 8) {
  const h = Math.floor(t) + startHourOfWeek;
  return ((h % HOURS_PER_WEEK) + HOURS_PER_WEEK) % HOURS_PER_WEEK;
}

/**
 * Обучает модель интенсивности на истории наблюдений.
 *
 * @param {Array} datasets массив наблюдений вида
 *        { corridor:'AST-ALA', arrivals:Arrival[], horizonH:number,
 *          startHourOfWeek?:number }
 * @param {Object} [opts]
 * @param {number} [opts.alpha] сила усадки к среднему по плечу
 * @param {Date}   [opts.now]   момент обучения; по умолчанию стенные часы.
 *        Вынесен в параметр, чтобы функция оставалась чистой: без этого
 *        два обучения на одних данных давали бы разный результат, и
 *        воспроизводимость демо переставала быть полной.
 * @returns {Object} обученная модель
 */
export function trainIntensityModel(datasets = [], opts = {}) {
  const alpha = opts.alpha ?? SHRINKAGE_ALPHA;
  const corridors = {};
  let totalObservations = 0;
  let totalExposure = 0;

  for (const ds of datasets) {
    const key = ds.corridor || `${ds.from || '?'}-${ds.to || '?'}`;
    if (!corridors[key]) {
      corridors[key] = {
        counts: new Array(HOURS_PER_WEEK).fill(0),
        exposure: new Array(HOURS_PER_WEEK).fill(0),
      };
    }
    const c = corridors[key];
    const start = ds.startHourOfWeek ?? 8;
    const H = Math.max(0, ds.horizonH || 0);

    // Экспозиция: сколько часов каждая ячейка реально наблюдалась.
    // Незавершённый последний час учитываем дробно, иначе оценка смещается.
    const whole = Math.floor(H);
    for (let t = 0; t < whole; t++) c.exposure[hourOfWeek(t, start)] += 1;
    const frac = H - whole;
    if (frac > 0) c.exposure[hourOfWeek(whole, start)] += frac;

    for (const a of ds.arrivals || []) {
      if (a.atH < 0 || a.atH >= H) continue;
      c.counts[hourOfWeek(a.atH, start)] += 1;
      totalObservations += 1;
    }
    totalExposure += H;
  }

  // Сглаживание и подсчёт правдоподобия обученной модели.
  let logLik = 0;
  const table = {};
  for (const [key, c] of Object.entries(corridors)) {
    const n = c.counts.reduce((a, b) => a + b, 0);
    const E = c.exposure.reduce((a, b) => a + b, 0);
    // Общее среднее по плечу — цель усадки.
    const lambdaCorridor = E > 0 ? n / E : 0;

    const lambdas = new Array(HOURS_PER_WEEK);
    for (let h = 0; h < HOURS_PER_WEEK; h++) {
      lambdas[h] = (c.counts[h] + alpha * lambdaCorridor) / (c.exposure[h] + alpha);
      // Вклад ячейки в логарифм правдоподобия модели: n·ln λ − λ·E
      logLik += logLikelihood(lambdas[h], c.counts[h], c.exposure[h]);
    }

    table[key] = {
      lambdaByHourOfWeek: lambdas,
      lambdaCorridor,
      observations: n,
      exposureH: E,
      counts: c.counts,
      exposure: c.exposure,
    };
  }

  return {
    table,
    alpha,
    observations: totalObservations,
    exposureH: totalExposure,
    logLikelihood: logLik,
    trainedAt: (opts.now || new Date()).toISOString(),
  };
}

/**
 * Интенсивность из обученной модели, событий в час.
 * Неизвестное плечо или необученная модель — откат на статическую
 * оценку из сети: продукт обязан работать и без обучения.
 */
export function modelIntensity(model, corridorKey, hourOfWeekIdx, fallbackPerHour = null) {
  const entry = model?.table?.[corridorKey];
  if (!entry) {
    return fallbackPerHour ?? 0;
  }
  const h = ((hourOfWeekIdx % HOURS_PER_WEEK) + HOURS_PER_WEEK) % HOURS_PER_WEEK;
  return entry.lambdaByHourOfWeek[h];
}

/**
 * Сводка об обученной модели для интерфейса.
 * @returns {{observations:number, corridors:number, logLikelihood:number,
 *            trainedAt:string|null, cells:number, exposureH:number,
 *            corridorNames:string[], alpha:number}}
 */
export function getModelInfo(model) {
  if (!model || !model.table) {
    return {
      observations: 0,
      corridors: 0,
      logLikelihood: 0,
      trainedAt: null,
      cells: 0,
      exposureH: 0,
      corridorNames: [],
      alpha: SHRINKAGE_ALPHA,
    };
  }
  const names = Object.keys(model.table);
  return {
    observations: model.observations,
    corridors: names.length,
    logLikelihood: model.logLikelihood,
    trainedAt: model.trainedAt,
    cells: names.length * HOURS_PER_WEEK,
    exposureH: model.exposureH,
    corridorNames: names,
    alpha: model.alpha,
  };
}

/**
 * Удобная обёртка: сгенерировать историю по плечам и обучить на ней модель.
 * Используется интерфейсом на старте, чтобы показать «модель обучена
 * на N наблюдениях», и тестами для проверки сходимости.
 */
export function trainOnSimulatedHistory(corridorPairs, weeks = 4, seed = 'train', opts = {}) {
  const horizonH = weeks * HOURS_PER_WEEK;
  const datasets = corridorPairs.map(([from, to]) => ({
    corridor: `${from}-${to}`,
    from,
    to,
    horizonH,
    startHourOfWeek: 8,
    arrivals: simulateArrivals({ from, to }, horizonH, `${seed}:${from}-${to}`),
  }));
  return trainIntensityModel(datasets, opts);
}

/**
 * Оценка суточного профиля по данным: для каждого часа суток —
 * своя интенсивность методом максимального правдоподобия.
 *
 * Для часа суток h экспозиция равна числу раз, которое этот час встретился
 * на горизонте. λ̂(h) = (событий в час h) / (экспозиция h).
 * Возвращаем профиль, нормированный к среднему 1, — в том же виде,
 * в каком его задаёт HOURLY_SEASONALITY, чтобы их можно было сравнить.
 *
 * @returns {{profile:number[], counts:number[], exposure:number[], lambdaMean:number}}
 */
export function estimateSeasonalProfile(arrivals, horizonH, startHour = 8) {
  const counts = new Array(24).fill(0);
  const exposure = new Array(24).fill(0);

  for (let t = 0; t < Math.floor(horizonH); t++) {
    exposure[((t + startHour) % 24 + 24) % 24] += 1;
  }
  // Незавершённый последний час учитываем дробно, иначе профиль смещается.
  const frac = horizonH - Math.floor(horizonH);
  if (frac > 0) exposure[((Math.floor(horizonH) + startHour) % 24 + 24) % 24] += frac;

  for (const a of arrivals) {
    counts[((Math.floor(a.atH) + startHour) % 24 + 24) % 24] += 1;
  }

  const lambdas = counts.map((c, h) => (exposure[h] > 0 ? c / exposure[h] : 0));
  const mean = lambdas.reduce((a, b) => a + b, 0) / 24;
  const profile = mean > 0 ? lambdas.map((l) => l / mean) : new Array(24).fill(1);

  return { profile, counts, exposure, lambdaMean: mean };
}
