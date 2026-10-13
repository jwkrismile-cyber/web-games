'use strict';

/* =====================================================================
 * 叠叠消：点没有被挡住的色块，放进 7 格卡槽；三块同色消除。
 * 关卡用“倒着发牌”生成，保证至少存在一种通关点法。
 * ===================================================================== */

const SLOT_LIMIT = 7;
const TILE_W = 76;
const TILE_H = 88;
const STEP_X = 48;
const STEP_Y = 44;
const OVERLAP_PAD = 10;
const BOARD_PAD = 18;

/**
 * 8 关，越往后块越多、叠得越厚、道具越少。
 * stack：新块贴着已有块放的概率；pile：直接叠在同一格上的概率。
 */
const LEVELS = [
  { cols: 5, rows: 6, colorCount: 4, triples: 2, undo: 3, shuffle: 1, stack: 0.5, pile: 0.15 },
  { cols: 6, rows: 6, colorCount: 5, triples: 3, undo: 3, shuffle: 1, stack: 0.58, pile: 0.22 },
  { cols: 6, rows: 7, colorCount: 6, triples: 4, undo: 3, shuffle: 1, stack: 0.66, pile: 0.3 },
  { cols: 7, rows: 8, colorCount: 7, triples: 5, undo: 2, shuffle: 1, stack: 0.74, pile: 0.4 },
  { cols: 8, rows: 8, colorCount: 8, triples: 6, undo: 2, shuffle: 1, stack: 0.8, pile: 0.48 },
  { cols: 8, rows: 9, colorCount: 8, triples: 8, undo: 1, shuffle: 1, stack: 0.86, pile: 0.55 },
  { cols: 9, rows: 10, colorCount: 8, triples: 10, undo: 1, shuffle: 0, stack: 0.9, pile: 0.62 },
  { cols: 9, rows: 11, colorCount: 8, triples: 13, undo: 0, shuffle: 0, stack: 0.94, pile: 0.72 },
];

const $ = (id) => document.getElementById(id);
const boardEl = $('board');
const boardWrapEl = $('board-wrap');
const slotEl = $('slot');
const leftEl = $('left-counter');
const messageEl = $('message');
const restartBtn = $('btn-restart');
const undoBtn = $('btn-undo');
const shuffleBtn = $('btn-shuffle');
const undoLeftEl = $('undo-left');
const shuffleLeftEl = $('shuffle-left');

const state = {
  level: 0,
  cols: 5,
  rows: 6,
  tiles: [],
  slot: [],
  over: false,
  won: false,
  undoLeft: 3,
  shuffleLeft: 1,
  history: [],
};

/**
 * 这一关一共多少块。
 * @param {object} cfg
 * @returns {number}
 */
function tileCount(cfg) {
  return cfg.colorCount * cfg.triples * 3;
}

/**
 * 生成 [0, max) 的均匀随机整数。
 * @param {number} max
 * @returns {number}
 */
function randomInt(max) {
  if (!window.crypto || !crypto.getRandomValues) {
    return Math.floor(Math.random() * max);
  }
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x100000000 / max) * max;
  let x;
  do {
    crypto.getRandomValues(buf);
    x = buf[0];
  } while (x >= limit);
  return x % max;
}

/**
 * 打乱数组（Fisher–Yates）。
 * @param {Array} arr
 * @returns {Array} 原数组
 */
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * 两块牌的矩形是否有足够重叠（忽略只擦到边的情况）。
 * @param {{gx:number, gy:number}} a
 * @param {{gx:number, gy:number}} b
 * @returns {boolean}
 */
function overlaps(a, b) {
  const ax1 = a.gx * STEP_X;
  const ay1 = a.gy * STEP_Y;
  const bx1 = b.gx * STEP_X;
  const by1 = b.gy * STEP_Y;
  return (
    ax1 + OVERLAP_PAD < bx1 + TILE_W &&
    ax1 + TILE_W - OVERLAP_PAD > bx1 &&
    ay1 + OVERLAP_PAD < by1 + TILE_H &&
    ay1 + TILE_H - OVERLAP_PAD > by1
  );
}

/**
 * 这块牌是否还在棋盘上（没进卡槽、没被消掉）。
 * @param {object} tile
 * @returns {boolean}
 */
function isOnBoard(tile) {
  return !tile.removed && !state.slot.includes(tile.id);
}

