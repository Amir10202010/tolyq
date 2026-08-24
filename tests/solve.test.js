// Тесты оркестрации: форма ответа по контракту, вырожденные входы, бюджет времени.
import { suite, test, assert, equal, close, lessOrEqual, greaterOrEqual } from './harness.js';
import { solve, runMonth } from '../src/core/solve.js';
import * as engine from '../src/core/solve.js';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

suite('solve.js — поверхность публичного API', () => {
  test('движок отдаёт наружу ровно то, что перечислено в types.js', () => {
    // Контракт говорит «больше UI ничего о нём не знает»: напарник
    // импортирует только из solve.js. Если какой-то из этих вызовов
    // не реэкспортирован, интерфейс получит undefined и упадёт в рантайме
    // там, где никто не ждёт, — тест ловит это на сборке, а не на защите.
    for (const name of ['solve', 'simulateArrivals', 'computeStopping', 'runMonth', 'getNetwork']) {
      equal(typeof engine[name], 'function', `solve.js не отдаёт ${name}()`);
    }
  });

  test('реэкспортированные вызовы работают через solve.js', () => {
    const arrivals = engine.simulateArrivals({ from: 'AST', to: 'ALA' }, 48, 'api');
    assert(Array.isArray(arrivals), 'simulateArrivals должен вернуть массив');

    const policy = engine.computeStopping({ from: 'AST', to: 'ALA', tons: 8, volumeM3: 20, deadlineH: 96 }, 'api');
    assert(Array.isArray(policy.thresholdByHour), 'computeStopping должен вернуть политику');

    const net = engine.getNetwork();
    assert(net.nodes.length === 12 && net.edges.length > 0, 'getNetwork должен вернуть граф');

    const month = engine.runMonth('AST', 'ALA', 'api');
    equal(month.dailyTrucksAvoided.length, 30, 'runMonth должен вернуть 30 дней');
  });
});

suite('solve.js — контракт ответа', () => {
  test('ответ содержит все поля Solution', () => {
    const s = solve({ from: 'AST', to: 'ALA', tons: 8, volumeM3: 52, cargoType: 'general', deadlineH: 96 });
    for (const k of ['pareto', 'dominated', 'truckBaseline', 'recommended', 'stopping', 'packing', 'savingKzt', 'savingCo2Kg', 'explanation']) {
      assert(k in s, `в ответе нет поля ${k}`);
    }
    assert(Array.isArray(s.pareto) && Array.isArray(s.dominated));
    equal(typeof s.explanation, 'string');
    assert(s.explanation.length > 20, 'объяснение должно быть содержательным');
  });

  test('рекомендованный маршрут принадлежит фронту', () => {
    const s = solve({ from: 'AST', to: 'ALA', tons: 8, deadlineH: 96 });
    assert(s.pareto.some((r) => r.id === s.recommended.id), 'рекомендация вне фронта');
  });

  test('экономия согласована с базой и рекомендацией', () => {
    const s = solve({ from: 'AST', to: 'ALA', tons: 8, deadlineH: 96 });
    close(s.savingKzt, s.truckBaseline.costKzt - s.recommended.costKzt, 1);
    close(s.savingCo2Kg, s.truckBaseline.co2Kg - s.recommended.co2Kg, 0.2);
  });

  test('на 8 тоннах ЖД экономит и деньги, и CO₂ — иначе проект бессмыслен', () => {
    const s = solve({ from: 'AST', to: 'ALA', tons: 8, volumeM3: 52, deadlineH: 96, weights: { cost: 1, time: 0, co2: 0 } });
    assert(s.savingKzt > 0, 'экономии по деньгам нет');
    assert(s.savingCo2Kg > 0, 'экономии по CO₂ нет');
    assert(s.recommended.legs.some((l) => l.mode === 'rail'), 'при весе на деньги должна победить ЖД');
  });

  test('веса меняют рекомендацию', () => {
    const base = { from: 'AST', to: 'ALA', tons: 8, deadlineH: 96 };
    const cheap = solve({ ...base, weights: { cost: 1, time: 0, co2: 0 } });
    const fast = solve({ ...base, weights: { cost: 0, time: 1, co2: 0 } });
    assert(cheap.recommended.id !== fast.recommended.id, 'веса не влияют на выбор');
    lessOrEqual(cheap.recommended.costKzt, fast.recommended.costKzt);
    lessOrEqual(fast.recommended.hours, cheap.recommended.hours);
  });

  test('truckBaseline — чисто автомобильный маршрут', () => {
    const s = solve({ from: 'AST', to: 'ALA', tons: 8, deadlineH: 96 });
    assert(s.truckBaseline, 'база должна существовать там, где есть дороги');
    assert(s.truckBaseline.legs.every((l) => l.mode === 'road'), 'в базе затесалась ЖД');
  });

  test('политика и упаковка отдаются в форме контракта', () => {
    const s = solve({ from: 'AST', to: 'ALA', tons: 8, deadlineH: 96 });
    assert(Array.isArray(s.stopping.thresholdByHour));
    for (const k of ['expectedValueKzt', 'dispatchAtH', 'probability', 'horizonH']) {
      equal(typeof s.stopping[k], 'number', `stopping.${k} должно быть числом`);
    }
    for (const k of ['tonsTotal', 'fillPct', 'baselineFillPct', 'iterations']) {
      equal(typeof s.packing[k], 'number', `packing.${k} должно быть числом`);
    }
    assert(Array.isArray(s.packing.accepted) && Array.isArray(s.packing.rejected));
  });
});

