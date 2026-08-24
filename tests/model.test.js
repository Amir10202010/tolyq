// Тесты обучаемой модели интенсивности: таблица 168 ячеек на плечо,
// максимум правдоподобия, усадка к среднему при малой выборке.
import { suite, test, assert, equal, close, lessOrEqual, greaterOrEqual } from './harness.js';
import {
  trainIntensityModel,
  trainOnSimulatedHistory,
  modelIntensity,
  getModelInfo,
  hourOfWeek,
  simulateArrivals,
  HOURS_PER_WEEK,
  SHRINKAGE_ALPHA,
} from '../src/core/market.js';

const dataset = (from, to, weeks, seed, opts = {}) => {
  const horizonH = weeks * HOURS_PER_WEEK;
  return {
    corridor: `${from}-${to}`,
    from,
    to,
    horizonH,
    startHourOfWeek: 8,
    arrivals: simulateArrivals({ from, to }, horizonH, seed, opts),
  };
};

suite('market.js — час недели', () => {
  test('hourOfWeek цикличен с периодом 168', () => {
    equal(hourOfWeek(0, 0), 0);
    equal(hourOfWeek(HOURS_PER_WEEK, 0), 0);
    equal(hourOfWeek(HOURS_PER_WEEK + 5, 0), 5);
    equal(hourOfWeek(-1, 0), HOURS_PER_WEEK - 1, 'отрицательное время не должно ломать индекс');
  });

  test('смещение стартового часа сдвигает индекс', () => {
    equal(hourOfWeek(0, 8), 8);
    equal(hourOfWeek(10, 8), 18);
  });
});

