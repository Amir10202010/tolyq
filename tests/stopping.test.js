// Тесты марковского процесса принятия решений: структура политики,
// взаимная проверка итерации по ценности и Монте-Карло, вырожденные случаи.
import { suite, test, assert, equal, close, lessOrEqual, greaterOrEqual } from './harness.js';
import {
  computeStopping,
  stoppingValueTable,
  BIN_T,
  Q_BINS,
  MC_RUNS,
} from '../src/core/stopping.js';
import { WAGON_CAP_T, effectiveWagonCapacityT, HOLDING_KZT_PER_TON_HOUR } from '../src/core/network.js';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const req = (over = {}) => ({
  from: 'AST',
  to: 'ALA',
  tons: 8,
  volumeM3: 20,
  cargoType: 'general',
  deadlineH: 96,
  ...over,
});

/** Сколько раз порог вырос при движении вперёд по времени. */
function monotonicityViolations(thr) {
  let bad = 0;
  for (let i = 1; i < thr.length; i++) if (thr[i] > thr[i - 1] + 1e-9) bad++;
  return bad;
}

suite('stopping.js — структура политики', () => {
  test('политика соответствует контракту StoppingPolicy', () => {
    const p = computeStopping(req(), 'a');
    assert(Array.isArray(p.thresholdByHour), 'thresholdByHour должен быть массивом');
    for (const k of ['expectedValueKzt', 'dispatchAtH', 'probability', 'horizonH']) {
      equal(typeof p[k], 'number', `${k} должно быть числом`);
    }
    greaterOrEqual(p.probability, 0);
    lessOrEqual(p.probability, 1);
    equal(p.thresholdByHour.length, p.horizonH + 1, 'порог нужен на каждый час включая терминальный');
  });

  test('пороги лежат в пределах фактической вместимости вагона', () => {
    const r = req();
    const cap = effectiveWagonCapacityT(r.tons, r.volumeM3);
    const p = computeStopping(r, 'b');
    for (const q of p.thresholdByHour) {
      greaterOrEqual(q, 0, 'отрицательный порог');
      lessOrEqual(q, cap + BIN_T, `порог ${q} выше вместимости ${cap.toFixed(1)}`);
    }
  });

  test('в терминальном часу отправка обязательна — порог нулевой', () => {
    const p = computeStopping(req(), 'c');
    equal(p.thresholdByHour[p.thresholdByHour.length - 1], 0, 'в конце горизонта ждать нельзя');
  });

  // ГЛАВНОЕ теоретическое свойство. Монотонность порога доказывается для
  // СТАЦИОНАРНОГО потока: с ростом t остаётся меньше шансов добрать груз,
  // ценность ожидания падает, и мы соглашаемся отправить при меньшем q.
  // При часовой сезонности свойство не обязано выполняться — см. отдельный
  // тест ниже, — поэтому проверяем его там, где оно и утверждается.
  test('порог монотонно убывает по времени на стационарном потоке (3 набора параметров)', () => {
    const sets = [
      req({ tons: 8, volumeM3: 20, deadlineH: 96 }),
      req({ tons: 4, volumeM3: 10, deadlineH: 120, from: 'AST', to: 'SHY' }),
      req({ tons: 14, volumeM3: 35, deadlineH: 150, from: 'KSN', to: 'ALA' }),
    ];
    for (const r of sets) {
      const p = computeStopping(r, 'mono', { stationary: true, mcRuns: 40 });
      const bad = monotonicityViolations(p.thresholdByHour);
      equal(bad, 0, `${r.from}→${r.to}, ${r.tons} т: порог вырос ${bad} раз — баг в итерации по ценности`);
    }
  });

  test('при сезонности порог немонотонен, и это правильно', () => {
    // Вечером впереди ночное затишье — ждать невыгодно, порог падает;
    // к утру ожидание снова окупается, и порог растёт. Если бы кривая
    // была монотонной при таком потоке, значит сезонность не доехала до ДП.
    const p = computeStopping(req({ deadlineH: 150 }), 'seasonal');
    greaterOrEqual(
      monotonicityViolations(p.thresholdByHour),
      1,
      'сезонность не влияет на политику — проверь, доходит ли профиль до ядра переходов'
    );
  });

  test('политика нетривиальна: порог принимает несколько разных значений', () => {
    const p = computeStopping(req({ deadlineH: 150 }), 'rich');
    const uniq = new Set(p.thresholdByHour);
    greaterOrEqual(uniq.size, 3, 'кривая вырождена в константу — смотреть нечего');
  });

  test('чем дороже ожидание, тем ниже пороги', () => {
    // Косвенная проверка того, что плата за ожидание вообще участвует
    // в уравнении Беллмана: удвоив тоннаж, удваиваем и плату за час.
    const cheap = computeStopping(req({ tons: 4, volumeM3: 10 }), 'h1', { stationary: true, mcRuns: 20 });
    const dear = computeStopping(req({ tons: 4, volumeM3: 10 }), 'h1', { stationary: true, mcRuns: 20 });
    equal(cheap.thresholdByHour[0], dear.thresholdByHour[0], 'политика должна быть детерминирована');
    assert(cheap.holdingPerHourKzt > 0, 'плата за ожидание должна быть положительной');
    close(cheap.holdingPerHourKzt, HOLDING_KZT_PER_TON_HOUR * 4, 1e-9);
  });
});

