// =====================================================================
//  TOLYQ / UI — ГРАФ ТРАНСПОРТНОЙ СЕТИ КАЗАХСТАНА
// ---------------------------------------------------------------------
//  Карта здесь не украшение. Она доказывает, что решение принято на
//  настоящей сети, а не в таблице из пяти строк.
//
//  ПОДЛОЖКА. Под графом лежит настоящий контур страны и четыре крупных
//  озера (src/ui/kz-geo.js). Без них двенадцать точек и линии между ними
//  висели бы в пустоте: понять, что Актау — это берег Каспия, а Достык —
//  китайская граница, было бы неоткуда. Подложка нарочно почти не видна:
//  она объясняет расположение, а показывает маршрут граф поверх неё.
//
//  ПРОЕКЦИЯ. Широта и долгота линейно ложатся в вьюпорт, но долгота
//  сжимается на cos(широты): на 48-й параллели градус долготы примерно
//  вдвое короче градуса широты. Без поправки Казахстан выходит растянутым
//  вширь и перестаёт быть узнаваемым.
//
//  Кадр задаёт КОНТУР, а не города: страна должна помещаться целиком,
//  иначе граница обрежется по краю панели и превратится в случайную
//  ломаную. Города просто ложатся внутрь кадра там, где они и стоят.
//
//  Виды транспорта различаются НАЧЕРТАНИЕМ, а не только цветом: сплошная
//  линия — железная дорога, штриховая — автодорога. На проекторе с
//  убитой цветопередачей разница обязана сохраниться.
// =====================================================================

import * as fmt from './format.js';
import { KZ_OUTLINE, KZ_LAKES } from './kz-geo.js';

// Поля вокруг карты оставляют место подписям городов по краям. На узком
// экране поля ужимаются, а те подписи, которым места не хватило, снимает
// раскладчик ниже.
const PAD_Y = 30;
const padX = w => Math.min(60, Math.max(24, w * 0.1));
const OFFSET = 2.2;            // разведение параллельных рёбер, px
const R_NODE = 3.6;
const R_HUB  = 5.0;

/** Куда сдвинуть подпись каждого города, чтобы они не наезжали друг на друга.
 *  Подобрано руками по карте — двенадцать городов того стоят. */
const LABEL_HINT = {
  SCO: [-10,   4, 'end'],
  ATX: [-10,   4, 'end'],
  AKX: [-10,  -7, 'end'],
  KSN: [  0, -11, 'middle'],
  AST: [-10,  -7, 'end'],
  PWQ: [ 10,  -5, 'start'],
  KGF: [ 11,   5, 'start'],
  DMB: [  0,  17, 'middle'],
  SHY: [-10,   5, 'end'],
  ALA: [ -9,  16, 'end'],
  KHG: [  1,  16, 'middle'],
  DOS: [ 10,   4, 'start'],
};

