'use strict';

/* =====================================================================
 * 一、配置常量
 * ===================================================================== */

/** 三个预设难度：行数、列数、雷数（来自 Windows 原版扫雷） */
const LEVELS = {
  beginner: { rows: 9, cols: 9, mines: 10 },
  intermediate: { rows: 16, cols: 16, mines: 40 },
  expert: { rows: 16, cols: 30, mines: 99 },
};

/** 自定义模式允许的行列范围 */
const LIMITS = { minRows: 5, maxRows: 30, minCols: 5, maxCols: 50 };

/** 第一次点击的安全区格数（被点的格子 + 周围 8 格） */
const SAFE_ZONE = 9;

/** 手机上按住多久算"长按插旗"（毫秒） */
const LONG_PRESS_MS = 400;

/** 格子显示尺寸的上下限（像素），会根据窗口大小在这个范围内自动缩放 */
const CELL_MIN = 20;
const CELL_MAX = 36;

/* =====================================================================
 * 二、页面元素
 * ===================================================================== */

/** 简写：根据 id 获取页面元素 */
const $ = (id) => document.getElementById(id);

const boardEl = $('board');              // 棋盘容器
const boardWrapEl = boardEl.parentElement; // 棋盘外层（踩雷时抖动的是它，避免棋盘内部出现滚动条）
const faceEl = $('face');                // 中间的笑脸（重开按钮）
const mineCounterEl = $('mine-counter'); // 剩余雷数
const timerEl = $('timer');              // 计时器
const messageEl = $('message');          // 胜负提示
const bestEl = $('best');                // 最佳成绩
const customForm = $('custom-form');     // 自定义表单
const customRows = $('custom-rows');
const customCols = $('custom-cols');
const customMines = $('custom-mines');
const customHint = $('custom-hint');     // 自定义模式下的密度提示

/* =====================================================================
 * 三、游戏状态（整局游戏的所有数据都放在这里）
 * ===================================================================== */

const state = {
  level: 'beginner', // 当前难度名
  rows: 9,           // 行数
  cols: 9,           // 列数
  mines: 10,         // 雷数

  // 每个格子的数据，一维数组，下标 i 对应第 Math.floor(i / cols) 行、第 i % cols 列
  // 每项结构：{ mine: 是否是雷, adjacent: 周围雷数, revealed: 是否已翻开, flagged: 是否插旗 }
  cells: [],
  cellEls: [],       // 每个格子对应的 DOM 元素，和 cells 下标一一对应

  started: false,    // 是否已经点了第一下（点了才布雷）
  over: false,       // 本局是否已结束（胜或负）
  revealedCount: 0,  // 已翻开的格子数，用来判断胜利
  flagCount: 0,      // 已插的旗子数，用来算"剩余雷数"
  startTime: 0,      // 开始计时的时间戳
  timerId: null,     // 计时器的 setInterval 句柄
};

/* =====================================================================
 * 四、随机数
 * ===================================================================== */

/**
 * 生成一个 [0, max) 范围内均匀分布的随机整数。
 *
 * 用浏览器的 crypto.getRandomValues 产生 32 位随机数，比 Math.random 更难预测。
 * 直接对 max 取余会让较小的数略多出现（取模偏差），所以先算出不超过 2^32 的
 * 最大的 max 整数倍 limit，随机数落在 limit 以上就丢掉重抽（拒绝采样）。
 *
 * @param {number} max 上限（不包含）
 * @returns {number} 0 到 max-1 之间的整数
 */
