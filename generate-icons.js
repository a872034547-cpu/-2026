#!/usr/bin/env node
/**
 * generate-icons.js
 * 生成扩展所需的 PNG 图标（需要 Node.js 运行）
 * 运行：node generate-icons.js
 */
const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

const sizes = [16, 48, 128];
const dir = path.join(__dirname, 'icons');
if (!fs.existsSync(dir)) fs.mkdirSync(dir);

sizes.forEach(size => {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // 背景
  ctx.fillStyle = '#238636';
  roundRect(ctx, 0, 0, size, size, size * 0.2);
  ctx.fill();

  // 足球 emoji 文字
  const fontSize = Math.floor(size * 0.65);
  ctx.font = `${fontSize}px serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('⚽', size / 2, size / 2 + size * 0.04);

  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(path.join(dir, `icon${size}.png`), buffer);
  console.log(`✅ icons/icon${size}.png`);
});

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}
