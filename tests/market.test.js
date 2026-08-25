// Тесты потока попутных грузов: сходимость к теории, форма распределений,
// оценка параметров по данным.
import { suite, test, assert, equal, close, lessOrEqual, greaterOrEqual } from './harness.js';
import {
  simulateArrivals,
  HOURLY_SEASONALITY,
  seasonalFactor,
  lotSizePmf,
  hourlyDeltaPmf,
  deltaPmfByHour,
  poissonPmf,
  logLikelihood,
  estimateIntensity,
  estimateIntensityNumeric,
  estimateSeasonalProfile,
  baseIntensityPerHour,
  normalCdf,
  LOT_MIN_T,
  LOT_MAX_T,
  LOT_MEDIAN_T,
  SHIPPERS,
  M3_PER_TON,
} from '../src/core/market.js';
import { m3PerTon, MARKET_M3_PER_TON } from '../src/core/network.js';

const req = { from: 'AST', to: 'ALA', tons: 8, volumeM3: 52 };

suite('market.js — сезонность', () => {
  test('профиль состоит из 24 значений со средним ровно 1', () => {
    equal(HOURLY_SEASONALITY.length, 24);
    const mean = HOURLY_SEASONALITY.reduce((a, b) => a + b, 0) / 24;
    close(mean, 1, 1e-12, 'нормировка профиля обязана давать среднее 1');
  });

  test('днём заявок в разы больше, чем ночью', () => {
    const night = Math.min(...HOURLY_SEASONALITY.slice(1, 5));
    const day = Math.max(...HOURLY_SEASONALITY.slice(9, 18));
    greaterOrEqual(day / night, 10, 'суточный контраст должен быть выраженным');
  });

  test('обеденный провал существует', () => {
    assert(HOURLY_SEASONALITY[12] < HOURLY_SEASONALITY[11], 'в 12 должно быть меньше, чем в 11');
    assert(HOURLY_SEASONALITY[12] < HOURLY_SEASONALITY[14], 'в 12 должно быть меньше, чем в 14');
  });

  test('seasonalFactor цикличен по суткам и устойчив к отрицательному времени', () => {
    close(seasonalFactor(0, 8), seasonalFactor(24, 8), 1e-12, 'период должен быть 24 ч');
    assert(Number.isFinite(seasonalFactor(-5, 8)), 'отрицательное время не должно ломать индекс');
  });
});