function randomInt(max) {
  // 极老的浏览器没有 crypto，退回到 Math.random
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

/* =====================================================================
 * 五、棋盘数据：邻居、布雷、计算数字
 * ===================================================================== */

/**
 * 找出某个格子周围的所有邻居（最多 8 个，边角格子会少一些）。
 *
 * @param {number} index 格子下标
 * @returns {number[]} 邻居格子的下标数组
 */
function neighbors(index) {
  const { rows, cols } = state;
  const r = Math.floor(index / cols); // 当前行
  const c = index % cols;             // 当前列
  const result = [];

  // dr、dc 分别取 -1、0、1，组合出上下左右和四个斜角
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue; // 跳过自己
      const nr = r + dr;
      const nc = c + dc;
      // 只保留没有超出棋盘边界的位置
      if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
        result.push(nr * cols + nc);
      }
    }
  }
  return result;
}

/**
 * 随机布雷，并算出每个格子周围的雷数。
 *
 * 在玩家第一次点击后才调用：被点的格子和它周围 8 格不放雷，
 * 保证第一下不会炸，而且会展开一片区域。
 *
 * 布雷方法是"部分 Fisher–Yates 洗牌"：把所有可放雷的格子编号放进数组，
 * 只打乱前 mines 个位置，这前 mines 个就是雷。每种布局出现的概率完全相同。
 *
 * @param {number} safeIndex 第一次点击的格子下标
 */
function placeMines(safeIndex) {
  const total = state.rows * state.cols;
  const safe = new Set([safeIndex, ...neighbors(safeIndex)]);

  // 候选格子：安全区以外的所有格子
  let candidates = [];
  for (let i = 0; i < total; i++) {
    if (!safe.has(i)) candidates.push(i);
  }

  // 万一雷太多、安全区外放不下，就只保证被点的那一格安全
  if (candidates.length < state.mines) {
    candidates = [];
    for (let i = 0; i < total; i++) {
      if (i !== safeIndex) candidates.push(i);
    }
  }

  // 第 i 步：从 i 到末尾之间随机挑一个，换到位置 i，它就成为第 i 颗雷
  for (let i = 0; i < state.mines; i++) {
    const j = i + randomInt(candidates.length - i);
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    state.cells[candidates[i]].mine = true;
  }

  // 统计每个格子周围有几颗雷，就是翻开后显示的数字
  for (let i = 0; i < total; i++) {
    state.cells[i].adjacent = neighbors(i).filter((n) => state.cells[n].mine).length;
  }
}

/* =====================================================================
 * 六、显示相关
 * ===================================================================== */

/**
 * 根据格子的数据，刷新它在页面上的样子（未翻开 / 插旗 / 数字 / 雷）。
 *
 * @param {number} index 格子下标
 */
function renderCell(index) {
  const cell = state.cells[index];
  const el = state.cellEls[index];
  el.className = 'cell';
  el.textContent = '';

  if (cell.revealed) {
    el.classList.add('revealed');
    if (cell.mine) {
      el.classList.add('mine');
      el.textContent = '💣';
    } else if (cell.adjacent > 0) {
      el.classList.add('n' + cell.adjacent); // n1~n8 对应不同颜色
      el.textContent = cell.adjacent;
    }
  } else if (cell.flagged) {
    el.classList.add('flagged');
    el.textContent = '🚩';
  }
}

/**
 * 把数字限制在显示范围内（-99 ~ 999），防止插旗过多或计时太久时显示溢出。
 *
 * @param {number} n 要显示的数字
 * @returns {string} 用于显示的文字
 */
function formatCounter(n) {
  return String(Math.max(-99, Math.min(999, n)));
}

/** 刷新"剩余雷数"：总雷数减去已插旗数（插多了会变成负数，提示玩家插错了） */
function updateMineCounter() {
  mineCounterEl.textContent = formatCounter(state.mines - state.flagCount);
}

/**
 * 在棋盘下方显示一条提示。
 *
 * @param {string} text 提示文字，传空字符串表示隐藏
 * @param {'info'|'win'|'lose'} [type='info'] 提示类型，决定颜色
 */
function setMessage(text, type = 'info') {
  messageEl.textContent = text;
  messageEl.className = 'message ' + type;
}