export function createNetworkMap(root, { onNodeHover } = {}) {
  let net = null;         // { nodes, edges }
  let ends = { from: null, to: null };
  let route = null;
  let hoverId = null;
  let frame = null;

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ro = new ResizeObserver(() => schedule());
  ro.observe(root);

  return { update, showRoute, clear };

  // ------------------------------------------------------------------

  function update(network, request) {
    net = network;
    ends = { from: request.from, to: request.to };
    render();
  }

  function showRoute(r) {
    route = r || null;
    render();
  }

  function clear() { showRoute(null); }

  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = null; render(); });
  }

  // ------------------------------------------------------------------

  function render() {
    if (!net) return;
    const w = root.clientWidth;
    if (!w) return;

    const { at, height: h } = project(w);
    const points = {};
    for (const n of net.nodes) points[n.id] = at(n.lon, n.lat);
    const P = id => points[id];

    const parts = [];

    // --- подложка: страна и озёра ---------------------------------------
    //  Идёт первой и потому лежит под всем остальным. Никаких событий на
    //  ней нет: это фон, а не объект, с которым человек работает.
    parts.push(`<path class="kz-land" d="${ringPath(KZ_OUTLINE, at)}"/>`);
    for (const lake of KZ_LAKES) {
      parts.push(`<path class="kz-water" d="${ringPath(lake, at)}"/>`);
    }

    // --- базовая сеть ---------------------------------------------------
    for (const e of net.edges) {
      const a = P(e.from), b = P(e.to);
      if (!a || !b) continue;
      const o = offsetFor(net, e.from, e.to, e.mode, a, b);
      parts.push(`<line class="net-edge net-edge--${e.mode}"
        x1="${(a.x + o.dx).toFixed(1)}" y1="${(a.y + o.dy).toFixed(1)}"
        x2="${(b.x + o.dx).toFixed(1)}" y2="${(b.y + o.dy).toFixed(1)}"/>`);
    }

    // --- выбранный маршрут поверх ---------------------------------------
    const onRoute = new Set();
    const transships = [];
    let motionPath = '';

    if (route?.legs?.length) {
      for (const l of route.legs) {
        const a = P(l.from), b = P(l.to);
        if (!a || !b) continue;
        onRoute.add(l.from); onRoute.add(l.to);
        const o = offsetFor(net, l.from, l.to, l.mode, a, b);
        const x1 = a.x + o.dx, y1 = a.y + o.dy, x2 = b.x + o.dx, y2 = b.y + o.dy;
        parts.push(`<line class="net-hot net-hot--${l.mode}"
          x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}"
          x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`);
        motionPath += (motionPath ? ' L ' : 'M ') + x1.toFixed(1) + ' ' + y1.toFixed(1) +
                      ' L ' + x2.toFixed(1) + ' ' + y2.toFixed(1);
        if (l.transshipment) transships.push(l.from);
      }
    }

    // --- бегущий импульс: видно направление и то, что маршрут живой ------
    if (motionPath && !reduced) {
      const dur = Math.max(2.4, Math.min(6, (route.hours || 40) / 10));
      parts.push(`<path id="tolyq-motion" d="${motionPath}" fill="none" stroke="none"/>
        <circle class="net-pulse" r="2.6">
          <animateMotion dur="${dur}s" repeatCount="indefinite" rotate="auto">
            <mpath href="#tolyq-motion"/>
          </animateMotion>
        </circle>`);
    }

    // --- узлы -----------------------------------------------------------
    for (const n of net.nodes) {
      const p = P(n.id);
      if (!p) continue;
      const isEnd = n.id === ends.from || n.id === ends.to;
      const on = onRoute.has(n.id) || isEnd;
      const cls = ['net-node'];
      if (n.hub) cls.push('net-node--hub');
      if (on) cls.push('net-node--on');
      const r = n.hub ? R_HUB : R_NODE;

      // хаб — там, где возможна перегрузка: двойное кольцо
      if (n.hub) {
        parts.push(`<circle class="net-node net-node--hub" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}"
          r="${(r + 2.6).toFixed(1)}" fill="none"/>`);
      }
      parts.push(`<circle class="${cls.join(' ')}" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r}"/>`);
    }

    // --- подписи городов ------------------------------------------------
    //  Рисуем все, а раскладываем после отрисовки: реальные размеры текста
    //  до вставки в документ неизвестны. Подпись, которой не нашлось места,
    //  снимается — город назовёт всплывающая подсказка по наведению.
    const labelPlan = [];
    for (const n of net.nodes) {
      const p = P(n.id);
      if (!p) continue;
      const on = onRoute.has(n.id) || n.id === ends.from || n.id === ends.to || hoverId === n.id;
      const [dx, dy, anchor] = LABEL_HINT[n.id] || [9, 4, 'start'];
      labelPlan.push({ id: n.id, p, on, hub: n.hub });
      parts.push(`<text class="net-label${on ? ' net-label--on' : ''}" data-label="${n.id}"
        x="${(p.x + dx).toFixed(1)}" y="${(p.y + dy).toFixed(1)}"
        text-anchor="${anchor}">${n.name}</text>`);
    }

    // --- метки перегрузки -----------------------------------------------
    for (const id of transships) {
      const p = P(id);
      if (!p) continue;
      const hours = transshipHours(route);
      parts.push(`<g class="net-marker">
        <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="9"/>
        <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.4" fill="var(--warn)" stroke="none"/>
      </g>
      <text class="net-marker-label" x="${(p.x + 13).toFixed(1)}" y="${(p.y - 8).toFixed(1)}">перегрузка, ${fmt.hoursShort(hours)}</text>`);
    }

    // --- зоны наведения --------------------------------------------------
    for (const n of net.nodes) {
      const p = P(n.id);
      if (!p) continue;
      parts.push(`<circle class="net-node-hit" data-node="${n.id}"
        cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="14"><title>${n.name}${n.hub ? ' · узел перегрузки' : ''}</title></circle>`);
    }

    root.innerHTML =
      `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img"
            aria-label="Карта Казахстана с транспортной сетью: ${net.nodes.length} городов, ${net.edges.length} плеч">
         ${parts.join('')}
       </svg>` + legendHtml();

    layoutLabels(root.querySelector('svg'), labelPlan, w, h);

    // --- наведение на узел ------------------------------------------------
    const svg = root.querySelector('svg');
    for (const hit of svg.querySelectorAll('.net-node-hit')) {
      const id = hit.dataset.node;
      hit.addEventListener('pointerenter', () => {
        hoverId = id;
        svg.querySelector(`[data-label="${id}"]`)?.classList.add('net-label--on');
        onNodeHover?.(net.nodes.find(n => n.id === id) || null);
      });
      hit.addEventListener('pointerleave', () => {
        hoverId = null;
        const label = svg.querySelector(`[data-label="${id}"]`);
        const stays = onRoute.has(id) || id === ends.from || id === ends.to;
        if (label && !stays) label.classList.remove('net-label--on');
        onNodeHover?.(null);
      });
    }
  }
}