suite('market.js — генерация потока', () => {
  test('один seed — идентичный поток', () => {
    const a = simulateArrivals(req, 72, 'x1');
    const b = simulateArrivals(req, 72, 'x1');
    equal(JSON.stringify(a), JSON.stringify(b), 'поток должен быть воспроизводим');
  });

  test('разные seed — разные потоки', () => {
    const a = simulateArrivals(req, 72, 'x1');
    const b = simulateArrivals(req, 72, 'x2');
    assert(JSON.stringify(a) !== JSON.stringify(b));
  });

  test('заявки отсортированы по времени и лежат внутри горизонта', () => {
    const arr = simulateArrivals(req, 48, 's');
    for (let i = 1; i < arr.length; i++) {
      greaterOrEqual(arr[i].atH, arr[i - 1].atH, 'поток не отсортирован');
    }
    for (const a of arr) {
      greaterOrEqual(a.atH, 0);
      assert(a.atH < 48, 'заявка вылезла за горизонт');
    }
  });

  test('среднее число прибытий за длинный горизонт сходится к теоретическому', () => {
    // Профиль нормирован к среднему 1, значит за сутки ожидаем ровно perDay.
    const perDay = 6;
    const days = 400;
    const arr = simulateArrivals(req, 24 * days, 'conv', { lambdaPerDay: perDay });
    const actualPerDay = arr.length / days;
    close(actualPerDay, perDay, 0.25, 'интенсивность потока не сходится к заданной');
  });

  test('сезонность действительно воспроизводится в выборке', () => {
    const arr = simulateArrivals(req, 24 * 500, 'season', { lambdaPerDay: 8 });
    const { profile } = estimateSeasonalProfile(arr, 24 * 500, 8);
    // Сверяем восстановленный профиль с заданным: расхождение по всем часам
    let maxDev = 0;
    for (let h = 0; h < 24; h++) {
      maxDev = Math.max(maxDev, Math.abs(profile[h] - HOURLY_SEASONALITY[h]));
    }
    lessOrEqual(maxDev, 0.35, `профиль восстановился плохо, отклонение ${maxDev.toFixed(2)}`);
  });

  test('размер партии всегда в границах обрезки', () => {
    const arr = simulateArrivals(req, 24 * 200, 'lots', { lambdaPerDay: 8 });
    assert(arr.length > 500, 'мало данных для проверки');
    for (const a of arr) {
      greaterOrEqual(a.tons, LOT_MIN_T, 'партия легче нижней границы');
      lessOrEqual(a.tons, LOT_MAX_T, 'партия тяжелее верхней границы');
    }
  });

  test('медиана размера партии близка к заявленным 9 тоннам', () => {
    const arr = simulateArrivals(req, 24 * 300, 'med', { lambdaPerDay: 8 });
    const sorted = arr.map((a) => a.tons).sort((x, y) => x - y);
    const median = sorted[Math.floor(sorted.length / 2)];
    close(median, LOT_MEDIAN_T, 0.6, 'медиана уехала от 9 т');
  });

  test('обрезка не создаёт ложных пиков на границах', () => {
    // Зажим вместо пересэмплирования дал бы кучу значений ровно в 2 и 18
    const arr = simulateArrivals(req, 24 * 300, 'clamp', { lambdaPerDay: 8 });
    const atEdges = arr.filter((a) => a.tons <= LOT_MIN_T + 0.01 || a.tons >= LOT_MAX_T - 0.01);
    lessOrEqual(atEdges.length / arr.length, 0.01, 'на границах скопилась масса — похоже на зажим');
  });

  test('плотность соответствует типу груза', () => {
    const arr = simulateArrivals(req, 24 * 300, 'vol', { lambdaPerDay: 8 });
    const byType = { food: [], general: [], chemical: [] };
    for (const a of arr) {
      const density = a.volumeM3 / a.tons;
      // Шум укладки ±12 % с обрезкой снизу на 0.6 — за эти рамки выходить нельзя
      greaterOrEqual(density, m3PerTon(a.cargoType) * 0.5, 'нереально плотный груз');
      lessOrEqual(density, m3PerTon(a.cargoType) * 1.7, 'нереально рыхлый груз');
      byType[a.cargoType].push(density);
    }
    for (const t of ['food', 'general', 'chemical']) {
      const mean = byType[t].reduce((x, y) => x + y, 0) / byType[t].length;
      close(mean, m3PerTon(t), 0.15, `средняя плотность для ${t}`);
    }
    // Зерно плотнее генерального груза — это и определяет, чем кончится вагон
    assert(m3PerTon('food') < m3PerTon('general'), 'продукты должны быть плотнее генгруза');
  });

  test('средняя плотность потока согласована с весами типов', () => {
    const arr = simulateArrivals(req, 24 * 400, 'mix', { lambdaPerDay: 8 });
    const mean = arr.reduce((s, a) => s + a.volumeM3 / a.tons, 0) / arr.length;
    close(mean, MARKET_M3_PER_TON, 0.12, 'среднерыночная плотность разошлась с потоком');
  });

  test('типы груза распределены 0.6 / 0.3 / 0.1', () => {
    const arr = simulateArrivals(req, 24 * 500, 'types', { lambdaPerDay: 8 });
    const c = { general: 0, food: 0, chemical: 0 };
    for (const a of arr) c[a.cargoType]++;
    const n = arr.length;
    close(c.general / n, 0.6, 0.03, 'доля general');
    close(c.food / n, 0.3, 0.03, 'доля food');
    close(c.chemical / n, 0.1, 0.02, 'доля chemical');
  });

  test('отправители берутся из списка и список достаточно разнообразен', () => {
    equal(SHIPPERS.length, 15, 'должно быть 15 отправителей');
    const arr = simulateArrivals(req, 24 * 100, 'ship', { lambdaPerDay: 8 });
    const used = new Set(arr.map((a) => a.shipper));
    for (const s of used) assert(SHIPPERS.includes(s), `неизвестный отправитель ${s}`);
    greaterOrEqual(used.size, 12, 'выборка должна покрывать почти весь список');
  });

  test('каждая заявка соответствует контракту Arrival', () => {
    const arr = simulateArrivals(req, 48, 'shape');
    for (const a of arr) {
      for (const k of ['atH', 'tons', 'volumeM3', 'cargoType', 'shipper', 'accepted']) {
        assert(k in a, `в заявке нет поля ${k}`);
      }
      equal(a.accepted, false, 'accepted проставляет packing, здесь должно быть false');
    }
  });

  test('вырожденные горизонты не роняют генератор', () => {
    equal(simulateArrivals(req, 0, 's').length, 0);
    equal(simulateArrivals(req, -10, 's').length, 0);
    equal(simulateArrivals(req, 48, 's', { lambdaPerDay: 0 }).length, 0);
  });
});

