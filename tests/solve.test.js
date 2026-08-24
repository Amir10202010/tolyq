// Тесты оркестрации: форма ответа по контракту, вырожденные входы, бюджет времени.
import { suite, test, assert, equal, close, lessOrEqual, greaterOrEqual } from './harness.js';
import { solve } from '../src/core/solve.js';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

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

  test('политика и упаковка отдаются в форме контракта даже на слое 1', () => {
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