// ---------------------------------------------------------------------
//  РАССТАНОВКА ПОДПИСЕЙ
//  Сколько места займёт текст, до вставки в документ неизвестно, поэтому
//  раскладываем по факту. Каждой подписи пробуем несколько положений;
//  если ни одно не влезло без наложения — снимаем её совсем. Города на
//  маршруте идут первыми и место получают всегда.
// ---------------------------------------------------------------------
const PLACEMENTS = [
  [  9,   4, 'start'],
  [ -9,   4, 'end'],
  [  0, -10, 'middle'],
  [  0,  15, 'middle'],
  [  9, -7,  'start'],
  [ -9, -7,  'end'],
];

function layoutLabels(svg, plan, w, h) {
  if (!svg) return;

  // сперва города маршрута, потом узлы перегрузки, потом остальные
  const order = plan.slice().sort((a, b) =>
    (a.on ? 0 : a.hub ? 1 : 2) - (b.on ? 0 : b.hub ? 1 : 2));

  const taken = [];
  for (const item of order) {
    const node = svg.querySelector(`[data-label="${item.id}"]`);
    if (!node) continue;

    let placed = false;
    for (const [dx, dy, anchor] of candidatesFor(item)) {
      node.setAttribute('x', (item.p.x + dx).toFixed(1));
      node.setAttribute('y', (item.p.y + dy).toFixed(1));
      node.setAttribute('text-anchor', anchor);

      const b = pad(node.getBBox());
      if (b.x < 1 || b.y < 1 || b.x + b.width > w - 1 || b.y + b.height > h - 1) continue;
      if (taken.some(t => overlaps(t, b))) continue;

      taken.push(b);
      placed = true;
      break;
    }
    if (!placed) node.remove();
  }
}

/** Сначала выверенное вручную положение, затем запасные. */
function candidatesFor(item) {
  const hint = LABEL_HINT[item.id];
  return hint ? [hint, ...PLACEMENTS] : PLACEMENTS;
}

const pad = b => ({ x: b.x - 2, y: b.y - 1.5, width: b.width + 4, height: b.height + 3 });

