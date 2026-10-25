/**
 * 3D 查看器的 GIF 导出模块
 *
 * 由 index.html 传入一个 ctx（渲染器桥接），本模块不直接碰 three 的对象，
 * 只负责「逐帧驱动 → 取像素 → 量化 → 编码 → 下载」。
 *
 * ctx 需要提供：
 *   clipLen   : number          动画时长（秒），0 表示没有动画
 *   name      : string          输出文件名（不含扩展名）
 *   begin(dark:boolean)         进入导出模式：停 tick、关自动旋转与线框
 *   end()                       退出导出模式：恢复尺寸/相机/显示设置
 *   setSize(px:number)          把渲染画布设为 px×px 正方形
 *   pose(t:number)              把动画定格到第 t 秒
 *   render(): HTMLCanvasElement 渲染一帧并返回 WebGL 画布
 *   setDark(v:boolean)          切换背景深浅
 */
import { GIFEncoder, quantize, applyPalette } from './vendor/gifenc.esm.js';

const MEASURE = 480;   // 构图测量用的分辨率（只用来定 bbox 与采样颜色）
const MAX_PAL_PTS = 60000;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const nextTick = () => new Promise(r => setTimeout(r, 0));

function throwIfAborted(signal) {
  if (signal && signal.aborted) {
    const e = new Error('已取消');
    e.name = 'AbortError';
    throw e;
  }
}

/**
 * 选帧数与帧间隔。
 *
 * GIF 的帧延迟以 1/100 秒为单位，非 10ms 整数倍会被截断 ——
 * 直接按「目标帧率」算 delay 会让整段循环比原动画快十几%（实测 4.77s 播成 4.20s）。
 * 所以反过来：只在 10ms 网格上找候选，优先选最接近目标帧率、且总时长误差 ≤0.5% 的组合。
 */
export function planFrames(clipSec, fps) {
  const target = clipSec * 1000;
  const ideal = 1000 / fps;
  const cands = [];
  for (let ms = 30; ms <= 130; ms += 10) {
    const n = Math.round(target / ms);
    if (n < 12 || n > 160) continue;
    cands.push({ n, ms, err: Math.abs(n * ms - target) / target });
  }
  if (!cands.length) {
    const ms = Math.max(30, Math.round(ideal / 10) * 10);
    const n = Math.max(12, Math.round(target / ms));
    return { n, ms, err: Math.abs(n * ms - target) / target };
  }
  const tight = cands.filter(c => c.err <= 0.005);
  const pool = tight.length ? tight : cands;
  pool.sort((a, b) => Math.abs(a.ms - ideal) - Math.abs(b.ms - ideal) || a.err - b.err);
  return pool[0];
}