suite('market.js — аналитические распределения', () => {
  test('normalCdf симметрична и имеет верные опорные значения', () => {
    close(normalCdf(0), 0.5, 1e-6);
    close(normalCdf(1.96), 0.975, 1e-3);
    close(normalCdf(-1.96), 0.025, 1e-3);
    close(normalCdf(1) + normalCdf(-1), 1, 1e-6, 'нарушена симметрия');
  });

  test('poissonPmf — корректное распределение', () => {
    const lam = 2.5;
    let s = 0;
    for (let k = 0; k <= 40; k++) s += poissonPmf(k, lam);
    close(s, 1, 1e-9, 'сумма вероятностей должна быть 1');
    close(poissonPmf(0, lam), Math.exp(-lam), 1e-12);
    // Среднее пуассоновского равно λ
    let m = 0;
    for (let k = 0; k <= 60; k++) m += k * poissonPmf(k, lam);
    close(m, lam, 1e-6, 'среднее должно равняться λ');
  });

  test('poissonPmf при λ=0 вырождается в точку 0', () => {
    equal(poissonPmf(0, 0), 1);
    equal(poissonPmf(3, 0), 0);
  });

  test('lotSizePmf — вероятностное распределение с верной поддержкой', () => {
    const pmf = lotSizePmf(2);
    close(pmf.reduce((a, b) => a + b, 0), 1, 1e-9, 'сумма pmf должна быть 1');
    for (const p of pmf) greaterOrEqual(p, 0, 'отрицательная вероятность');
    // Корзина 0 (масса 0) пуста: минимальная партия 2 т попадает в корзину 1
    equal(pmf[0], 0, 'нулевая корзина должна означать «заявок не было»');
    for (let b = Math.round(LOT_MAX_T / 2) + 1; b < pmf.length; b++) {
      close(pmf[b], 0, 1e-12, `корзина ${b} выше обрезки должна быть пуста`);
    }
  });

  test('центрированные корзины дают несмещённое среднее', () => {
    // Проверяем, что дискретизация не теряет массу: аналитическое среднее
    // усечённого логнормального против среднего по корзинам
    const binT = 2;
    const pmf = lotSizePmf(binT);
    let binned = 0;
    for (let b = 0; b < pmf.length; b++) binned += pmf[b] * b * binT;
    // Опорное значение — среднее выборки того же распределения
    const arr = simulateArrivals(req, 24 * 500, 'unbiased', { lambdaPerDay: 8 });
    const sample = arr.reduce((s, a) => s + a.tons, 0) / arr.length;
    close(binned, sample, 0.15, `смещение дискретизации ${(binned - sample).toFixed(3)} т`);
  });

  test('среднее аналитического lotSizePmf сходится с выборочным', () => {
    const binT = 2;
    const pmf = lotSizePmf(binT);
    let analytic = 0;
    for (let b = 0; b < pmf.length; b++) analytic += pmf[b] * b * binT;

    const arr = simulateArrivals(req, 24 * 400, 'mean-check', { lambdaPerDay: 8 });
    const empirical = arr.reduce((s, a) => s + a.tons, 0) / arr.length;
    close(analytic, empirical, 0.3, 'аналитика и выборка расходятся — где-то разные параметры');
  });

  test('hourlyDeltaPmf — вероятностное распределение', () => {
    for (const lam of [0, 0.05, 0.25, 1, 3]) {
      const pmf = hourlyDeltaPmf(lam, 2, 36);
      close(pmf.reduce((a, b) => a + b, 0), 1, 1e-9, `сумма pmf при λ=${lam}`);
      for (const p of pmf) greaterOrEqual(p, -1e-15, 'отрицательная вероятность');
    }
  });

  test('вероятность нулевого прихода равна e^(−λ)', () => {
    for (const lam of [0.1, 0.5, 2]) {
      const pmf = hourlyDeltaPmf(lam, 2, 36);
      // В нулевую корзину попадает только «ни одной заявки»:
      // минимальная партия 2 т попадает уже в корзину 1
      close(pmf[0], Math.exp(-lam), 1e-6, `P(нет заявок) при λ=${lam}`);
    }
  });

  test('среднее часового прихода равно λ × средний размер партии', () => {
    const binT = 2;
    const lam = 0.4;
    const lot = lotSizePmf(binT);
    let lotMean = 0;
    for (let b = 0; b < lot.length; b++) lotMean += lot[b] * b * binT;

    const pmf = hourlyDeltaPmf(lam, binT, 60);
    let mean = 0;
    for (let b = 0; b < pmf.length; b++) mean += pmf[b] * b * binT;

    // Тождество Вальда: E[сумма] = E[число слагаемых] × E[слагаемое].
    // Корзины центрированы, поэтому поправка на дискретизацию не нужна.
    close(mean, lam * lotMean, 0.02, 'закон Вальда не выполняется');
  });

  test('при λ=0 приход детерминированно нулевой', () => {
    const pmf = hourlyDeltaPmf(0, 2, 36);
    equal(pmf[0], 1);
    for (let b = 1; b < pmf.length; b++) close(pmf[b], 0, 1e-15);
  });

  test('deltaPmfByHour отдаёт по распределению на каждый час', () => {
    const byHour = deltaPmfByHour(req, 30, { startHour: 8 });
    equal(byHour.length, 30);
    for (const pmf of byHour) close(pmf.reduce((a, b) => a + b, 0), 1, 1e-9);
    // Ночной час должен давать больше вероятности «ничего не пришло», чем дневной
    const dayIdx = 3; // 11:00
    const nightIdx = 18; // 02:00
    assert(byHour[nightIdx][0] > byHour[dayIdx][0], 'ночью пустых часов должно быть больше');
  });

  test('deltaPmfByHour согласован с базовой интенсивностью плеча', () => {
    const lam = baseIntensityPerHour(req);
    assert(lam > 0, 'интенсивность плеча должна быть положительной');
    const byHour = deltaPmfByHour(req, 24);
    let expected = 0;
    for (let t = 0; t < 24; t++) expected += 1 - byHour[t][0];
    assert(expected > 0, 'за сутки должна быть ненулевая вероятность прихода');
  });
});

