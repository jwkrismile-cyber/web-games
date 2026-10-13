'use strict';

/* =====================================================================
 * 打砖块：挡板接球，打掉全部普通砖过关。
 * 每关是不同的砖块图案。球每次撞击都会略微加速。
 * ===================================================================== */

const W = 480;
const H = 640;
const LIVES = 3;
const COLS = 9;
const BRICK_GAP = 6;
const BRICK_TOP = 78;
const BRICK_H = 22;
const PADDLE_H = 12;
const PADDLE_Y = H - 52;
const BALL_R = 7;
const BASE_SPEED = 6.8;
const SPEED_BOOST = 1.045;
const MAX_SPEED = 13;
const STEP_PX = 6;

/**
 * 图案里 # 是可打碎的玻璃砖，S 是打不破的玻璃，. 是空位。
 * 砖块按 9 列对齐摆放，大小不变。每一关只是组成的轮廓不同，从少到多、从薄到厚。
 */
const LEVELS = [
  {
    hp: 1,
    rows: [
      '....#....',
      '...###...',
      '..#####..',
      '.#######.',
    ],
  },
  {
    hp: 1,
    rows: [
      '#.......#',
      '##.....##',
      '###...###',
      '####.####',
      '###...###',
      '##.....##',
      '#.......#',
    ],
  },
  {
    hp: 1,
    rows: [
      '....#....',
      '...###...',
      '..#####..',
      '.#######.',
      '#########',
      '.#######.',
      '..#####..',
      '...###...',
    ],
  },
  {
    hp: 2,
    rows: [
      '#########',
      '.#######.',
      '..#####..',
      '...###...',
      '....#....',
      '....#....',
      '...###...',
    ],
  },
  {
    hp: 2,
    rows: [
      '.##...##.',
      '#########',
      '#########',
      '.#######.',
      '..#####..',
      '...###...',
      '....#....',
    ],
  },
  {
    hp: 2,
    rows: [
      'SSSSSSSSS',
      'S#######S',
      'S#.....#S',
      'S#.....#S',
      'S#######S',
      'SSSSSSSSS',
    ],
  },
  {
    hp: 2,
    rows: [
      '###...###',
      '####.####',
      '#####.###',
      '####.####',
      '###...###',
      '##.....##',
      '#.......#',
      '##.....##',
      '###...###',
    ],
  },
  {
    hp: 3,
    rows: [
      '#S#S#S#S#',
      '#########',
      '#S#####S#',
      '#########',
      '#S#####S#',
      '#########',
      '#S#S#S#S#',
    ],
  },
];

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const overlayEl = document.getElementById('overlay');
const overlayText = document.getElementById('overlay-text');
const restartBtn = document.getElementById('btn-restart');
const hudLevel = document.getElementById('hud-level');
const hudScore = document.getElementById('hud-score');
const hudLives = document.getElementById('hud-lives');

const keys = { left: false, right: false };
let audioCtx = null;

/**
 * 浏览器要等玩家点过页面才允许出声，所以第一次操作时再创建。
 * @returns {AudioContext}
 */
function ensureAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

/**
 * 撞砖的短音。打碎时音调高一点。
 * @param {boolean} broken
 */
function playHit(broken) {
  const actx = ensureAudio();
  const t = actx.currentTime;
  const freq = broken ? 1760 : 1480;

  function tone(frequency, peak, seconds) {
    const osc = actx.createOscillator();
    const gain = actx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(frequency, t);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak, t + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.001, t + seconds);
    osc.connect(gain);
    gain.connect(actx.destination);
    osc.start(t);
    osc.stop(t + seconds);
  }

  tone(freq, 0.11, 0.22);
  tone(freq * 2.76, 0.035, 0.12);
}

const state = {
  level: 0,
  score: 0,
  lives: LIVES,
  bricks: [],
  paddle: { x: W / 2 - 48, w: 96 },
  ball: { x: W / 2, y: 0, vx: 0, vy: 0, stuck: true },
  status: 'ready',
  lastTime: 0,
};

/**
 * 限制数字落在 [min, max] 内。
 * @param {number} n
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

/**
 * 当前球速。
 * @returns {number}
 */
function ballSpeed() {
  return Math.hypot(state.ball.vx, state.ball.vy);
}

/**
 * 把速度改成指定大小，方向不变。
 * @param {number} speed
 */
function setBallSpeed(speed) {
  const now = ballSpeed();
  if (now < 0.001) return;
  const next = clamp(speed, 0, MAX_SPEED);
  state.ball.vx *= next / now;
  state.ball.vy *= next / now;
}

