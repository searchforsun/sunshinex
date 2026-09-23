#!/usr/bin/env node
/**
 * 构建前置清理：递归删除 dist/ 后由 tsc 全量重建。
 * 背景：tsc 的 outDir 重用不清已删源文件的陈旧产物——D16 信封退役线删除
 * reactor.structured.test.ts / model/structured.test.ts 后，用户本机 dist 残件照跑
 * 致全量测试假红 6 用例（effort 线 T5 同款先例），根治为构建前统一清目录。
 * tsc 自身零 shell 语法（跨平台直跑 node）。
 */
const fs = require('fs');
const path = require('path');

const dist = path.join(__dirname, '..', 'dist');
fs.rmSync(dist, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