/**
 * 这块牌是否被更上层的牌压住。
 * 已经进卡槽的牌不算压住，否则下层会永远点不了。
 * @param {object} tile
 * @returns {boolean}
 */
function isBlocked(tile) {
  if (!isOnBoard(tile)) return true;
  return state.tiles.some(
    (other) =>
      other !== tile &&
      isOnBoard(other) &&
      other.layer > tile.layer &&
      overlaps(tile, other)
  );
}

/**
 * 倒着发牌：从“已经消完”往回模拟，保证可解。
 *
 * 正着玩只有两步：从棋盘拿进卡槽、卡槽三消。
 * 倒着就变成：把 3 张同色塞进卡槽（撤销一次消除），
 * 再从卡槽拿出一张放到棋盘顶层（撤销一次拾取）。
 *
 * @param {{cols:number, rows:number, colorCount:number, triples:number}} cfg
 * @returns {object[] | null} 失败时返回 null，由调用方重试
 */
function dealSolvable(cfg) {
  const unused = Array.from({ length: cfg.colorCount }, () => cfg.triples * 3);
  const total = unused.reduce((sum, n) => sum + n, 0);
  const slot = [];
  const placements = [];

  const pickColor = () => {
    const ids = [];
    unused.forEach((n, i) => {
      if (n >= 3) ids.push(i);
    });
    return ids.length ? ids[randomInt(ids.length)] : -1;
  };

  const randomCell = () => {
    const stack = cfg.stack ?? 0.7;
    const pile = cfg.pile ?? 0.2;
    if (placements.length && Math.random() < stack) {
      const ref = placements[randomInt(placements.length)];
      if (Math.random() < pile) {
        return { gx: ref.gx, gy: ref.gy };
      }
      return {
        gx: Math.max(0, Math.min(cfg.cols - 1, ref.gx + randomInt(3) - 1)),
        gy: Math.max(0, Math.min(cfg.rows - 1, ref.gy + randomInt(3) - 1)),
      };
    }
    return { gx: randomInt(cfg.cols), gy: randomInt(cfg.rows) };
  };

  let guard = 0;
  while (placements.length < total && guard++ < Math.max(8000, total * 30)) {
    const canUnmatch = slot.length + 3 <= SLOT_LIMIT && unused.some((n) => n >= 3);
    const canUnpick = slot.length > 0;
    let action = null;

    if (canUnmatch && !canUnpick) action = 'unmatch';
    else if (!canUnmatch && canUnpick) action = 'unpick';
    else if (canUnmatch && canUnpick) {
      if (slot.length <= 1) action = Math.random() < 0.8 ? 'unmatch' : 'unpick';
      else if (slot.length >= 5) action = 'unpick';
      else action = Math.random() < 0.35 ? 'unmatch' : 'unpick';
    } else {
      break;
    }

    if (action === 'unmatch') {
      const color = pickColor();
      unused[color] -= 3;
      slot.push(color, color, color);
    } else {
      const idx = randomInt(slot.length);
      const color = slot.splice(idx, 1)[0];
      const pos = randomCell();
      placements.push({ color, gx: pos.gx, gy: pos.gy, layer: placements.length });
    }
  }

  if (placements.length !== total || unused.some((n) => n > 0) || slot.length) {
    return null;
  }
  return placements;
}

/**
 * 生成一局棋盘数据；倒着发牌失败就重试。
 * @param {number} level
 * @returns {object[]}
 */
function createTiles(level) {
  const cfg = LEVELS[level];
  let placements = null;
  for (let i = 0; i < 80 && !placements; i++) {
    placements = dealSolvable(cfg);
  }
  if (!placements) {
    placements = [];
    for (let c = 0; c < cfg.colorCount; c++) {
      for (let k = 0; k < cfg.triples * 3; k++) {
        placements.push({
          color: c,
          gx: randomInt(cfg.cols),
          gy: randomInt(cfg.rows),
          layer: 0,
        });
      }
    }
    shuffle(placements);
    placements.forEach((p, i) => {
      p.layer = i;
    });
  }
  return placements.map((p, id) => ({
    id,
    color: p.color,
    gx: p.gx,
    gy: p.gy,
    layer: p.layer,
    removed: false,
  }));
}

/**
 * 当前还在棋盘或卡槽里的块数。
 * @returns {number}
 */
function remainingCount() {
  return state.tiles.filter((t) => !t.removed).length;
}

/**
 * 刷新剩余数量、道具次数和按钮状态。
 */