suite('market.js — оценка параметров по данным', () => {
  test('логарифм правдоподобия максимален в точке n/T', () => {
    const n = 137;
    const T = 500;
    const mle = n / T;
    for (const d of [0.5, 0.8, 0.95, 1.05, 1.2, 2]) {
      if (Math.abs(d - 1) < 1e-9) continue;
      assert(
        logLikelihood(mle, n, T) > logLikelihood(mle * d, n, T),
        `ℓ(λ̂) должно быть больше ℓ(${d}·λ̂)`
      );
    }
  });

  test('аналитическая оценка совпадает с численным максимумом', () => {
    for (const [n, T] of [[10, 100], [137, 500], [1000, 240], [3, 7]]) {
      const numeric = estimateIntensityNumeric(n, T);
      close(numeric, n / T, (n / T) * 0.01, `расхождение при n=${n}, T=${T}`);
    }
  });

  test('логарифм правдоподобия корректен на вырожденных входах', () => {
    equal(logLikelihood(0, 0, 100), 0, 'нет событий при λ=0 — правдоподобие 1');
    equal(logLikelihood(0, 5, 100), -Infinity, 'события при λ=0 невозможны');
  });

  test('оценка λ по 1000 наблюдениям попадает в 5 % от истинного', () => {
    const perDay = 8;
    const trueLambda = perDay / 24; // событий в час
    // Горизонт подобран так, чтобы набралось около 1000 наблюдений
    const horizon = Math.round(1000 / trueLambda);
    const arr = simulateArrivals(req, horizon, 'mle-1000', { lambdaPerDay: perDay });
    greaterOrEqual(arr.length, 800, 'слишком мало наблюдений для теста');

    const est = estimateIntensity(arr, { horizonH: horizon });
    const relErr = Math.abs(est.lambdaHat - trueLambda) / trueLambda;
    lessOrEqual(relErr, 0.05, `относительная ошибка ${(relErr * 100).toFixed(1)} % > 5 %`);
    equal(est.biased, false, 'при явном горизонте оценка не смещена');
  });

  test('оценка сходится: ошибка убывает с ростом выборки', () => {
    const perDay = 8;
    const trueLambda = perDay / 24;
    const errs = [];
    for (const horizon of [200, 2000, 20000]) {
      // Усредняем по нескольким seed, чтобы не поймать случайную удачу
      let acc = 0;
      const reps = 5;
      for (let r = 0; r < reps; r++) {
        const arr = simulateArrivals(req, horizon, `conv-${horizon}-${r}`, { lambdaPerDay: perDay });
        const est = estimateIntensity(arr, { horizonH: horizon });
        acc += Math.abs(est.lambdaHat - trueLambda) / trueLambda;
      }
      errs.push(acc / reps);
    }
    assert(errs[1] < errs[0], `ошибка не убывает: ${errs.map((e) => e.toFixed(4)).join(' → ')}`);
    assert(errs[2] < errs[1], `ошибка не убывает: ${errs.map((e) => e.toFixed(4)).join(' → ')}`);
    // Скорость сходимости 1/√T: рост выборки в 100 раз даёт ~10-кратное падение ошибки
    greaterOrEqual(errs[0] / errs[2], 4, 'сходимость медленнее, чем 1/√T — подозрительно');
  });

  test('доверительный интервал накрывает истинное значение', () => {
    const perDay = 8;
    const trueLambda = perDay / 24;
    let covered = 0;
    const reps = 40;
    for (let r = 0; r < reps; r++) {
      const arr = simulateArrivals(req, 3000, `ci-${r}`, { lambdaPerDay: perDay });
      const est = estimateIntensity(arr, { horizonH: 3000 });
      if (trueLambda >= est.ci95[0] && trueLambda <= est.ci95[1]) covered++;
    }
    greaterOrEqual(covered / reps, 0.85, `95 %-интервал накрыл только ${covered}/${reps}`);
  });

  test('без явного горизонта оценка помечается смещённой', () => {
    const arr = simulateArrivals(req, 500, 'biased', { lambdaPerDay: 8 });
    const est = estimateIntensity(arr);
    equal(est.biased, true, 'должен быть выставлен флаг смещения');
    assert(est.lambdaHat > 0);
  });

  test('пустая история не роняет оценку', () => {
    const est = estimateIntensity([]);
    equal(est.n, 0);
    equal(est.lambdaHat, 0);
    assert(Number.isFinite(est.logLik));
  });

  test('оценка принимает и объект {arrivals, horizonH}', () => {
    const arrivals = simulateArrivals(req, 1000, 'obj', { lambdaPerDay: 8 });
    const a = estimateIntensity(arrivals, { horizonH: 1000 });
    const b = estimateIntensity({ arrivals, horizonH: 1000 });
    close(a.lambdaHat, b.lambdaHat, 1e-12);
  });

  test('lambdaPerDay согласован с почасовой оценкой', () => {
    const arr = simulateArrivals(req, 2400, 'perday', { lambdaPerDay: 8 });
    const est = estimateIntensity(arr, { horizonH: 2400 });
    close(est.lambdaPerDay, est.lambdaHat * 24, 1e-12);
    close(est.lambdaPerDay, 8, 0.8, 'восстановленная суточная интенсивность');
  });
});
