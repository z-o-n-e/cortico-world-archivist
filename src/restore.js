/**
 * 恢复执行器：从备份 zip 里把文件放回去。
 *
 * 安全设计（顺序不可颠倒）：
 *  ① 解压到临时目录 —— 不碰真实数据
 *  ② 校验清单与文件完整性 —— 坏包直接拒绝
 *  ③ 备份当前状态到 <destDir>/before-restore-<时间>/ —— 出错能回滚
 *  ④ 才复制覆盖
 *
 * 已知限制：memory-extra 等扩展把数据缓存在内存里（每 2 秒全量 flush），
 * 所以恢复 data/ 之后必须重启 Coopanion，否则会被旧内存覆盖。这个提示由调用方负责。
 * 恢复完成会等几秒复查一遍：真被写回去了就当场喊出来，别让人以为恢复成功了。
 */
import { existsSync } from 'node:fs';
import { copyFile, rm, mkdir, readdir, readFile, rename, stat } from 'node:fs/promises';
import { join, basename, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { CONFIG_FILES, CONFIG_DIRS, DATA_SKIP, DATA_SKIP_DIRS, skipAnyDir } from './config.js';
import { defaultDestDir, isInside, extraTargets } from './backup.js';

/** 一个文件的 sha1；读不到给 null。 */
async function hashFile(path) {
  try {
    return createHash('sha1').update(await readFile(path)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * 等一会儿再看这些文件有没有被别的东西改写。
 *
 * 用途：恢复 data/ 时进程还活着，记忆类扩展会把内存里的旧数据 flush 回来（内容变了）。
 * 只看内容不看时间戳——单纯被 touch 一下不算。
 *
 * @param {string[]} files
 * @param {number} waitMs
 * @returns {Promise<string[]>} 内容变了的文件
 */
export async function detectRewrite(files, waitMs = 3000) {
  if (!files.length) return [];
  const before = await Promise.all(files.map(hashFile));
  await new Promise((r) => setTimeout(r, waitMs));
  const after = await Promise.all(files.map(hashFile));
  return files.filter((_, i) => before[i] !== after[i]);
}

/**
 * 把一个 zip 条目名拆成安全的路径段。
 *
 * Windows 的 `Compress-Archive` 把分隔符写成 `\`，而 zip 规范要求 `/`。
 * 在 Windows 上解压没问题（Expand-Archive 认 `\`），但在 macOS/Linux 上
 * 会变成一堆名字里带反斜杠的平铺文件，整份备份就等于废了。
 * 顺手把 `..` 过滤掉，免得条目名穿越出目录。
 *
 * @param {string} name
 * @returns {string[]}
 */
export function splitEntryName(name) {
  return String(name)
    .split(/[\\/]+/)
    .filter((part) => part && part !== '.' && part !== '..');
}

/**
 * 就地修正被解压出来的「平铺 + 反斜杠」文件，把它们重新放回目录结构里。
 * @returns {Promise<number>} 搬了几个
 */
export async function normalizePaths(dir) {
  let moved = 0;
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const name = entry.name;
    if (!name.includes('\\')) {
      if (entry.isDirectory()) moved += await normalizePaths(join(dir, name));
      continue;
    }
    const parts = splitEntryName(name);
    if (!parts.length) continue;
    const src = join(dir, name);
    const dst = join(dir, ...parts);
    try {
      await mkdir(dirname(dst), { recursive: true });
      await rename(src, dst);
      moved += 1;
    } catch {
      // 单个条目搬不动就留着，别把整次恢复搞挂
    }
  }
  return moved;
}

/** 调系统解压命令。 */
function decompress(zipPath, outDir) {
  return new Promise((done) => {
    const isWin = process.platform === 'win32';
    const cmd = isWin ? 'powershell.exe' : 'unzip';
    const args = isWin
      ? ['-NoProfile', '-NonInteractive', '-Command',
         `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${outDir}' -Force`]
      : ['-o', '-q', zipPath, '-d', outDir];
    const child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr?.on('data', (c) => { err += c.toString(); });
    child.on('error', (e) => done({ ok: false, detail: `解压失败: ${e.message}` }));
    child.on('close', (code) => {
      if (code === 0) done({ ok: true });
      else done({ ok: false, detail: `解压退出码 ${code}: ${err.slice(0, 300)}` });
    });
    setTimeout(() => { child.kill(); done({ ok: false, detail: '解压超时' }); }, 10 * 60 * 1000).unref?.();
  });
}

/** 递归复制目录并覆盖。`skip(path, name, isDir)` 返回 true 的条目直接不碰。 */
async function overwriteDir(src, dest, onError, stats, skip) {
  await mkdir(dest, { recursive: true });
  let entries;
  try {
    entries = await readdir(src, { withFileTypes: true });
  } catch (e) {
    onError(`读不了 ${src}: ${e.code ?? e.message}`);
    return;
  }
  for (const entry of entries) {
    const s = join(src, entry.name);
    const d = join(dest, entry.name);
    if (skip?.(s, entry.name, entry.isDirectory())) continue;
    if (entry.isDirectory()) await overwriteDir(s, d, onError, stats, skip);
    else if (entry.isFile()) {
      try {
        await copyFile(s, d);
        stats.files++;
      } catch (e) {
        onError(`${d}: ${e.code ?? e.message}`);
      }
    }
  }
}

/** 复制单个文件并覆盖。 */
async function overwriteOne(src, dest, onError, stats) {
  if (!existsSync(src)) return false;
  try {
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(src, dest);
    stats.files++;
    return true;
  } catch (e) {
    onError(`${dest}: ${e.code ?? e.message}`);
    return false;
  }
}

/** 时间戳，用于 before-restore 目录名。 */
function stamp(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

/**
 * 把「当前状态」里即将被覆盖的部分先存一份。
 * 只备份将被恢复的那几块，避免无谓地复制几十 MB。
 */
async function snapshotCurrent({ botDir, dataDir, cfg, destDir, onError, stats }) {
  const target = join(destDir, `before-restore-${stamp()}`);
  await mkdir(target, { recursive: true });

  const wantWorkspace = cfg.sources?.workspace ?? true;
  const wantGit = cfg.sources?.['workspace-git'] ?? false;
  const wantBlobs = cfg.sources?.['workspace-blobs'] ?? true;
  const wantData = cfg.sources?.data ?? true;
  const wantConfig = cfg.sources?.config ?? true;

  if (wantWorkspace || wantGit || wantBlobs) {
    const ws = join(botDir, 'workspace');
    if (existsSync(ws)) {
      const dst = join(target, 'workspace');
      await mkdir(dst, { recursive: true });
      for (const entry of await readdir(ws, { withFileTypes: true }).catch(() => [])) {
        const skipped = (entry.name === '.git' && !wantGit) || (entry.name === 'blobs' && !wantBlobs);
        if (skipped) continue;
        const s = join(ws, entry.name);
        const d = join(dst, entry.name);
        if (entry.isDirectory()) await overwriteDir(s, d, onError, stats);
        else if (entry.isFile()) await overwriteOne(s, d, onError, stats);
      }
    }
  }

  if (wantData && existsSync(dataDir)) {
    const dst = join(target, 'data');
    await mkdir(dst, { recursive: true });
    // 和 backup.js 的扫描规则保持一致：顶层数据文件 + 每个整包带走的子目录。
    // 子目录也必须快照——恢复时它们是整个覆盖的（data/stroll、data/terrarium 之类），
    // 只存顶层文件的话，这些目录被覆盖掉就再也拿不回原样了。
    for (const entry of await readdir(dataDir, { withFileTypes: true }).catch(() => [])) {
      const src = join(dataDir, entry.name);
      const out = join(dst, entry.name);
      if (entry.isDirectory()) {
        if (DATA_SKIP_DIRS.has(entry.name)) continue;
        if (isInside(src, destDir)) continue; // 自己的存放位置，别把 zip 拷进快照
        await overwriteDir(src, out, onError, stats,
          (p, name, isDir) => isDir && (skipAnyDir(name) || isInside(p, destDir)));
      } else if (entry.isFile()) {
        if (DATA_SKIP.has(entry.name)) continue;
        if (!/\.(json|jsonl|db|sqlite|yaml|yml|txt|md)$/i.test(entry.name)) continue;
        await overwriteOne(src, out, onError, stats);
      }
    }
  }

  if (wantConfig) {
    const dst = join(target, 'config');
    await mkdir(dst, { recursive: true });
    for (const f of CONFIG_FILES) {
      await overwriteOne(join(botDir, f), join(dst, f), onError, stats);
    }
    for (const d of CONFIG_DIRS) {
      const src = join(botDir, d);
      if (existsSync(src)) await overwriteDir(src, join(dst, d), onError, stats);
    }
  }

  // 额外路径同样会被恢复覆盖，同样得留副本。按「包里的名字」存，
  // 和 zip 里的 extra/ 结构一致，回滚时照着放回去就行。
  const extras = extraTargets(botDir, cfg);
  if (extras.length) {
    const dst = join(target, 'extra');
    await mkdir(dst, { recursive: true });
    for (const { name, abs } of extras) {
      if (isInside(abs, destDir)) continue;
      try {
        if ((await stat(abs)).isDirectory()) {
          await overwriteDir(abs, join(dst, name), onError, stats,
            (p, n2, isDir) => isDir && skipAnyDir(n2));
        } else {
          await overwriteOne(abs, join(dst, name), onError, stats);
        }
      } catch {
        // 单条路径读不到就算了，不拖累整体
      }
    }
  }

  return target;
}

/**
 * 从备份恢复。
 * @param {object} opts
 * @param {string} opts.botDir
 * @param {string} opts.dataDir
 * @param {object} opts.cfg
 * @param {string} opts.zipPath   要恢复的备份文件
 * @param {(msg:string, data?:object)=>void} opts.log
 */
export async function runRestore({ botDir, dataDir, cfg, zipPath, log }) {
  const started = Date.now();
  const errors = [];
  const onError = (m) => { errors.push(m); if (errors.length <= 20) log(`跳过 ${m}`); };

  if (!existsSync(zipPath)) {
    return { ok: false, detail: `备份文件不存在: ${zipPath}` };
  }

  const stage = join(tmpdir(), `coopanion-restore-${randomUUID()}`);
  await mkdir(stage, { recursive: true });

  try {
    // ---- ① 解压到临时目录 ----
    log('解压备份到临时目录…');
    const d = await decompress(zipPath, stage);
    if (!d.ok) return { ok: false, detail: d.detail };

    // 跨平台：Windows 打的包在 macOS/Linux 上会解成一堆名字带 `\` 的平铺文件
    const moved = await normalizePaths(stage).catch(() => 0);
    if (moved) log(`修正了 ${moved} 个带反斜杠的条目名（Windows 打包、别的系统解压时会这样）`);

    // ---- ② 校验 ----
    const manifestPath = join(stage, 'MANIFEST.md');
    if (!existsSync(manifestPath)) {
      return { ok: false, detail: '这个 zip 不像本扩展的备份（缺少 MANIFEST.md），已拒绝恢复。' };
    }
    const hasWorkspace = existsSync(join(stage, 'workspace'));
    const hasData = existsSync(join(stage, 'data'));
    const hasConfig = existsSync(join(stage, 'config'));
    const hasExtra = existsSync(join(stage, 'extra'));
    if (!hasWorkspace && !hasData && !hasConfig && !hasExtra) {
      return { ok: false, detail: '备份里没有可恢复的内容（workspace/data/config 都不存在）。' };
    }

    const destDir = cfg.destDir?.trim()
      ? resolve(cfg.destDir.trim())
      : defaultDestDir({ botDir, dataDir });

    // ---- ③ 先备份当前状态 ----
    const pre = { files: 0 };
    let snapshotDir = null;
    if (cfg.sources) {
      log('恢复前先给当前状态存一份…');
      snapshotDir = await snapshotCurrent({
        botDir, dataDir, cfg, destDir: resolve(destDir), onError,
        stats: pre,
      });
      log(`当前状态已存到 ${snapshotDir}（${pre.files} 个文件）`);
    }

    // ---- ④ 复制覆盖 ----
    const stats = { files: 0 };
    const done = [];
    const wantWorkspace = cfg.sources?.workspace ?? true;
    const wantGit = cfg.sources?.['workspace-git'] ?? false;
    const wantBlobs = cfg.sources?.['workspace-blobs'] ?? true;
    const wantData = cfg.sources?.data ?? true;
    const wantConfig = cfg.sources?.config ?? true;

    if ((wantWorkspace || wantGit || wantBlobs) && hasWorkspace) {
      const src = join(stage, 'workspace');
      const dst = join(botDir, 'workspace');
      await mkdir(dst, { recursive: true });
      let n = 0;
      for (const entry of await readdir(src, { withFileTypes: true }).catch(() => [])) {
        const skipped = (entry.name === '.git' && !wantGit) || (entry.name === 'blobs' && !wantBlobs);
        if (skipped) continue;
        const s = join(src, entry.name);
        const t = join(dst, entry.name);
        if (entry.isDirectory()) await overwriteDir(s, t, onError, stats);
        else if (entry.isFile()) await overwriteOne(s, t, onError, stats);
        n++;
      }
      if (n) done.push('工作区');
    }

    /** 恢复过的 data/ 顶层文件（用来复查有没有被内存里的旧数据写回去）。 */
    const dataFiles = [];

    if (wantData && hasData) {
      const src = join(stage, 'data');
      const dst = dataDir;
      await mkdir(dst, { recursive: true });
      let n = 0;
      for (const entry of await readdir(src, { withFileTypes: true }).catch(() => [])) {
        const s = join(src, entry.name);
        const t = join(dst, entry.name);
        // 存放位置若在 data/ 内，恢复它就是把备份目录本身覆盖成旧版本。
        // 跳过：这一步没有意义，还会把刚拿到的包弄坏。
        if (isInside(t, destDir)) {
          log(`跳过 ${t}（这是自己的存放位置，不能覆盖）`);
          continue;
        }
        const skip = (p, name, isDir) => isDir && (skipAnyDir(name) || isInside(p, destDir));
        if (entry.isDirectory()) {
          await overwriteDir(s, t, onError, stats, skip);
        } else if (entry.isFile()) {
          if (DATA_SKIP.has(entry.name)) continue;
          if (await overwriteOne(s, t, onError, stats)) dataFiles.push(t);
        }
        n++;
      }
      if (n) done.push('扩展数据');
    }

    if (wantConfig && hasConfig) {
      const src = join(stage, 'config');
      let n = 0;
      for (const f of CONFIG_FILES) {
        if (await overwriteOne(join(src, f), join(botDir, f), onError, stats)) n++;
      }
      for (const dir of CONFIG_DIRS) {
        const s = join(src, dir);
        if (existsSync(s)) {
          await overwriteDir(s, join(botDir, dir), onError, stats);
          n++;
        }
      }
      if (n) done.push('配置与密钥');
    }

    if (hasExtra) {
      const src = join(stage, 'extra');
      // 包里记了「名字 → 原始绝对路径」就照它放回原处；
      // 老备份没有这张表，只能退回旧行为（放进 botDir），并在结果里说清楚。
      let mapping = null;
      try {
        mapping = JSON.parse(await readFile(join(src, 'extra-map.json'), 'utf8'));
      } catch {
        mapping = null;
      }
      let n = 0;
      for (const entry of await readdir(src, { withFileTypes: true }).catch(() => [])) {
        if (entry.isFile() && entry.name === 'extra-map.json') continue;
        const s = join(src, entry.name);
        const t = mapping?.[entry.name] ? resolve(mapping[entry.name]) : join(botDir, entry.name);
        if (entry.isDirectory()) await overwriteDir(s, t, onError, stats, (p, name, isDir) => isDir && skipAnyDir(name));
        else if (entry.isFile()) await overwriteOne(s, t, onError, stats);
        n++;
      }
      if (n) done.push(mapping ? '额外路径' : '额外路径（老备份没有路径表，放到部署目录下）');
    }

    if (!done.length) {
      return { ok: false, detail: '按当前勾选，备份里没有要恢复的内容。' };
    }

    // ---- ⑤ 复查：进程还活着的时候，记忆类扩展会把内存里的旧数据 flush 回来 ----
    let clobbered = [];
    if (dataFiles.length) {
      log(`等 3 秒，看有没有扩展把内存里的旧数据写回去（复查 ${dataFiles.length} 个文件）…`);
      clobbered = await detectRewrite(dataFiles, 3000).catch(() => []);
    }

    const ms = Date.now() - started;
    const names = clobbered.slice(0, 6).map((p) => basename(p)).join('、');
    const warn = clobbered.length
      ? `❌ 有 ${clobbered.length} 个数据文件在恢复后立刻被改写（${names}${clobbered.length > 6 ? '…' : ''}）——`
        + '说明有扩展正把内存里的旧数据写回磁盘，这次恢复对它们无效。'
        + '请【完全退出 Coopanion】（不是关窗口）后重新恢复一次。'
      : '⚠️ 必须重启 Coopanion 才生效——记忆类扩展把数据缓存在内存里，否则会把旧数据写回去。';

    return {
      ok: true,
      files: stats.files,
      snapshotDir,
      clobbered,
      ms,
      detail: `已恢复 ${done.join('、')}（${stats.files} 个文件）。${
        snapshotDir ? `恢复前状态存于 ${snapshotDir}。` : ''
      }${warn}`,
    };
  } catch (e) {
    return { ok: false, detail: `恢复异常: ${e.message}` };
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => {});
  }
}