function updateHud() {
  leftEl.textContent = String(remainingCount());
  undoLeftEl.textContent = String(state.undoLeft);
  shuffleLeftEl.textContent = String(state.shuffleLeft);
  undoBtn.disabled = state.over || state.undoLeft <= 0 || state.history.length === 0;
  shuffleBtn.disabled = state.over || state.shuffleLeft <= 0;
}

/**
 * 底部提示。空字符串表示隐藏。
 * @param {string} text
 * @param {'info'|'win'|'lose'} [type='info']
 */
function setMessage(text, type = 'info') {
  messageEl.textContent = text;
  messageEl.className = 'message ' + type;
}

/**
 * 按本局行列把画布定死。消除过程中不再改尺寸，避免画面跳动。
 */
function fitBoard() {
  const naturalW = (state.cols - 1) * STEP_X + TILE_W + BOARD_PAD * 2 + 8;
  const naturalH = (state.rows - 1) * STEP_Y + TILE_H + BOARD_PAD * 2 + 8;
  const availW = Math.min(window.innerWidth - 48, 680);
  const availH = Math.max(220, window.innerHeight - 340);
  const scale = Math.min(1, availW / naturalW, availH / naturalH);

  boardEl.style.width = naturalW + 'px';
  boardEl.style.height = naturalH + 'px';
  boardEl.style.transform = 'scale(' + scale + ')';
  boardWrapEl.style.height = naturalH * scale + 'px';
}

/**
 * 根据遮挡情况，给每块牌加上/去掉 blocked。
 */
function refreshBlocked() {
  state.tiles.forEach((tile) => {
    if (tile.removed || !tile.el) return;
    const blocked = isBlocked(tile);
    tile.el.classList.toggle('blocked', blocked);
    tile.el.style.pointerEvents = blocked ? 'none' : 'auto';
  });
}

/**
 * 在棋盘上画出所有还没被拿进卡槽的牌。
 */
function renderBoard() {
  boardEl.innerHTML = '';
  const live = state.tiles
    .filter((t) => !t.removed && !state.slot.includes(t.id))
    .sort((a, b) => a.layer - b.layer);

  live.forEach((tile) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'tile c' + tile.color + ' p' + tile.color;
    el.style.left = BOARD_PAD + tile.gx * STEP_X + 'px';
    el.style.top = BOARD_PAD + tile.gy * STEP_Y + 'px';
    el.style.width = TILE_W + 'px';
    el.style.height = TILE_H + 'px';
    el.style.zIndex = String(10 + tile.layer);
    el.dataset.id = String(tile.id);
    el.addEventListener('click', () => pickTile(tile.id));
    boardEl.appendChild(el);
    tile.el = el;
  });
  refreshBlocked();
}

/**
 * 画出 7 格卡槽。
 */
function renderSlot() {
  slotEl.innerHTML = '';
  for (let i = 0; i < SLOT_LIMIT; i++) {
    const cell = document.createElement('div');
    cell.className = 'slot-cell';
    const id = state.slot[i];
    if (id !== undefined) {
      const tile = state.tiles[id];
      const el = document.createElement('div');
      el.className = 'tile c' + tile.color + ' p' + tile.color;
      cell.appendChild(el);
    }
    slotEl.appendChild(cell);
  }
}

/**
 * 保存当前卡槽和移除状态，供撤回使用。
 */
function pushHistory() {
  state.history.push({
    slot: state.slot.slice(),
    removed: state.tiles.map((t) => t.removed),
  });
}

/**
 * 把新牌插入卡槽：同类靠在一起，没有同类就放最后。
 * @param {number} tileId
 */
function insertIntoSlot(tileId) {
  const color = state.tiles[tileId].color;
  let last = -1;
  state.slot.forEach((id, i) => {
    if (state.tiles[id].color === color) last = i;
  });
  if (last >= 0) state.slot.splice(last + 1, 0, tileId);
  else state.slot.push(tileId);
}

/**
 * 卡槽里每种颜色若满 3 张，消掉 3 张。
 * @returns {number[]} 被消掉的牌 id
 */