suite('solve.js — вырожденные входы', () => {
  test('несуществующий узел: валидный пустой ответ, не исключение', () => {
    const s = solve({ from: 'AST', to: 'НЕТУ', tons: 8 });
    equal(s.pareto.length, 0);
    equal(s.recommended, null);
    equal(s.savingKzt, 0);
    assert(s.explanation.includes('не найден'), 'объяснение должно назвать причину');
  });

  test('к Достыку нет автодороги — база отсутствует, ответ валиден', () => {
    const s = solve({ from: 'DOS', to: 'ALA', tons: 8, deadlineH: 200 });
    equal(s.truckBaseline, null, 'автомобильной базы там быть не может');
    assert(s.recommended, 'рекомендация всё равно должна быть');
    equal(s.savingKzt, 0, 'без базы экономию считать не с чем');
  });

  test('дедлайн меньше времени в пути: честное предупреждение вместо пустоты', () => {
    const s = solve({ from: 'AST', to: 'ALA', tons: 8, deadlineH: 3 });
    assert(s.recommended, 'должен быть показан ближайший вариант');
    equal(s.recommended.feasible, false);
    assert(s.explanation.includes('не укладывается'), 'объяснение должно предупредить о сроке');
  });

  test('мусор на входе не роняет движок', () => {
    const bad = [
      { from: 'AST', to: 'ALA', tons: NaN, deadlineH: -5 },
      { from: 'AST', to: 'ALA', tons: -100, volumeM3: Infinity },
      { from: 'AST', to: 'ALA', tons: 8, cargoType: 'плутоний' },
      { from: 'AST', to: 'ALA', tons: 8, weights: { cost: NaN, time: -1, co2: 99 } },
      {},
    ];
    for (const b of bad) {
      const s = solve(b);
      assert(s && typeof s.explanation === 'string', `упал на входе ${JSON.stringify(b)}`);
      assert(Number.isFinite(s.savingKzt), 'экономия должна остаться числом');
    }
  });

  test('нормализация зажимает вход в допустимые границы', () => {
    const s = solve({ from: 'AST', to: 'ALA', tons: -5, deadlineH: 0, cargoType: 'плутоний' });
    greaterOrEqual(s.request.tons, 0);
    greaterOrEqual(s.request.deadlineH, 1);
    equal(s.request.cargoType, 'general', 'неизвестный тип груза → general');
  });

  test('груз тяжелее вагона маршрутизируется без доли', () => {
    const s = solve({ from: 'AST', to: 'ALA', tons: 200, volumeM3: 400, deadlineH: 200 });
    assert(s.recommended, 'тяжёлая партия должна получить маршрут');
    assert(s.recommended.costKzt > 0);
  });
});