/**
 * 撞击后略微加速，不超过上限。
 */
function accelerate() {
  setBallSpeed(ballSpeed() * SPEED_BOOST);
}

/**
 * 按图案生成这一关的砖。
 * @param {number} level
 * @returns {object[]}
 */
function createBricks(level) {
  const cfg = LEVELS[level];
  const bw = (W - BRICK_GAP * (COLS + 1)) / COLS;
  const bricks = [];
  cfg.rows.forEach((line, r) => {
    for (let c = 0; c < COLS; c++) {
      const mark = line[c];
      if (!mark || mark === '.') continue;
      const hp = mark === 'S' ? 4 : cfg.hp;
      bricks.push({
        x: BRICK_GAP + c * (bw + BRICK_GAP),
        y: BRICK_TOP + r * (BRICK_H + BRICK_GAP),
        w: bw,
        h: BRICK_H,
        hp: hp,
        maxHp: hp,
      });
    }
  });
  return bricks;
}

/**
 * 把球吸回挡板上，等待发球。
 */
function stickBall() {
  state.ball.stuck = true;
  state.ball.vx = 0;
  state.ball.vy = 0;
  state.ball.x = state.paddle.x + state.paddle.w / 2;
  state.ball.y = PADDLE_Y - BALL_R - 2;
}

/**
 * 发球：略微偏一点角度，避免永远垂直来回。
 */
function launchBall() {
  if (state.status === 'paused') {
    state.status = 'running';
    setOverlay('');
    return;
  }
  if (state.status === 'win') {
    nextLevel();
    return;
  }
  if (state.status === 'lose') {
    newGame(false);
    return;
  }
  if (!state.ball.stuck) return;
  const dir = Math.random() < 0.5 ? -1 : 1;
  const angle = (0.2 + Math.random() * 0.18) * Math.PI;
  state.ball.stuck = false;
  state.ball.vx = BASE_SPEED * Math.sin(angle) * dir;
  state.ball.vy = -BASE_SPEED * Math.cos(angle);
  state.status = 'running';
  setOverlay('');
}

/**
 * 球碰到挡板：按击中位置改角度，速度回到发球初速。
 */
function bouncePaddle() {
  const t = (state.ball.x - state.paddle.x) / state.paddle.w;
  const angle = (clamp(t, 0, 1) - 0.5) * Math.PI * 0.72;
  state.ball.vx = BASE_SPEED * Math.sin(angle);
  state.ball.vy = -Math.abs(BASE_SPEED * Math.cos(angle));
  state.ball.y = PADDLE_Y - BALL_R - 2;
}

/**
 * 圆和轴对齐矩形是否相交。
 * @param {number} cx
 * @param {number} cy
 * @param {number} r
 * @param {{x:number,y:number,w:number,h:number}} rect
 * @returns {boolean}
 */
function circleHitsRect(cx, cy, r, rect) {
  const nx = clamp(cx, rect.x, rect.x + rect.w);
  const ny = clamp(cy, rect.y, rect.y + rect.h);
  const dx = cx - nx;
  const dy = cy - ny;
  return dx * dx + dy * dy < r * r;
}

/**
 * 根据球是从哪一侧撞上的，决定翻 vx 还是 vy。
 * @param {{x:number,y:number,w:number,h:number}} rect
 */
function bounceOffRect(rect, prevX, prevY) {
  const fromSide = prevX + BALL_R <= rect.x || prevX - BALL_R >= rect.x + rect.w;
  if (fromSide) state.ball.vx *= -1;
  else state.ball.vy *= -1;
}

/**
 * 还没打破的砖数量。
 * @returns {number}
 */
function remainingBricks() {
  return state.bricks.filter((b) => b.hp > 0).length;
}

/**
 * 顶部提示。空字符串则藏掉。
 * @param {string} text
 */
function setOverlay(text) {
  overlayText.textContent = text;
  overlayEl.classList.toggle('hidden', !text);
}

/**
 * 刷新关卡 / 分数 / 生命。
 */
function updateHud() {
  hudLevel.textContent = String(state.level + 1);
  hudScore.textContent = String(state.score);
  hudLives.textContent = String(state.lives);
  document.querySelectorAll('#levels button').forEach((btn) => {
    btn.classList.toggle('active', Number(btn.dataset.level) === state.level);
  });
}

/**
 * 开一关：重置挡板和球，砖块按关卡图案生成。
 * @param {boolean} keepScore 进下一关时保留分数和生命
 */