function matchSlot() {
  const counts = {};
  state.slot.forEach((id) => {
    const c = state.tiles[id].color;
    counts[c] = (counts[c] || 0) + 1;
  });
  const matched = [];
  Object.keys(counts).forEach((key) => {
    const color = Number(key);
    if (counts[color] < 3) return;
    let left = 3;
    state.slot = state.slot.filter((id) => {
      if (left > 0 && state.tiles[id].color === color) {
        matched.push(id);
        left--;
        return false;
      }
      return true;
    });
  });
  matched.forEach((id) => {
    state.tiles[id].removed = true;
  });
  return matched;
}

/**
 * 检查胜利或卡槽已满失败。
 */
function checkEnd() {
  if (remainingCount() === 0) {
    state.over = true;
    state.won = true;
    if (state.level < LEVELS.length - 1) {
      setMessage('过关了，进入下一关', 'win');
      restartBtn.textContent = '下一关';
    } else {
      setMessage('全部通关', 'win');
      restartBtn.textContent = '重开';
    }
    updateHud();
    return;
  }
  if (state.slot.length >= SLOT_LIMIT) {
    state.over = true;
    state.won = false;
    setMessage('卡槽满了，点重开再来一局', 'lose');
    restartBtn.textContent = '重开';
    updateHud();
  }
}

/**
 * 点一块没有被挡住的牌，放进卡槽。
 * @param {number} id
 */
function pickTile(id) {
  if (state.over) return;
  const tile = state.tiles[id];
  if (!tile || tile.removed || state.slot.includes(id)) return;
  if (isBlocked(tile)) return;

  pushHistory();
  insertIntoSlot(id);
  if (tile.el) {
    tile.el.classList.add('leaving');
    tile.el = null;
  }

  matchSlot();
  renderBoard();
  renderSlot();
  updateHud();
  checkEnd();
}

/**
 * 撤回上一步拾取（连同那一步触发的消除一起还原）。
 */
function undo() {
  if (state.over || state.undoLeft <= 0 || state.history.length === 0) return;
  const snap = state.history.pop();
  state.slot = snap.slot.slice();
  state.tiles.forEach((t, i) => {
    t.removed = snap.removed[i];
    t.el = null;
  });
  state.undoLeft--;
  renderBoard();
  renderSlot();
  updateHud();
  setMessage('');
}

/**
 * 打乱场上剩余牌的位置，层数一起换，避免一直被同一叠挡住。
 */
function shuffleBoard() {
  if (state.over || state.shuffleLeft <= 0) return;
  const live = state.tiles.filter((t) => !t.removed && !state.slot.includes(t.id));
  const poses = live.map((t) => ({ gx: t.gx, gy: t.gy, layer: t.layer }));
  shuffle(poses);
  live.forEach((t, i) => {
    t.gx = poses[i].gx;
    t.gy = poses[i].gy;
    t.layer = poses[i].layer;
  });
  state.shuffleLeft--;
  state.history = [];
  renderBoard();
  updateHud();
}

/**
 * 开一局新游戏。
 */
function highlightLevel() {
  document.querySelectorAll('#levels button').forEach((b) => {
    b.classList.toggle('active', Number(b.dataset.level) === state.level);
  });
}

/**
 * 开一局。won 且还有下一关时，点「下一关」会进到下一关。
 */
function newGame(advance) {
  if (advance && state.won && state.level < LEVELS.length - 1) {
    state.level += 1;
  }
  const cfg = LEVELS[state.level];
  state.cols = cfg.cols;
  state.rows = cfg.rows;
  state.tiles = createTiles(state.level);
  state.slot = [];
  state.over = false;
  state.won = false;
  state.undoLeft = cfg.undo;
  state.shuffleLeft = cfg.shuffle;
  state.history = [];
  restartBtn.textContent = '重开';
  setMessage('');
  highlightLevel();
  fitBoard();
  renderBoard();
  renderSlot();
  updateHud();
}

function renderLevelNav() {
  const nav = $('levels');
  nav.innerHTML = '';
  LEVELS.forEach((cfg, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.level = String(i);
    btn.textContent = i + 1 + ' · ' + tileCount(cfg);
    if (i === state.level) btn.classList.add('active');
    nav.appendChild(btn);
  });
}

$('levels').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-level]');
  if (!btn) return;
  state.level = Number(btn.dataset.level);
  state.won = false;
  newGame(false);
});

restartBtn.addEventListener('click', () => newGame(true));
undoBtn.addEventListener('click', undo);
shuffleBtn.addEventListener('click', shuffleBoard);
window.addEventListener('resize', fitBoard);

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    newGame(false);
  }
});

renderLevelNav();
newGame(false);
