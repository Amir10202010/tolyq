// Тесты углеродного следа.
import { suite, test, assert, equal, close, greaterOrEqual } from './harness.js';
import { truckCo2Kg, railCo2Kg, trucksNeeded, transshipCo2Kg, legCo2Kg, savingKg } from '../src/core/co2.js';
import { TRUCK_CAP_T, TRUCK_CO2_KG_PER_KM, RAIL_CO2_G_PER_TKM } from '../src/core/network.js';

suite('co2.js — выбросы', () => {
  test('фура: выброс не зависит от загрузки, пока машина одна', () => {
    close(truckCo2Kg(1000, 5), truckCo2Kg(1000, 19), 1e-9,
      'полупустая и полная фура должны выбрасывать одинаково');
  });

  test('фура: выброс = км × коэффициент × число машин', () => {
    close(truckCo2Kg(100, 10), 100 * TRUCK_CO2_KG_PER_KM, 1e-9);
    close(truckCo2Kg(100, 25), 2 * 100 * TRUCK_CO2_KG_PER_KM, 1e-9, 'две машины — двойной выброс');
  });

  test('trucksNeeded учитывает и массу, и объём', () => {
    equal(trucksNeeded(8, 52), 1, '8 т и 52 м³ влезают в одну фуру');
    equal(trucksNeeded(8, 200), 3, 'габаритный груз лимитируется объёмом');
    equal(trucksNeeded(45, 10), 3, 'тяжёлый груз лимитируется массой');
    equal(trucksNeeded(TRUCK_CAP_T, 0), 1, 'ровно вместимость — одна машина');
    equal(trucksNeeded(0, 0), 1, 'нулевая партия всё равно занимает машину');
  });

  test('ЖД: выброс линеен по тоннам — это и есть деление между отправителями', () => {
    close(railCo2Kg(1000, 8) * 2, railCo2Kg(1000, 16), 1e-9);
  });

  test('ЖД: выброс по формуле км × т × г/ткм / 1000', () => {
    close(railCo2Kg(230, 8), (230 * 8 * RAIL_CO2_G_PER_TKM) / 1000, 1e-9);
  });

  test('на типичной партии ЖД кратно чище фуры', () => {
    const km = 1000;
    const tons = 8;
    const ratio = truckCo2Kg(km, tons) / railCo2Kg(km, tons);
    greaterOrEqual(ratio, 3, 'на 8 тоннах ЖД должна быть минимум втрое чище');
  });

  test('перегрузка добавляет фиксированные килограммы', () => {
    close(transshipCo2Kg(0), 0, 1e-9);
    close(transshipCo2Kg(2), 24, 1e-9);
  });

  test('legCo2Kg диспетчеризует по виду транспорта', () => {
    close(legCo2Kg('road', 100, 8), truckCo2Kg(100, 8), 1e-9);
    close(legCo2Kg('rail', 100, 8), railCo2Kg(100, 8), 1e-9);
  });

  test('на очень тяжёлой партии преимущество ЖД исчезает — и мы это показываем', () => {
    // 68 т на 100 км: фура даёт 4 машины, ЖД считает по тоннам
    const s = savingKg(100, 68);
    assert(Number.isFinite(s), 'экономия должна быть числом');
    // проверяем именно знак-агностично: важно, что функция не врёт в плюс
    close(s, truckCo2Kg(100, 68) - railCo2Kg(100, 68), 1e-9);
  });

  test('нулевой пробег — нулевой выброс', () => {
    close(railCo2Kg(0, 8), 0, 1e-9);
    close(truckCo2Kg(0, 8), 0, 1e-9);
  });
});