function startLevel(keepScore) {
  state.bricks = createBricks(state.level);
  state.paddle.w = Math.max(68, 108 - state.level * 4);
  state.paddle.x = W / 2 - state.paddle.w / 2;
  stickBall();
  state.status = 'ready';
  if (!keepScore) {
    state.score = 0;
    state.lives = LIVES;
  }
  restartBtn.textContent = '重开';
  setOverlay('点击或按空格发球');
  updateHud();
}

/**
 * 过关后进入下一关，最后一关则从头开始。
 */
function nextLevel() {
  if (state.level >= LEVELS.length - 1) {
    startLevel(false);
    return;
  }
  state.level += 1;
  startLevel(true);
}

/**
 * 重开当前关；过关后点「下一关」则进入下一关。
 * @param {boolean} [advance]
 */
function newGame(advance) {
  if (advance && state.status === 'win' && state.level < LEVELS.length - 1) {
    nextLevel();
    return;
  }
  startLevel(false);
}

/**
 * 球掉出底边：扣一条命，没生命则失败。
 */
function missBall() {
  state.lives -= 1;
  updateHud();
  if (state.lives <= 0) {
    state.status = 'lose';
    setOverlay('失败了，点击重开');
    return;
  }
  stickBall();
  state.status = 'ready';
  setOverlay('还剩 ' + state.lives + ' 条命，点击发球');
}

/**
 * 推动挡板，并让黏在上面的球跟着走。
 * @param {number} dt 相对 60fps 的时间倍数
 */
function movePaddle(dt) {
  const speed = 11 * dt;
  if (keys.left) state.paddle.x -= speed;
  if (keys.right) state.paddle.x += speed;
  state.paddle.x = clamp(state.paddle.x, 10, W - 10 - state.paddle.w);
  if (state.ball.stuck) {
    state.ball.x = state.paddle.x + state.paddle.w / 2;
    state.ball.y = PADDLE_Y - BALL_R - 2;
  }
}

/**
 * 走一小步并处理一次碰撞。步长很短，避免高速穿砖。
 * @param {number} dt
 */
function stepBall(dt) {
  const prevX = state.ball.x;
  const prevY = state.ball.y;
  state.ball.x += state.ball.vx * dt;
  state.ball.y += state.ball.vy * dt;

  let bounced = false;
  if (state.ball.x < BALL_R) {
    state.ball.x = BALL_R;
    state.ball.vx = Math.abs(state.ball.vx);
    bounced = true;
  } else if (state.ball.x > W - BALL_R) {
    state.ball.x = W - BALL_R;
    state.ball.vx = -Math.abs(state.ball.vx);
    bounced = true;
  }
  if (state.ball.y < BALL_R) {
    state.ball.y = BALL_R;
    state.ball.vy = Math.abs(state.ball.vy);
    bounced = true;
  }
  if (bounced) accelerate();

  if (state.ball.y > H + BALL_R) {
    missBall();
    return;
  }

  const paddleRect = { x: state.paddle.x, y: PADDLE_Y, w: state.paddle.w, h: PADDLE_H };
  if (state.ball.vy > 0 && circleHitsRect(state.ball.x, state.ball.y, BALL_R, paddleRect)) {
    bouncePaddle();
    return;
  }

  for (const brick of state.bricks) {
    if (brick.hp <= 0) continue;
    if (!circleHitsRect(state.ball.x, state.ball.y, BALL_R, brick)) continue;
    bounceOffRect(brick, prevX, prevY);
    accelerate();
    brick.hp -= 1;
    playHit(brick.hp <= 0);
    if (brick.hp <= 0) state.score += 10 * (state.level + 1);
    else state.score += 2;
    updateHud();
    break;
  }

  if (remainingBricks() === 0) {
    state.status = 'win';
    if (state.level < LEVELS.length - 1) {
      restartBtn.textContent = '下一关';
      setOverlay('过关了，点击进入下一关');
    } else {
      restartBtn.textContent = '重开';
      setOverlay('全部通关，点击重开');
    }
  }
}

/**
 * 按当前速度拆成多小步移动，避免一次位移穿过砖块。
 * @param {number} dt
 */
function moveBall(dt) {
  if (state.ball.stuck || state.status !== 'running') return;
  const dist = ballSpeed() * dt;
  const steps = Math.max(1, Math.ceil(dist / STEP_PX));
  const step = dt / steps;
  for (let i = 0; i < steps; i++) {
    if (state.status !== 'running' || state.ball.stuck) return;
    stepBall(step);
  }
}