suite('market.js — обучение модели интенсивности', () => {
  test('модель обучается и имеет 168 ячеек на каждое плечо', () => {
    const m = trainIntensityModel([dataset('AST', 'ALA', 4, 'm1')]);
    const info = getModelInfo(m);
    equal(info.corridors, 1);
    equal(info.cells, HOURS_PER_WEEK);
    equal(m.table['AST-ALA'].lambdaByHourOfWeek.length, HOURS_PER_WEEK);
    assert(info.observations > 0, 'наблюдения должны быть подсчитаны');
    assert(typeof info.trainedAt === 'string', 'время обучения должно быть проставлено');
  });

  test('getModelInfo отдаёт все поля контракта', () => {
    const m = trainIntensityModel([dataset('AST', 'ALA', 2, 'm2'), dataset('AST', 'KGF', 2, 'm3')]);
    const info = getModelInfo(m);
    for (const k of ['observations', 'corridors', 'logLikelihood', 'trainedAt']) {
      assert(k in info, `в сводке нет поля ${k}`);
    }
    equal(info.corridors, 2);
    assert(Number.isFinite(info.logLikelihood), 'правдоподобие должно быть числом');
    assert(info.corridorNames.includes('AST-ALA') && info.corridorNames.includes('AST-KGF'));
  });

  test('число наблюдений совпадает с числом заявок в истории', () => {
    const ds = [dataset('AST', 'ALA', 3, 'm4'), dataset('ATX', 'SCO', 3, 'm5')];
    const m = trainIntensityModel(ds);
    const expected = ds.reduce((s, d) => s + d.arrivals.length, 0);
    equal(getModelInfo(m).observations, expected);
  });

  test('интенсивность плеча восстанавливается из данных', () => {
    // Берём ПРЯМОЕ плечо: AST–KGF задано в сети как 7.0 заявок в сутки.
    // Для пары без прямого ребра (AST–ALA) сеть отдаёт усреднённую оценку,
    // и сверять её с тарифом конкретного коридора было бы бессмысленно.
    const m = trainIntensityModel([dataset('AST', 'KGF', 30, 'm6')]);
    const entry = m.table['AST-KGF'];
    close(entry.lambdaCorridor * 24, 7.0, 0.8, 'суточная интенсивность плеча не восстановилась');
  });

  test('модель различает плечи с разной загрузкой', () => {
    // AST–KGF (7.0/сут) должно быть заметно плотнее ATX–SCO (2.0/сут)
    const m = trainIntensityModel([
      dataset('AST', 'KGF', 20, 'm7'),
      dataset('ATX', 'SCO', 20, 'm8'),
    ]);
    const busy = m.table['AST-KGF'].lambdaCorridor;
    const quiet = m.table['ATX-SCO'].lambdaCorridor;
    greaterOrEqual(busy / quiet, 2.2, 'модель не различает загруженность плеч');
  });

  test('обученная таблица воспроизводит суточную сезонность', () => {
    const m = trainIntensityModel([dataset('AST', 'ALA', 40, 'm9')]);
    const lam = m.table['AST-ALA'].lambdaByHourOfWeek;

    // Собираем по часу суток, усредняя по дням недели
    const byHourOfDay = new Array(24).fill(0);
    for (let h = 0; h < HOURS_PER_WEEK; h++) byHourOfDay[h % 24] += lam[h] / 7;

    // Индекс ячейки h связан со временем как h = (t + 8) mod 168, а час
    // суток в генераторе — (t + 8) mod 24. Значит h mod 24 И ЕСТЬ час суток,
    // никакого дополнительного сдвига добавлять не нужно.
    // Час 10 — пик профиля (2.20), час 3 — глубокая ночь (0.08).
    greaterOrEqual(byHourOfDay[10] / byHourOfDay[3], 3,
      'дневной пик не отличается от ночного затишья');
  });

  test('усадка: пустая ячейка притягивается к среднему по плечу', () => {
    const m = trainIntensityModel([dataset('AST', 'ALA', 2, 'm10')]);
    const e = m.table['AST-ALA'];
    // Найдём ячейку без единого события
    const empty = e.counts.findIndex((c, i) => c === 0 && e.exposure[i] > 0);
    assert(empty >= 0, 'при короткой истории пустые ячейки обязаны быть');
    // Оценка не ноль — усадка подтянула её к среднему
    assert(e.lambdaByHourOfWeek[empty] > 0, 'пустая ячейка получила нулевую интенсивность');
    lessOrEqual(
      e.lambdaByHourOfWeek[empty],
      e.lambdaCorridor,
      'усадка не может поднять пустую ячейку выше среднего'
    );
  });

  test('усадка ослабевает с ростом выборки', () => {
    // При длинной истории ячейка доверяет себе, при короткой — среднему
    const short = trainIntensityModel([dataset('AST', 'ALA', 2, 'm11')]).table['AST-ALA'];
    const long = trainIntensityModel([dataset('AST', 'ALA', 60, 'm11')]).table['AST-ALA'];

    const spread = (e) => {
      const l = e.lambdaByHourOfWeek;
      const mean = l.reduce((a, b) => a + b, 0) / l.length;
      return Math.sqrt(l.reduce((s, v) => s + (v - mean) ** 2, 0) / l.length) / mean;
    };
    greaterOrEqual(
      spread(long),
      spread(short),
      'длинная история должна давать более выраженный профиль, а не более сглаженный'
    );
  });

  test('сильная усадка стягивает таблицу к константе', () => {
    const ds = [dataset('AST', 'ALA', 4, 'm12')];
    const soft = trainIntensityModel(ds, { alpha: 1 }).table['AST-ALA'].lambdaByHourOfWeek;
    const hard = trainIntensityModel(ds, { alpha: 10000 }).table['AST-ALA'].lambdaByHourOfWeek;
    const range = (l) => Math.max(...l) - Math.min(...l);
    assert(range(hard) < range(soft), 'усиление усадки не сгладило таблицу');
  });

  test('правдоподобие растёт при ослаблении усадки на тех же данных', () => {
    // Менее сглаженная модель ближе к максимуму правдоподобия по выборке
    const ds = [dataset('AST', 'ALA', 6, 'm13')];
    const soft = trainIntensityModel(ds, { alpha: 1 });
    const hard = trainIntensityModel(ds, { alpha: 500 });
    greaterOrEqual(
      soft.logLikelihood,
      hard.logLikelihood,
      'слабая усадка обязана давать не меньшее правдоподобие на обучающей выборке'
    );
  });

  test('modelIntensity возвращает значение обученной ячейки', () => {
    const m = trainIntensityModel([dataset('AST', 'ALA', 5, 'm14')]);
    const v = modelIntensity(m, 'AST-ALA', 42);
    close(v, m.table['AST-ALA'].lambdaByHourOfWeek[42], 1e-12);
    assert(v > 0, 'интенсивность должна быть положительной');
  });

  test('неизвестное плечо — откат, а не падение', () => {
    const m = trainIntensityModel([dataset('AST', 'ALA', 2, 'm15')]);
    equal(modelIntensity(m, 'НЕТ-ТАКОГО', 10, 0.25), 0.25, 'должен сработать откат');
    equal(modelIntensity(null, 'AST-ALA', 10, 0.3), 0.3, 'без модели тоже откат');
  });

  test('индекс часа за пределами недели заворачивается', () => {
    const m = trainIntensityModel([dataset('AST', 'ALA', 3, 'm16')]);
    close(modelIntensity(m, 'AST-ALA', 5), modelIntensity(m, 'AST-ALA', 5 + HOURS_PER_WEEK), 1e-12);
    assert(Number.isFinite(modelIntensity(m, 'AST-ALA', -3)), 'отрицательный индекс не должен ломать');
  });

  test('пустое обучение даёт валидную пустую сводку', () => {
    const info = getModelInfo(trainIntensityModel([]));
    equal(info.observations, 0);
    equal(info.corridors, 0);
    equal(getModelInfo(null).trainedAt, null, 'без модели сводка тоже должна собираться');
  });

  test('заявки за пределами горизонта в обучение не попадают', () => {
    const arrivals = [{ atH: -5 }, { atH: 10 }, { atH: 500 }];
    const m = trainIntensityModel([{ corridor: 'X-Y', horizonH: 100, arrivals }]);
    equal(getModelInfo(m).observations, 1, 'учтена должна быть только заявка внутри горизонта');
  });

  test('trainOnSimulatedHistory обучает по списку плеч', () => {
    const m = trainOnSimulatedHistory([['AST', 'ALA'], ['AST', 'KGF'], ['ALA', 'KHG']], 3, 'hist');
    const info = getModelInfo(m);
    equal(info.corridors, 3);
    equal(info.cells, 3 * HOURS_PER_WEEK);
    assert(info.observations > 50, 'за три недели по трём плечам заявок должно быть много');
    assert(info.exposureH > 0);
  });

  test('обучение по умолчанию использует объявленную силу усадки', () => {
    equal(trainIntensityModel([dataset('AST', 'ALA', 2, 'm17')]).alpha, SHRINKAGE_ALPHA);
  });
});