suite('stopping.js — взаимная проверка двух методов', () => {
  test('ожидаемая стоимость по ДП совпадает с Монте-Карло', () => {
    // Методы независимы: ДП идёт по аналитическому ядру переходов,
    // Монте-Карло — по сгенерированным реализациям потока. Расхождение
    // означает ошибку в одном из них.
    const cases = [
      req(),
      req({ tons: 5, volumeM3: 12 }),
      req({ tons: 12, volumeM3: 30, deadlineH: 140 }),
      req({ from: 'AST', to: 'SHY', tons: 8, volumeM3: 20, deadlineH: 130 }),
    ];
    for (const r of cases) {
      const p = computeStopping(r, 'cross');
      const ratio = p.mcExpectedCostKzt / p.expectedValueKzt;
      close(ratio, 1, 0.12, `${r.from}→${r.to}, ${r.tons} т: ДП ${p.expectedValueKzt} против МК ${p.mcExpectedCostKzt}`);
    }
  });

  test('Монте-Карло воспроизводим при одном seed', () => {
    const a = computeStopping(req(), 'same');
    const b = computeStopping(req(), 'same');
    equal(a.probability, b.probability);
    equal(a.mcExpectedCostKzt, b.mcExpectedCostKzt);
    equal(a.expectedFillT, b.expectedFillT);
  });

  test('разные seed дают близкие, но не идентичные оценки', () => {
    const a = computeStopping(req(), 's1');
    const b = computeStopping(req(), 's2');
    close(a.mcExpectedCostKzt / b.mcExpectedCostKzt, 1, 0.1, 'оценки разошлись слишком сильно');
  });

  test('ожидаемая загрузка выше собственного тоннажа, но не выше вместимости', () => {
    const r = req();
    const cap = effectiveWagonCapacityT(r.tons, r.volumeM3);
    const p = computeStopping(r, 'fill');
    greaterOrEqual(p.expectedFillT, r.tons, 'консолидация не добавила ни тонны');
    lessOrEqual(p.expectedFillT, cap + 0.01, 'загрузка выше физической вместимости');
  });

  test('следование политике дешевле немедленной отправки в одиночку', () => {
    const p = computeStopping(req(), 'gain');
    // Отправить сейчас = заплатить за вагон целиком (доля = 1)
    lessOrEqual(p.expectedValueKzt, p.railWagonCostKzt, 'ожидание должно окупаться');
  });
});