/** 在一帧 RGBA 里找非背景像素的外接框 */
function boundsOf(data, W, H, isBg) {
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) {
    const row = y * W * 4;
    for (let x = 0; x < W; x++) {
      const o = row + x * 4;
      if (isBg(data[o], data[o + 1], data[o + 2])) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

/**
 * 从若干采样帧里抽色做全局调色板。
 * 用全局调色板而不是逐帧调色板：帧间颜色一致，循环时不会闪色，体积也更小。
 */
function buildPalette(samples, isBg, perFrame) {
  const buf = [];
  const sweep = (step0) => {
    for (const d of samples) {
      const px = d.length >> 2;
      const step = Math.max(step0, Math.floor(px / perFrame));
      for (let p = 0; p < px; p += step) {
        const o = p << 2;
        const r = d[o], g = d[o + 1], b = d[o + 2];
        if (isBg(r, g, b)) continue;
        buf.push(r, g, b, 255);
      }
    }
  };
  sweep(1);
  // 稀疏扫不到点就稠密重扫一遍。起因是 `xba003_2phase_death`：战败动画里模型
  // 一边散架一边缩小，6 帧采样里非背景像素太稀，按 perFrame 算出的步长直接跳过
  // 了全部有效像素，调色板为空 → 整条动画导不出来（不是没画面，是没颜色可量化）。
  if (buf.length < 4 * 16) {
    buf.length = 0;
    for (const d of samples) {
      const px = d.length >> 2;
      for (let p = 0; p < px; p++) {
        const o = p << 2;
        const r = d[o], g = d[o + 1], b = d[o + 2];
        if (isBg(r, g, b)) continue;
        buf.push(r, g, b, 255);
      }
    }
  }
  if (buf.length < 4 * 16) return null;
  // 留一个索引给「帧间没变化」的透明像素（见下方差分），所以只量化 255 色
  return quantize(Uint8Array.from(buf), 255);
}

/**
 * @returns {Promise<{blob:Blob, width:number, height:number, frames:number,
 *                    delay:number, bytes:number, elapsed:number}>}
 */
export async function exportGif(ctx, opts = {}) {
  const longEdge = opts.longEdge ?? 900;
  const fps = opts.fps ?? 15;
  const ss = clamp(opts.ss ?? 2, 1, 3);
  const dark = opts.dark !== false;
  const download = opts.download !== false;
  const onProgress = opts.onProgress || (() => {});
  const signal = opts.signal;
  const t0 = performance.now();

  if (!ctx.clipLen) throw new Error('当前模型没有可导出的骨骼动画');

  const plan = planFrames(ctx.clipLen, fps);
  const n = plan.n;
  const delay = plan.ms;
  const step = ctx.clipLen / n;

  const work = document.createElement('canvas');
  work.width = MEASURE;
  work.height = MEASURE;
  const wctx = work.getContext('2d', { willReadFrequently: true });

  const bgRGB = dark ? [14, 17, 22] : [255, 255, 255];
  const isBg = (r, g, b) =>
    Math.abs(r - bgRGB[0]) + Math.abs(g - bgRGB[1]) + Math.abs(b - bgRGB[2]) < 18;

  ctx.begin(dark);
  try {
    // ---------- 阶段 1：测量构图 + 采样调色板 ----------
    ctx.setSize(MEASURE);
    let bx0 = MEASURE, by0 = MEASURE, bx1 = -1, by1 = -1;
    const samples = [];
    const sampleAt = new Set();
    const NS = Math.min(n, 12);          // 6 帧对「边散架边缩小」的战败动画不够
    for (let k = 0; k < NS; k++) sampleAt.add(Math.round(k * n / NS) % n);

    for (let i = 0; i < n; i++) {
      throwIfAborted(signal);
      ctx.pose(i * step);
      const src = ctx.render();
      wctx.clearRect(0, 0, MEASURE, MEASURE);
      wctx.drawImage(src, 0, 0, MEASURE, MEASURE);
      const img = wctx.getImageData(0, 0, MEASURE, MEASURE);
      const bb = boundsOf(img.data, MEASURE, MEASURE, isBg);
      if (bb) {
        bx0 = Math.min(bx0, bb.x0); by0 = Math.min(by0, bb.y0);
        bx1 = Math.max(bx1, bb.x1); by1 = Math.max(by1, bb.y1);
      }
      if (sampleAt.has(i)) samples.push(img.data);
      if (i % 3 === 0) {
        onProgress({ phase: 'measure', i: i + 1, n, pct: (i / n) * 32 });
        await nextTick();
      }
    }
    if (bx1 < 0) throw new Error('画面里没有可见部件，无法导出');

    // 整段并集外接框 + 2% 边距（逐帧裁剪会让模型忽大忽小）
    const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
    const padX = Math.max(2, Math.round(bw * 0.02));
    const padY = Math.max(2, Math.round(bh * 0.02));
    const cx0 = Math.max(0, bx0 - padX), cy0 = Math.max(0, by0 - padY);
    const cx1 = Math.min(MEASURE, bx1 + padX), cy1 = Math.min(MEASURE, by1 + padY);
    const nw = (cx1 - cx0) / MEASURE;
    const nh = (cy1 - cy0) / MEASURE;
    const nx0 = cx0 / MEASURE;
    const ny0 = cy0 / MEASURE;
    const ar = nw / nh;

    let outW, outH;
    if (ar >= 1) { outW = longEdge; outH = Math.max(2, Math.round(longEdge / ar)); }
    else { outH = longEdge; outW = Math.max(2, Math.round(longEdge * ar)); }

    onProgress({ phase: 'palette', i: n, n, pct: 36 });
    await nextTick();
    const pal = buildPalette(samples, isBg, Math.floor(MAX_PAL_PTS / samples.length));
    if (!pal) throw new Error('采样到的颜色太少，无法生成调色板');

    // ---------- 阶段 2：超采样渲染 ----------
    // 渲染到 longEdge*ss 的正方形画布，再按并集框裁下、降采样到 outW×outH。
    // 这一步是「不糊」的关键：源像素始终比输出多 ss² 倍，等于 SSAA。
    const RS = Math.round(longEdge * ss);
    ctx.setSize(RS);
    const sx0 = nx0 * RS, sy0 = ny0 * RS, sw = nw * RS, sh = nh * RS;

    const out = document.createElement('canvas');
    out.width = outW;
    out.height = outH;
    const octx = out.getContext('2d', { willReadFrequently: true });

    const gif = GIFEncoder();
    // 帧间差分：背景与静止部件在整段动画里几乎不变，把这些像素标成透明索引，
    // 下一帧就不重绘（dispose=1），LZW 的重复串大幅增加 —— 900p 从 7.7 MB 降到 4 MB 出头。
    const TI = 255;
    let prev = null;
    for (let i = 0; i < n; i++) {
      throwIfAborted(signal);
      ctx.pose(i * step);
      const src = ctx.render();
      octx.clearRect(0, 0, outW, outH);
      octx.drawImage(src, sx0, sy0, sw, sh, 0, 0, outW, outH);
      const img = octx.getImageData(0, 0, outW, outH);
      const px = img.data;
      const idx = applyPalette(px, pal, 'rgb888');
      if (prev) {
        for (let p = 0, o = 0; p < idx.length; p++, o += 4) {
          if (px[o] === prev[o] && px[o + 1] === prev[o + 1] && px[o + 2] === prev[o + 2]) {
            idx[p] = TI;
          }
        }
      }
      gif.writeFrame(idx, outW, outH, {
        palette: pal, delay, repeat: 0, dispose: 1,
        transparent: !!prev, transparentIndex: TI,
      });
      prev = px.slice();
      onProgress({ phase: 'encode', i: i + 1, n, pct: 40 + (i / n) * 58 });
      if (i % 2 === 0) await nextTick();
    }
    gif.finish();

    const bytes = gif.bytes();
    const blob = new Blob([bytes], { type: 'image/gif' });

    if (download) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${ctx.name}_${longEdge}p_${fps}fps.gif`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    }

    onProgress({ phase: 'done', i: n, n, pct: 100 });
    return {
      blob,
      width: outW,
      height: outH,
      frames: n,
      delay,
      bytes: blob.size,
      elapsed: performance.now() - t0,
      loopSec: n * delay / 1000,
      clipLen: ctx.clipLen,
    };
  } finally {
    ctx.end();
  }
}