/**
 * 根据窗口大小计算格子尺寸，让整个棋盘尽量完整显示在屏幕内。
 * 格子大小限制在 CELL_MIN ~ CELL_MAX 之间，实在放不下时棋盘区域可以滚动。
 */
function fitBoard() {
  const availW = Math.min(window.innerWidth - 80, 1500); // 减去面板和棋盘的内边距
  const availH = window.innerHeight - 380;               // 减去标题、难度栏、状态栏等高度
  // 每格实际占用约 1.1 倍尺寸（格子 + 间隙）
  const byWidth = Math.floor(availW / (state.cols * 1.1));
  const byHeight = Math.floor(availH / (state.rows * 1.1));
  const size = Math.max(CELL_MIN, Math.min(CELL_MAX, byWidth, byHeight));
  const gap = Math.max(2, Math.round(size * 0.1));

  boardEl.style.setProperty('--cell', size + 'px');
  boardEl.style.setProperty('--gap', gap + 'px');
}

/* =====================================================================
 * 七、计时器
 * ===================================================================== */

/** 开始计时：记录开始时间，之后每 250 毫秒刷新一次显示的秒数 */
function startTimer() {
  state.startTime = Date.now();
  timerEl.textContent = formatCounter(0);
  state.timerId = setInterval(() => {
    const sec = Math.floor((Date.now() - state.startTime) / 1000);
    timerEl.textContent = formatCounter(sec);
  }, 250);
}

/** 停止计时 */
function stopTimer() {
  clearInterval(state.timerId);
  state.timerId = null;
}

/* =====================================================================
 * 八、最佳成绩（保存在浏览器的 localStorage 中，刷新页面不会丢）
 * ===================================================================== */

/**
 * 生成当前配置的存储键名。不同尺寸、雷数的成绩分开保存。
 *
 * @returns {string} 例如 "minesweeper-best-9x9-10"
 */
function bestKey() {
  return `minesweeper-best-${state.rows}x${state.cols}-${state.mines}`;
}

/** 读取并显示当前配置的最佳成绩，没有记录时不显示 */
function showBest() {
  const best = localStorage.getItem(bestKey());
  bestEl.textContent = best ? `🏆 最佳 ${Number(best).toFixed(2)} 秒` : '';
}

/* =====================================================================
 * 九、游戏流程
 * ===================================================================== */

/**
 * 开始新的一局：清空所有数据，按当前行列数重新生成格子。
 * 注意这里还没有布雷，要等玩家第一次点击时才布雷。
 */
function newGame() {
  stopTimer();

  // 重置格子数据
  const total = state.rows * state.cols;
  state.cells = Array.from({ length: total }, () => ({
    mine: false,
    adjacent: 0,
    revealed: false,
    flagged: false,
  }));
  state.started = false;
  state.over = false;
  state.revealedCount = 0;
  state.flagCount = 0;

  // 重新生成格子元素（用 DocumentFragment 一次性插入，比逐个插入快）
  boardEl.innerHTML = '';
  boardEl.className = 'board';
  boardWrapEl.classList.remove('shake');
  boardEl.style.setProperty('--cols', state.cols);
  const frag = document.createDocumentFragment();
  state.cellEls = [];
  for (let i = 0; i < total; i++) {
    const el = document.createElement('div');
    el.className = 'cell';
    el.dataset.index = i; // 记下下标，点击时用来找到对应的格子数据
    frag.appendChild(el);
    state.cellEls.push(el);
  }
  boardEl.appendChild(frag);

  // 重置界面显示
  fitBoard();
  updateMineCounter();
  timerEl.textContent = formatCounter(0);
  faceEl.textContent = '🙂';
  setMessage('');
  showBest();
}

/**
 * 从某个格子开始翻开，遇到数字为 0 的格子就继续向四周扩散（洪水填充）。
 *
 * 用"栈 + 循环"代替递归，避免大棋盘上递归太深导致栈溢出。
 * 数字为 0 说明周围没有雷，所以扩散过程中永远不会翻到雷。
 *
 * @param {number} index 起点格子下标
 */
