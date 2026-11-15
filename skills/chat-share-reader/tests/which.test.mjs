// PATH 查找的回归测试。
//
// 这块被重写过一次：vendor.mjs 和 backend/opencli.mjs 各有一份实现，两份都犯同一个错——
// 只取 `where` 输出的第一行。Windows 上同名命令可能散落在多个 PATH 目录，第一行指向的
// 旧安装被删掉时，明明装了却报"没有可用的通道"。合并成 lib/which.mjs 后用这些用例挡住。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { which } from '../scripts/lib/which.mjs';

test('which 能找到 PATH 里的 node', () => {
  const p = which('node');
  assert.ok(p, 'node 就在 PATH 里，应该找得到');
  assert.ok(path.isAbsolute(p), `应返回绝对路径，实际 ${p}`);
});

test('which 对不存在的命令返回空串而不是抛错', () => {
  assert.equal(which('csr-no-such-binary-9f3a'), '');
});

test('which 对空名字返回空串', () => {
  assert.equal(which(''), '');
  assert.equal(which(undefined), '');
});

test('which 能查到 PATH 里无扩展名的裸脚本', () => {
  // opencli 就是这种形态（`#!/usr/bin/env bash`，无扩展名）。曾经担心 Windows 的 where
  // 只匹配 PATHEXT 会漏掉它，实测能查到，这条用例把结论钉住，别再凭印象加兜底代码。
  const dir = mkdtempSync(path.join(os.tmpdir(), 'csr-which-'));
  const name = 'csr-fake-bare-script';
  const old = process.env.PATH;
  try {
    const file = path.join(dir, name);
    writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    process.env.PATH = `${dir}${path.delimiter}${old || ''}`;
    const got = which(name);
    assert.ok(got, 'where 应该能查到无扩展名的裸脚本');
    // 不比整条路径字符串。Windows 上 os.tmpdir() 给的是 8.3 短名
    // （C:\Users\RUNNER~1\...），where 回的却是长名，realpath 两个方向都不展开，
    // 于是同一个文件两种写法。这里验「查到的就是刚写下的那个文件」，与路径写法无关。
    assert.equal(path.basename(got), name);
    assert.equal(readFileSync(got, 'utf8'), '#!/bin/sh\nexit 0\n');
  } finally {
    process.env.PATH = old;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('findOpencli 与 available 保持一致', async () => {
  const { findOpencli, available } = await import('../scripts/lib/backend/opencli.mjs');
  const p = findOpencli();
  assert.equal(typeof p, 'string');
  assert.equal(available(), !!p);
});

test('findConvolvger 返回字符串，未安装时为空', async () => {
  const { findConvolvger } = await import('../scripts/lib/vendor.mjs');
  assert.equal(typeof findConvolvger(), 'string');
});
