// Тесты ГПСЧ: воспроизводимость и корректность распределений.
import { suite, test, assert, equal, close, lessOrEqual, greaterOrEqual } from './harness.js';
import { makeRng } from '../src/core/random.js';

suite('random.js — детерминированный ГПСЧ', () => {
  test('один seed — идентичная последовательность', () => {
    const a = makeRng(42);
    const b = makeRng(42);
    for (let i = 0; i < 100; i++) equal(a.float(), b.float(), `расхождение на шаге ${i}`);
  });

  test('разные seed — разные последовательности', () => {
    const a = makeRng(1);
    const b = makeRng(2);
    let same = 0;
    for (let i = 0; i < 50; i++) if (a.float() === b.float()) same++;
    assert(same < 3, `подозрительно много совпадений: ${same}`);
  });

  test('строковый seed работает и воспроизводим', () => {
    const a = makeRng('demo-ala');
    const b = makeRng('demo-ala');
    const c = makeRng('demo-ast');
    equal(a.float(), b.float(), 'одинаковая строка должна дать одинаковое число');
    assert(a.float() !== c.float(), 'разные строки не должны совпадать');
  });

  test('float всегда в [0,1)', () => {
    const r = makeRng(7);
    for (let i = 0; i < 5000; i++) {
      const v = r.float();
      greaterOrEqual(v, 0, 'float < 0');
      assert(v < 1, 'float >= 1');
    }
  });

  test('float распределён равномерно: среднее ≈ 0.5', () => {
    const r = makeRng(11);
    let s = 0;
    const n = 50000;
    for (let i = 0; i < n; i++) s += r.float();
    close(s / n, 0.5, 0.01, 'среднее равномерного должно быть 0.5');
  });

  test('int(a,b) не выходит за границы и покрывает их', () => {
    const r = makeRng(3);
    const seen = new Set();
    for (let i = 0; i < 2000; i++) {
      const v = r.int(2, 6);
      greaterOrEqual(v, 2, 'int ниже нижней границы');
      lessOrEqual(v, 6, 'int выше верхней границы');
      equal(v, Math.floor(v), 'int должен быть целым');
      seen.add(v);
    }
    equal(seen.size, 5, 'должны встретиться все значения 2..6');
  });

  test('int с перевёрнутым диапазоном не падает', () => {
    equal(makeRng(1).int(9, 4), 9, 'при hi < lo возвращаем lo');
  });

  test('exp(mean): среднее сходится к mean', () => {
    const r = makeRng(5);
    let s = 0;
    const n = 40000;
    for (let i = 0; i < n; i++) s += r.exp(4);
    close(s / n, 4, 0.1, 'среднее экспоненциального должно быть mean');
  });

  test('exp никогда не возвращает Infinity и не отрицателен', () => {
    const r = makeRng(9);
    for (let i = 0; i < 20000; i++) {
      const v = r.exp(1);
      assert(Number.isFinite(v), 'exp вернул не число');
      greaterOrEqual(v, 0, 'exp отрицателен');
    }
  });

  test('normal(mu,sigma): среднее и дисперсия сходятся', () => {
    const r = makeRng(13);
    const n = 60000;
    let s = 0;
    let s2 = 0;
    for (let i = 0; i < n; i++) {
      const v = r.normal(10, 2);
      s += v;
      s2 += v * v;
    }
    const mean = s / n;
    const varr = s2 / n - mean * mean;
    close(mean, 10, 0.05, 'среднее нормального');
    close(Math.sqrt(varr), 2, 0.05, 'сигма нормального');
  });

  test('pick без весов покрывает все элементы примерно поровну', () => {
    const r = makeRng(17);
    const arr = ['a', 'b', 'c', 'd'];
    const cnt = { a: 0, b: 0, c: 0, d: 0 };
    for (let i = 0; i < 20000; i++) cnt[r.pick(arr)]++;
    for (const k of arr) close(cnt[k] / 20000, 0.25, 0.02, `доля ${k}`);
  });

  test('pick с весами соблюдает пропорции', () => {
    const r = makeRng(19);
    const arr = ['general', 'food', 'chemical'];
    const w = [0.6, 0.3, 0.1];
    const cnt = { general: 0, food: 0, chemical: 0 };
    const n = 40000;
    for (let i = 0; i < n; i++) cnt[r.pick(arr, w)]++;
    close(cnt.general / n, 0.6, 0.02, 'доля general');
    close(cnt.food / n, 0.3, 0.02, 'доля food');
    close(cnt.chemical / n, 0.1, 0.02, 'доля chemical');
  });

  test('pick на пустом массиве возвращает undefined, а не падает', () => {
    equal(makeRng(1).pick([]), undefined);
  });

  test('shuffle не мутирует вход и сохраняет состав', () => {
    const r = makeRng(23);
    const src = [1, 2, 3, 4, 5, 6];
    const out = r.shuffle(src);
    equal(src.join(','), '1,2,3,4,5,6', 'исходный массив изменён');
    equal(out.slice().sort((a, b) => a - b).join(','), '1,2,3,4,5,6', 'состав изменён');
  });

  test('fork даёт воспроизводимые и различные потоки', () => {
    const base = makeRng(100);
    const f1 = base.fork(1);
    const f2 = base.fork(2);
    const f1again = makeRng(100).fork(1);
    equal(f1.float(), f1again.float(), 'fork должен быть воспроизводим');
    assert(base.fork(1).float() !== f2.float(), 'разные ветки должны различаться');
  });

  test('fork не сдвигает основной поток', () => {
    const a = makeRng(55);
    const first = a.float();
    a.fork('mc');
    const b = makeRng(55);
    b.float();
    equal(a.float(), b.float(), 'fork не должен потреблять состояние родителя');
    assert(Number.isFinite(first));
  });

  test('bool(p) соблюдает вероятность', () => {
    const r = makeRng(29);
    let t = 0;
    for (let i = 0; i < 20000; i++) if (r.bool(0.3)) t++;
    close(t / 20000, 0.3, 0.02, 'доля истин');
  });
});