function revealFrom(index) {
  const stack = [index];
  while (stack.length) {
    const k = stack.pop();
    const cell = state.cells[k];
    if (cell.revealed || cell.flagged) continue; // 已翻开或插了旗的跳过

    cell.revealed = true;
    state.revealedCount++;
    renderCell(k);

    // 是 0 就把还没翻开的邻居放进栈里，接下来继续翻
    if (cell.adjacent === 0) {
      for (const n of neighbors(k)) {
        const nc = state.cells[n];
        if (!nc.revealed && !nc.flagged) stack.push(n);
      }
    }
  }
}

/**
 * 翻开一个格子：是雷就判负，否则正常翻开（可能连带展开一片）。
 *
 * @param {number} index 格子下标
 */
function openCell(index) {
  const cell = state.cells[index];
  if (cell.revealed || cell.flagged) return;
  if (cell.mine) {
    lose(index);
    return;
  }
  revealFrom(index);
}

/**
 * 快速翻开（chord）：点击一个已翻开的数字时，
 * 如果它周围插的旗数正好等于这个数字，就把其余没插旗的邻居全部翻开。
 * 旗子插错的话，这一步会翻到雷而失败。
 *
 * @param {number} index 被点击的数字格子下标
 */
function chord(index) {
  const cell = state.cells[index];
  if (!cell.revealed || cell.adjacent === 0) return;

  const around = neighbors(index);
  const flags = around.filter((n) => state.cells[n].flagged).length;
  if (flags !== cell.adjacent) return; // 旗数不对，什么也不做

  for (const n of around) {
    if (state.over) return; // 已经踩雷就不用继续翻了
    openCell(n);
  }
}

/**
 * 处理一次"翻开"操作（左键点击或手机点按）。
 * 如果是本局第一下，先布雷并开始计时；
 * 点的是已翻开的数字就执行快速翻开，否则翻开该格；最后检查是否胜利。
 *
 * @param {number} index 被点击的格子下标
 */
function handleOpen(index) {
  if (state.over) return;

  if (!state.started) {
    placeMines(index);
    state.started = true;
    startTimer();
  }

  if (state.cells[index].revealed) {
    chord(index);
  } else {
    openCell(index);
  }

  if (!state.over) checkWin();
}

/**
 * 插旗 / 取消插旗。已翻开的格子不能插旗。
 *
 * @param {number} index 格子下标
 */
function toggleFlag(index) {
  if (state.over) return;
  const cell = state.cells[index];
  if (cell.revealed) return;

  cell.flagged = !cell.flagged;
  state.flagCount += cell.flagged ? 1 : -1;
  renderCell(index);
  updateMineCounter();
}

/**
 * 检查是否胜利：所有不是雷的格子都翻开了就算赢（不要求把雷都插上旗）。
 * 胜利后停表、自动给所有雷插旗、保存最佳成绩并显示提示。
 */
function checkWin() {
  const safeCells = state.rows * state.cols - state.mines;
  if (state.revealedCount !== safeCells) return;

  state.over = true;
  stopTimer();
  const seconds = (Date.now() - state.startTime) / 1000;
  boardEl.classList.add('over', 'win');
  faceEl.textContent = '😎';

  // 把还没插旗的雷都插上旗
  state.cells.forEach((cell, i) => {
    if (cell.mine && !cell.flagged) {
      cell.flagged = true;
      renderCell(i);
    }
  });
  state.flagCount = state.mines;
  updateMineCounter();

  // 比之前的纪录快（或者还没有纪录）就保存
  const key = bestKey();
  const prev = Number(localStorage.getItem(key));
  const isRecord = !prev || seconds < prev;
  if (isRecord) localStorage.setItem(key, seconds.toFixed(3));

  setMessage(`🎉 胜利！用时 ${seconds.toFixed(2)} 秒${isRecord ? '，新纪录！' : ''}`, 'win');
  showBest();
}