suite('solve.js — прогон месяца', () => {
  test('MonthSummary содержит все поля контракта', () => {
    const m = runMonth('AST', 'ALA', 'm');
    for (const k of ['shipments', 'trucksAvoided', 'co2SavedKg', 'kztSaved', 'avgFillPct', 'dailyTrucksAvoided']) {
      assert(k in m, `в сводке нет поля ${k}`);
    }
    equal(m.dailyTrucksAvoided.length, 30, 'график должен быть на 30 дней');
    for (const v of m.dailyTrucksAvoided) {
      assert(Number.isFinite(v) && v >= 0, 'в графике отрицательное или нечисло');
    }
  });

  test('итог по дням сходится с общим числом убранных фур', () => {
    const m = runMonth('AST', 'ALA', 'sum');
    const daily = m.dailyTrucksAvoided.reduce((a, b) => a + b, 0);
    equal(daily, m.trucksAvoided, 'сумма по дням не равна итогу');
  });

  test('политика реально применяется: отправки идут не по календарю', () => {
    // Если бы вагоны собирались посуточно, часы отправки были бы
    // кратны 24 или шли ровно раз в день. Политика даёт нерегулярную
    // картину — именно это и отличает прогон от группировки по датам.
    const m = runMonth('AST', 'ALA', 'policy');
    greaterOrEqual(m.wagons, 2, 'за месяц должно собраться несколько вагонов');
    const gaps = new Set();
    for (let i = 1; i < m.dispatchHours.length; i++) {
      gaps.add(m.dispatchHours[i] - m.dispatchHours[i - 1]);
    }
    greaterOrEqual(gaps.size, 3, 'интервалы между отправками одинаковы — политика не участвует');
  });

  test('экономия и убранные фуры неотрицательны', () => {
    for (const [a, b] of [['AST', 'ALA'], ['AST', 'KGF'], ['ATX', 'SCO'], ['SHY', 'DMB']]) {
      const m = runMonth(a, b, 'neg');
      greaterOrEqual(m.trucksAvoided, 0, `${a}→${b}: отрицательное число фур`);
      greaterOrEqual(m.co2SavedKg, 0, `${a}→${b}: отрицательная экономия CO₂`);
      greaterOrEqual(m.avgFillPct, 0, `${a}→${b}: отрицательная загрузка`);
      lessOrEqual(m.avgFillPct, 100, `${a}→${b}: загрузка выше 100 %`);
    }
  });

  test('убрано фур не больше, чем было отправлений', () => {
    const m = runMonth('AST', 'ALA', 'cap');
    lessOrEqual(m.wagons, m.shipments, 'вагонов больше, чем заявок');
  });

  test('загруженный коридор даёт больший эффект, чем тихий', () => {
    // AST–KGF задано в сети как 7.0 заявок в сутки, ATX–SCO как 2.0
    const busy = runMonth('AST', 'KGF', 'cmp');
    const quiet = runMonth('ATX', 'SCO', 'cmp');
    greaterOrEqual(busy.shipments, quiet.shipments, 'на плотном плече заявок должно быть больше');
  });

  test('прогон воспроизводим при одном seed', () => {
    equal(JSON.stringify(runMonth('AST', 'ALA', 'same')), JSON.stringify(runMonth('AST', 'ALA', 'same')));
  });

  test('коридор без ЖД отдаёт валидный нулевой результат', () => {
    const m = runMonth('AST', 'НЕТУ', 'none');
    equal(m.trucksAvoided, 0);
    equal(m.dailyTrucksAvoided.length, 30);
    assert(Number.isFinite(m.kztSaved));
  });

  test('число дней настраивается', () => {
    const m = runMonth('AST', 'ALA', 'd', { days: 7 });
    equal(m.days, 7);
    equal(m.dailyTrucksAvoided.length, 7);
  });

  test('прогон месяца укладывается в 200 мс', () => {
    const t0 = now();
    runMonth('AST', 'ALA', 'perf');
    const ms = now() - t0;
    lessOrEqual(ms, 200, `прогон занял ${ms.toFixed(0)} мс`);
  });
});

suite('solve.js — производительность', () => {
  test('solve() укладывается в 300 мс на всех парах', () => {
    const ids = ['AST', 'ALA', 'SHY', 'KGF', 'AKX', 'ATX', 'KSN', 'PWQ', 'DMB', 'SCO', 'KHG', 'DOS'];
    let worst = 0;
    let worstPair = '';
    for (const a of ids) {
      for (const b of ids) {
        if (a === b) continue;
        const t0 = now();
        solve({ from: a, to: b, tons: 8, volumeM3: 52, deadlineH: 500 });
        const ms = now() - t0;
        if (ms > worst) { worst = ms; worstPair = `${a}→${b}`; }
      }
    }
    lessOrEqual(worst, 300, `худшая пара ${worstPair}: ${worst.toFixed(1)} мс`);
  });

  test('повторный вызов с теми же входами даёт тот же результат', () => {
    const req = { from: 'AST', to: 'SCO', tons: 8, deadlineH: 200 };
    const a = solve(req);
    const b = solve(req);
    equal(a.recommended.id, b.recommended.id);
    equal(a.savingKzt, b.savingKzt);
    equal(a.explanation, b.explanation);
  });
});