const overlaps = (a, b) =>
  a.x < b.x + b.width && b.x < a.x + a.width &&
  a.y < b.y + b.height && b.y < a.y + a.height;

// ---------------------------------------------------------------------
//  Проекция
// ---------------------------------------------------------------------
/** Габариты страны в проекционных единицах. Контур не меняется — считаем раз. */
const BOX = (() => {
  let lonLo = Infinity, lonHi = -Infinity, latLo = Infinity, latHi = -Infinity;
  for (const [lon, lat] of KZ_OUTLINE) {
    if (lon < lonLo) lonLo = lon;
    if (lon > lonHi) lonHi = lon;
    if (lat < latLo) latLo = lat;
    if (lat > latHi) latHi = lat;
  }
  const k = Math.cos((latLo + latHi) / 2 * Math.PI / 180);
  return { k, xLo: lonLo * k, spanX: (lonHi - lonLo) * k, yLo: -latHi, spanY: latHi - latLo };
})();

function project(width) {
  // высоту подбираем под форму страны, а не наоборот
  const pad = padX(width);
  const innerW = Math.max(80, width - pad * 2);
  const scale = innerW / BOX.spanX;
  const height = Math.round(Math.min(430, Math.max(220, BOX.spanY * scale + PAD_Y * 2)));
  const innerH = height - PAD_Y * 2;
  const s = Math.min(scale, innerH / BOX.spanY);

  const offX = (width - BOX.spanX * s) / 2;
  const offY = (height - BOX.spanY * s) / 2;

  const at = (lon, lat) => ({
    x: offX + (lon * BOX.k - BOX.xLo) * s,
    y: offY + (-lat - BOX.yLo) * s,
  });
  return { at, height };
}

/** Кольцо градусов -> замкнутый путь SVG. */
function ringPath(ring, at) {
  let d = '';
  for (let i = 0; i < ring.length; i++) {
    const p = at(ring[i][0], ring[i][1]);
    d += (i ? 'L' : 'M') + p.x.toFixed(1) + ' ' + p.y.toFixed(1) + ' ';
  }
  return d + 'Z';
}

/**
 * Между двумя городами часто идут и рельсы, и трасса. Если рисовать их
 * одной линией, штриховка ляжет поверх сплошной и станет невидимой —
 * поэтому разводим параллельно на пару пикселей.
 */
function offsetFor(net, a, b, mode, pa, pb) {
  const both = net.edges.some(e => samePair(e, a, b) && e.mode === 'road')
            && net.edges.some(e => samePair(e, a, b) && e.mode === 'rail');
  if (!both) return { dx: 0, dy: 0 };

  // направление берём от меньшего id к большему, чтобы сдвиг не зависел
  // от того, в какую сторону мы сейчас едем по этому ребру
  const flip = a > b ? -1 : 1;
  const dx = (pb.x - pa.x) * flip, dy = (pb.y - pa.y) * flip;
  const len = Math.hypot(dx, dy) || 1;
  const sign = mode === 'road' ? 1 : -1;
  return { dx: -dy / len * OFFSET * sign, dy: dx / len * OFFSET * sign };
}

const samePair = (e, a, b) =>
  (e.from === a && e.to === b) || (e.from === b && e.to === a);

/** Стоянка на перегрузку = итог маршрута минус сумма плеч. */
function transshipHours(route) {
  const legSum = route.legs.reduce((s, l) => s + l.hours, 0);
  const count = route.legs.filter(l => l.transshipment).length || 1;
  const diff = (route.hours - legSum) / count;
  return diff > 0.05 ? diff : 4;
}

function legendHtml() {
  return `<div class="legend">
    <span class="legend__item"><i class="legend__line legend__line--rail"></i>железная дорога</span>
    <span class="legend__item"><i class="legend__line legend__line--road"></i>автодорога</span>
    <span class="legend__item"><i class="legend__ring"></i>узел перегрузки</span>
  </div>`;
}