/**
 * 圆角矩形路径。
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @param {number} r
 */
function roundPath(x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

/**
 * 画深色场地，并铺上细线栅格。
 */
function drawBackground() {
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#1a3a5c');
  sky.addColorStop(0.55, '#10283f');
  sky.addColorStop(1, '#0b1c2e');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  const glow = ctx.createRadialGradient(W / 2, 40, 10, W / 2, 90, 260);
  glow.addColorStop(0, 'rgba(170, 214, 255, 0.22)');
  glow.addColorStop(1, 'rgba(170, 214, 255, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 1;
  for (let x = 40; x < W; x += 40) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
  }
  for (let y = 40; y < H; y += 40) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }
}

/**
 * 画一块浅蓝玻璃砖。血量越高颜色越深，打掉一层就变浅。
 * @param {object} brick
 */
function drawBrick(brick) {
  const tones = {
    1: '#c5e4f8',
    2: '#9dcef3',
    3: '#8ec8ee',
    4: '#5eaddf',
  };
  const fill = tones[brick.hp] || tones[1];

  roundPath(brick.x, brick.y, brick.w, brick.h, 5);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
  roundPath(brick.x + 3, brick.y + 2, brick.w - 6, 4, 2);
  ctx.fill();
}

/**
 * 画一帧：场地、砖、挡板、球。
 */
function draw() {
  drawBackground();

  state.bricks.forEach((brick) => {
    if (brick.hp <= 0) return;
    drawBrick(brick);
  });

  roundPath(state.paddle.x, PADDLE_Y, state.paddle.w, PADDLE_H, 6);
  const paddle = ctx.createLinearGradient(0, PADDLE_Y, 0, PADDLE_Y + PADDLE_H);
  paddle.addColorStop(0, '#f4fbff');
  paddle.addColorStop(1, '#9fd0f5');
  ctx.fillStyle = paddle;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(state.ball.x, state.ball.y, BALL_R + 6, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(186, 224, 255, 0.28)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(state.ball.x, state.ball.y, BALL_R, 0, Math.PI * 2);
  ctx.fillStyle = '#f7fbff';
  ctx.fill();
}

/**
 * 主循环。用时间差折算，避免掉帧时球穿模太狠。
 * @param {number} time
 */
function loop(time) {
  const dt = Math.min(2, (time - state.lastTime) / (1000 / 60) || 1);
  state.lastTime = time;
  if (state.status === 'running' || state.status === 'ready') {
    movePaddle(dt);
    moveBall(dt);
  }
  draw();
  requestAnimationFrame(loop);
}

/**
 * 把指针位置换算成画布坐标，用来拖挡板。
 * @param {MouseEvent|Touch} e
 * @returns {number}
 */
function pointerToCanvasX(e) {
  const rect = canvas.getBoundingClientRect();
  return ((e.clientX - rect.left) / rect.width) * W;
}

/**
 * 把挡板中心移到指定横坐标。
 * @param {number} x
 */
function movePaddleTo(x) {
  state.paddle.x = clamp(x - state.paddle.w / 2, 10, W - 10 - state.paddle.w);
}

/**
 * 画出 8 个关卡按钮。
 */
function renderLevelNav() {
  const nav = document.getElementById('levels');
  nav.innerHTML = '';
  LEVELS.forEach((_, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.level = String(i);
    btn.textContent = String(i + 1);
    nav.appendChild(btn);
  });
}

document.getElementById('levels').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-level]');
  if (!btn) return;
  state.level = Number(btn.dataset.level);
  startLevel(false);
});

restartBtn.addEventListener('click', () => newGame(true));

canvas.addEventListener('pointerdown', (e) => {
  ensureAudio();
  canvas.setPointerCapture(e.pointerId);
  movePaddleTo(pointerToCanvasX(e));
  launchBall();
});
canvas.addEventListener('pointermove', (e) => {
  movePaddleTo(pointerToCanvasX(e));
});

window.addEventListener('keydown', (e) => {
  ensureAudio();
  if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') keys.left = true;
  if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') keys.right = true;
  if (e.key === ' ' || e.key === 'Spacebar') {
    e.preventDefault();
    if (state.status === 'running') {
      state.status = 'paused';
      setOverlay('已暂停，按空格继续');
    } else {
      launchBall();
    }
  }
  if (e.key === 'r' || e.key === 'R') newGame(false);
});
window.addEventListener('keyup', (e) => {
  if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') keys.left = false;
  if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') keys.right = false;
});

renderLevelNav();
startLevel(false);
requestAnimationFrame(loop);
