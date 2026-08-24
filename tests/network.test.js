// Тесты графа сети: связность, симметрия, корректность рёбер.
import { suite, test, assert, equal, close, lessOrEqual, greaterOrEqual } from './harness.js';
import {
  getNetwork,
  edgesFrom,
  isHub,
  getNode,
  isConnected,
  arrivalsPerDayBetween,
  TRUCK_KMH,
  RAIL_KMH,
  RAIL_TERMINAL_H,
} from '../src/core/network.js';
import { NODES } from '../src/core/types.js';

const { nodes, edges } = getNetwork();

suite('network.js — граф сети', () => {
  test('число рёбер в оговорённом диапазоне 22..28 (по коридорам)', () => {
    // edges хранит оба направления, коридоро-режимов вдвое меньше
    const undirected = edges.length / 2;
    greaterOrEqual(undirected, 22, 'слишком бедная сеть');
    lessOrEqual(undirected, 28, 'слишком плотная сеть');
  });

  test('граф связен по объединению видов транспорта', () => {
    assert(isConnected(), 'есть недостижимые узлы');
  });

  test('все 12 узлов присутствуют и уникальны', () => {
    equal(nodes.length, 12, 'узлов должно быть 12');
    equal(new Set(nodes.map((n) => n.id)).size, 12, 'дубликаты id');
  });

  test('каждый узел имеет хотя бы одно ребро', () => {
    for (const n of NODES) {
      greaterOrEqual(edgesFrom(n.id).length, 1, `узел ${n.id} изолирован`);
    }
  });

  test('рёбра симметричны: для каждого from→to есть to→from того же режима', () => {
    for (const e of edges) {
      const back = edges.find((x) => x.from === e.to && x.to === e.from && x.mode === e.mode);
      assert(back, `нет обратного ребра ${e.to}→${e.from} (${e.mode})`);
      equal(back.km, e.km, `несимметричное расстояние ${e.from}-${e.to}`);
      equal(back.hours, e.hours, `несимметричное время ${e.from}-${e.to}`);
    }
  });

  test('нет петель и дублей', () => {
    const seen = new Set();
    for (const e of edges) {
      assert(e.from !== e.to, `петля в ${e.from}`);
      const key = `${e.from}|${e.to}|${e.mode}`;
      assert(!seen.has(key), `дубль ребра ${key}`);
      seen.add(key);
    }
  });

  test('вид транспорта поддержан обоими концами ребра', () => {
    for (const e of edges) {
      assert(getNode(e.from)[e.mode], `${e.from} не обслуживает ${e.mode}`);
      assert(getNode(e.to)[e.mode], `${e.to} не обслуживает ${e.mode}`);
    }
  });

  test('Достык не имеет автодорожных рёбер (road:false в контракте)', () => {
    equal(edgesFrom('DOS', 'road').length, 0, 'к Достыку не должно быть автодорог');
    greaterOrEqual(edgesFrom('DOS', 'rail').length, 1, 'Достык должен быть на ЖД');
  });

  test('время хода согласовано со средними скоростями', () => {
    for (const e of edges) {
      const expected =
        e.mode === 'road' ? e.km / TRUCK_KMH : e.km / RAIL_KMH + RAIL_TERMINAL_H;
      close(e.hours, expected, 0.06, `время на ${e.from}-${e.to} (${e.mode})`);
    }
  });

  test('ЖД длиннее и медленнее автодороги на том же плече', () => {
    for (const e of edges) {
      if (e.mode !== 'rail') continue;
      const road = edges.find((x) => x.from === e.from && x.to === e.to && x.mode === 'road');
      if (!road) continue;
      greaterOrEqual(e.km, road.km, `ЖД короче автодороги на ${e.from}-${e.to}`);
      greaterOrEqual(e.hours, road.hours, `ЖД быстрее фуры на ${e.from}-${e.to}`);
    }
  });

  test('ЖД дешевле автотранспорта за рейс на том же плече', () => {
    for (const e of edges) {
      if (e.mode !== 'rail') continue;
      const road = edges.find((x) => x.from === e.from && x.to === e.to && x.mode === 'road');
      if (!road) continue;
      lessOrEqual(
        e.kztPerWagonTrip,
        road.kztPerTruckTrip,
        `вагон дороже фуры на ${e.from}-${e.to} — проверь тарифы`
      );
    }
  });

  test('у каждого ребра положительные км, часы и тариф', () => {
    for (const e of edges) {
      assert(e.km > 0, `км <= 0 на ${e.from}-${e.to}`);
      assert(e.hours > 0, `часы <= 0 на ${e.from}-${e.to}`);
      const cost = e.mode === 'road' ? e.kztPerTruckTrip : e.kztPerWagonTrip;
      assert(cost > 0, `тариф <= 0 на ${e.from}-${e.to}`);
      assert(e.arrivalsPerDay > 0, `интенсивность <= 0 на ${e.from}-${e.to}`);
    }
  });

  test('хабы совпадают с контрактом types.js', () => {
    for (const n of NODES) equal(isHub(n.id), !!n.hub, `hub у ${n.id}`);
  });

  test('edgesFrom по неизвестному узлу возвращает пустой массив', () => {
    equal(edgesFrom('XXX').length, 0);
    equal(edgesFrom('XXX', 'rail').length, 0);
  });

  test('arrivalsPerDayBetween даёт положительное значение и для непрямых пар', () => {
    assert(arrivalsPerDayBetween('AST', 'KGF') > 0, 'прямое плечо');
    assert(arrivalsPerDayBetween('AST', 'SCO') > 0, 'непрямое плечо');
    assert(arrivalsPerDayBetween('XXX', 'YYY') > 0, 'неизвестные узлы не должны ронять');
  });

  test('getNetwork возвращает одни и те же объекты (без пересборки)', () => {
    assert(getNetwork().edges === getNetwork().edges, 'сеть пересобирается на каждый вызов');
  });
});