/**
 * 踩雷失败：停表，显示所有雷，踩中的那颗标红，插错的旗显示 ❌。
 *
 * @param {number} explodedIndex 踩中的雷的下标
 */
function lose(explodedIndex) {
  state.over = true;
  stopTimer();
  boardEl.classList.add('over', 'lose');
  boardWrapEl.classList.add('shake');
  faceEl.textContent = '😵';

  state.cells.forEach((cell, i) => {
    const el = state.cellEls[i];
    if (cell.mine && !cell.flagged) {
      el.className = 'cell revealed mine';
      el.textContent = '💣';
    } else if (!cell.mine && cell.flagged) {
      el.className = 'cell revealed wrong';
      el.textContent = '❌';
    }
  });
  state.cellEls[explodedIndex].classList.add('exploded');

  setMessage('💥 踩到雷了！点击上方笑脸再来一局', 'lose');
}

/* =====================================================================
 * 十、鼠标与触屏交互
 * ===================================================================== */

/**
 * 从鼠标/触摸事件中找到被点中的格子下标。
 *
 * @param {Event} e 事件对象
 * @returns {number} 格子下标，没点在格子上时返回 -1
 */
function cellIndexFromEvent(e) {
  const el = e.target.closest('.cell');
  return el ? Number(el.dataset.index) : -1;
}

let lastPointerType = 'mouse'; // 最近一次操作是鼠标还是触屏
let longPressTimer = null;     // 长按计时器
let longPressFired = false;    // 本次按压是否已经触发了长按插旗
let pressStart = null;         // 按下时的坐标，用来判断手指是否移动

// 按下：鼠标左键按下时笑脸变成"紧张"表情；触屏按下时开始长按计时
boardEl.addEventListener('pointerdown', (e) => {
  lastPointerType = e.pointerType;
  const index = cellIndexFromEvent(e);
  if (index < 0 || state.over) return;

  if (e.button === 0) faceEl.textContent = '😮';

  if (e.pointerType === 'touch') {
    longPressFired = false;
    pressStart = { x: e.clientX, y: e.clientY };
    clearTimeout(longPressTimer);
    longPressTimer = setTimeout(() => {
      longPressFired = true;
      toggleFlag(index);
      if (navigator.vibrate) navigator.vibrate(30); // 支持的手机会轻微震动
    }, LONG_PRESS_MS);
  }
});

// 手指移动超过 10 像素就当作是在滑动页面，取消长按
boardEl.addEventListener('pointermove', (e) => {
  if (!pressStart) return;
  if (Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y) > 10) {
    clearTimeout(longPressTimer);
    pressStart = null;
  }
});

/** 松开、取消或移出棋盘时：取消长按计时，笑脸恢复正常 */
function endPress() {
  clearTimeout(longPressTimer);
  pressStart = null;
  if (!state.over) faceEl.textContent = '🙂';
}

boardEl.addEventListener('pointerup', endPress);
boardEl.addEventListener('pointercancel', endPress);
boardEl.addEventListener('pointerleave', endPress);

// 左键点击 / 手机点按：翻开格子。如果刚刚触发了长按插旗，这次点击就忽略
boardEl.addEventListener('click', (e) => {
  const index = cellIndexFromEvent(e);
  if (index < 0) return;
  if (longPressFired) {
    longPressFired = false;
    return;
  }
  handleOpen(index);
});

// 鼠标中键点击：快速翻开
boardEl.addEventListener('auxclick', (e) => {
  if (e.button !== 1) return;
  const index = cellIndexFromEvent(e);
  if (index >= 0 && !state.over && state.started) {
    chord(index);
    if (!state.over) checkWin();
  }
});