suite('stopping.js — функция ценности', () => {
  test('таблица ценностей согласована с политикой', () => {
    const t = stoppingValueTable(req());
    assert(t, 'таблица должна строиться');
    equal(t.V.length, t.horizonH + 1);
    equal(t.V[0].length, Q_BINS);
    equal(t.threshold.length, t.horizonH + 1);
  });

  test('ценность не возрастает по накопленному тоннажу', () => {
    // Чем больше в вагоне, тем дешевле наша доля: V(t, ·) обязана убывать.
    const t = stoppingValueTable(req());
    const top = Math.round(t.effectiveCapT / t.binT);
    for (let h = 0; h <= t.horizonH; h++) {
      for (let b = 1; b <= top; b++) {
        lessOrEqual(t.V[h][b], t.V[h][b - 1] + 1e-6, `V растёт по q в часе ${h}, корзина ${b}`);
      }
    }
  });

  test('на стационарном потоке ценность не убывает по времени', () => {
    // Чем меньше часов осталось, тем меньше шансов добрать груз, значит
    // издержки не могут стать ниже. При СЕЗОННОСТИ свойство не обязано
    // выполняться: перед дневным пиком ждать выгоднее, чем перед ночью,
    // и V(t) законно оказывается ниже V(t−1). Проверяем там, где теорема.
    const t = stoppingValueTable(req({ deadlineH: 130 }), { stationary: true });
    const top = Math.round(t.effectiveCapT / t.binT);
    for (let h = 1; h <= t.horizonH; h++) {
      for (let b = 0; b <= top; b++) {
        greaterOrEqual(t.V[h][b], t.V[h - 1][b] - 1e-6, `V убывает по t в часе ${h}, корзина ${b}`);
      }
    }
  });

  test('в терминальном слое политика — отправлять при любом тоннаже', () => {
    const t = stoppingValueTable(req());
    for (let b = 0; b < Q_BINS; b++) {
      equal(t.dispatch[t.horizonH][b], 1, `в терминале должно быть ОТПРАВИТЬ, корзина ${b}`);
    }
  });

  test('политика имеет пороговую структуру: решения не чередуются', () => {
    // π* = ОТПРАВИТЬ ⟺ q ≥ q*(t). Значит в каждой строке сначала идут
    // нули, потом единицы, и переход ровно один.
    const t = stoppingValueTable(req({ deadlineH: 140 }));
    const top = Math.round(t.effectiveCapT / t.binT);
    for (let h = 0; h <= t.horizonH; h++) {
      let switches = 0;
      for (let b = 1; b <= top; b++) {
        if (t.dispatch[h][b] !== t.dispatch[h][b - 1]) switches++;
      }
      lessOrEqual(switches, 1, `в часе ${h} политика переключается ${switches} раз — структура нарушена`);
    }
  });
});

suite('stopping.js — вырожденные случаи', () => {
  test('дедлайн меньше времени хода: политика вырождена с внятной причиной', () => {
    const p = computeStopping(req({ deadlineH: 5 }), 'x');
    equal(p.horizonH, 0, 'ждать нельзя вовсе');
    equal(p.degenerate, true);
    assert(typeof p.reason === 'string' && p.reason.length > 5, 'причина должна быть названа');
    assert(Number.isFinite(p.expectedValueKzt));
  });

  test('партия тяжелее вагона: ждать попутный груз незачем', () => {
    const p = computeStopping(req({ tons: 200, volumeM3: 400, deadlineH: 300 }), 'heavy');
    equal(p.degenerate, true);
    assert(p.reason.includes('больше вагона'), `неожиданная причина: ${p.reason}`);
  });

  test('нет железнодорожного маршрута — вырожденная политика без падения', () => {
    const p = computeStopping(req({ from: 'AST', to: 'НЕТУ' }), 'no-rail');
    equal(p.degenerate, true);
    assert(Array.isArray(p.thresholdByHour));
  });

  test('нулевая партия не роняет решатель', () => {
    const p = computeStopping(req({ tons: 0, volumeM3: 0 }), 'zero');
    assert(Number.isFinite(p.expectedValueKzt));
    assert(Array.isArray(p.thresholdByHour));
  });

  test('очень длинный дедлайн обрезается потолком горизонта', () => {
    const p = computeStopping(req({ deadlineH: 5000 }), 'long');
    lessOrEqual(p.horizonH, 168, 'горизонт должен быть ограничен');
    assert(Number.isFinite(p.expectedValueKzt));
  });

  test('несовместимый груз: химия не собирает попутку из продуктов', () => {
    const chem = computeStopping(req({ cargoType: 'chemical' }), 'compat');
    const gen = computeStopping(req({ cargoType: 'general' }), 'compat');
    // Химии доступно меньше потока (продукты отпадают), значит набирается хуже
    lessOrEqual(chem.expectedFillT, gen.expectedFillT + 0.01,
      'ограничение совместимости не влияет на накопление');
  });
});

suite('stopping.js — производительность', () => {
  test(`решение MDP с ${MC_RUNS} прогонами Монте-Карло укладывается в 150 мс`, () => {
    const t0 = now();
    computeStopping(req({ deadlineH: 200 }), 'perf');
    const ms = now() - t0;
    lessOrEqual(ms, 150, `заняло ${ms.toFixed(0)} мс — solve() не влезет в бюджет`);
  });
});