// 右键：插旗，并阻止浏览器弹出右键菜单。
// 部分手机长按也会触发右键事件，这里忽略触屏来源，避免和长按插旗重复
boardEl.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (lastPointerType === 'touch') return;
  const index = cellIndexFromEvent(e);
  if (index >= 0) toggleFlag(index);
});

// 点击笑脸：重新开始
faceEl.addEventListener('click', newGame);

// 键盘快捷键：R 或 F2 重新开始（在输入框里打字时不触发）
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'r' || e.key === 'R' || e.key === 'F2') {
    e.preventDefault();
    newGame();
  }
});

// 窗口大小变化时重新计算格子尺寸
window.addEventListener('resize', fitBoard);

/* =====================================================================
 * 十一、难度切换与自定义
 * ===================================================================== */

/**
 * 计算某个尺寸下最多能放多少雷（要给第一次点击留出 9 格安全区）。
 *
 * @param {number} rows 行数
 * @param {number} cols 列数
 * @returns {number} 雷数上限
 */
function maxMinesFor(rows, cols) {
  return rows * cols - SAFE_ZONE;
}

/**
 * 把输入值转成整数并限制在 [min, max] 范围内，输入非法时返回 min。
 *
 * @param {string|number} value 原始输入
 * @param {number} min 最小值
 * @param {number} max 最大值
 * @returns {number} 处理后的整数
 */
function clampInt(value, min, max) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

/**
 * 根据自定义输入框的值，实时显示雷密度、难度评价和推荐雷数。
 * 推荐范围按 12% ~ 21% 的雷密度计算（对应原版初级到高级）。
 */
function updateCustomHint() {
  const rows = clampInt(customRows.value, LIMITS.minRows, LIMITS.maxRows);
  const cols = clampInt(customCols.value, LIMITS.minCols, LIMITS.maxCols);
  const maxMines = maxMinesFor(rows, cols);
  const mines = clampInt(customMines.value, 1, maxMines);
  customMines.max = maxMines;

  const density = (mines / (rows * cols)) * 100;
  let level = '适中';
  if (density < 10) level = '偏简单';
  else if (density > 22) level = '偏难，常需猜雷';
  const low = Math.round(rows * cols * 0.12);
  const high = Math.round(rows * cols * 0.21);

  customHint.textContent =
    `${rows}×${cols}，雷密度 ${density.toFixed(1)}%（${level}）。` +
    `推荐雷数 ${low}–${high}，上限 ${maxMines}`;
  customHint.classList.toggle('warn', density > 22 || density < 10);
}

// 点击难度按钮：高亮该按钮；预设难度直接开新局，自定义则展开表单
$('levels').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-level]');
  if (!btn) return;
  const level = btn.dataset.level;
  document.querySelectorAll('#levels button').forEach((b) => {
    b.classList.toggle('active', b === btn);
  });

  if (level === 'custom') {
    customForm.classList.remove('hidden');
    updateCustomHint();
    return;
  }
  customForm.classList.add('hidden');
  state.level = level;
  Object.assign(state, LEVELS[level]);
  newGame();
});

// 自定义输入框内容变化时，实时刷新提示
[customRows, customCols, customMines].forEach((input) => {
  input.addEventListener('input', updateCustomHint);
});

// 提交自定义表单：校正输入值后，用自定义尺寸开新局
customForm.addEventListener('submit', (e) => {
  e.preventDefault(); // 阻止表单默认的刷新页面行为
  const rows = clampInt(customRows.value, LIMITS.minRows, LIMITS.maxRows);
  const cols = clampInt(customCols.value, LIMITS.minCols, LIMITS.maxCols);
  const mines = clampInt(customMines.value, 1, maxMinesFor(rows, cols));
  customRows.value = rows;
  customCols.value = cols;
  customMines.value = mines;
  updateCustomHint();

  state.level = 'custom';
  Object.assign(state, { rows, cols, mines });
  newGame();
});

/* =====================================================================
 * 十二、启动：页面加载完就开一局初级
 * ===================================================================== */
newGame();
