/**
 * 备份执行器：把勾选的源复制到临时目录 → 打包成 zip → 轮转清理旧包。
 *
 * 关键设计：
 *  - 先复制到临时目录再打包，避免打包过程中源文件被改写（如 vector-memory.json 正在写）
 *  - 临时目录放在系统 temp，不污染她的工作区
 *  - 用系统自带能力压缩（Windows: Compress-Archive / macOS: zip），不加第三方依赖
 *  - 任何一步失败都清理临时目录，不留下垃圾
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { copyFile, rm, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { join, basename, dirname, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { CONFIG_FILES, CONFIG_DIRS, DATA_SKIP, DATA_SKIP_DIRS, skipAnyDir } from './config.js';

/** 绝对路径统一形态（Windows 不分大小写），用来比对「在不在某个目录里」。 */
function norm(p) {
  const abs = resolve(p);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

/** abs 是否就是 root 或落在 root 里面。 */
export function isInside(abs, root) {
  const a = norm(abs);
  const r = norm(root);
  return a === r || a.startsWith(r.endsWith(sep) ? r : r + sep);
}

/**
 * 配置没填存放位置时的默认目录。
 *
 * 默认放部署目录下（botDir），**不放** data/ 里：data/ 会被「扩展数据」整目录扫描，
 * 放在里面等于每份备份都把之前的 zip 一起打包——zip 已经压过，再打一次几乎不变小，
 * 单份体积就逐次接近翻倍，直到占满磁盘或压缩失败。
 *
 * 但老部署升级上来时 `<dataDir>/archivist` 里可能已经有旧包。继续用它，
 * 否则「保留份数」的轮转会在新目录里从零开始，旧包再也清不掉。
 *
 * @param {{botDir: string, dataDir: string}} dirs
 */
export function defaultDestDir({ botDir, dataDir }) {
  const legacy = join(dataDir, 'archivist');
  try {
    if (existsSync(legacy) && readdirSync(legacy).some((f) => f.endsWith('.zip'))) return legacy;
  } catch {
    // 读不了就按新默认走
  }
  return join(botDir, 'archivist');
}

/** 递归复制目录；onError 收集单个文件的失败，不中断整体。 */
async function copyDir(src, dest, onError, skip) {
  await mkdir(dest, { recursive: true });
  let entries;
  try {
    entries = await readdir(src, { withFileTypes: true });
  } catch (e) {
    onError(`${src}: ${e.code ?? e.message}`);
    return;
  }
  for (const entry of entries) {
    const s = join(src, entry.name);
    const d = join(dest, entry.name);
    if (skip?.(s, entry.name, entry.isDirectory())) continue;
    if (entry.isDirectory()) {
      await copyDir(s, d, onError, skip);
    } else if (entry.isFile()) {
      try {
        await copyFile(s, d);
      } catch (e) {
        onError(`${s}: ${e.code ?? e.message}`);
      }
    }
    // 符号链接与特殊文件跳过
  }
}

/** 复制单个文件；不存在时静默跳过。 */
async function copyOne(src, dest, onError) {
  if (!existsSync(src)) return false;
  try {
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(src, dest);
    return true;
  } catch (e) {
    onError(`${src}: ${e.code ?? e.message}`);
    return false;
  }
}

/** 调系统压缩命令。返回 { ok, detail }。 */
function compress(stageDir, zipPath) {
  return new Promise((done) => {
    const isWin = process.platform === 'win32';
    let cmd, args;
    if (isWin) {
      // Compress-Archive 会把 stageDir 的内容打成 zip（不含 stageDir 这层）
      cmd = 'powershell.exe';
      args = [
        '-NoProfile', '-NonInteractive', '-Command',
        `Compress-Archive -Path '${join(stageDir, '*')}' -DestinationPath '${zipPath}' -CompressionLevel Optimal -Force`,
      ];
    } else {
      cmd = 'zip';
      args = ['-r', '-q', zipPath, '.'];
    }
    const child = spawn(cmd, args, {
      cwd: isWin ? undefined : stageDir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    child.stderr?.on('data', (c) => { err += c.toString(); });
    child.on('error', (e) => done({ ok: false, detail: `压缩失败: ${e.message}` }));
    child.on('close', (code) => {
      if (code === 0 && existsSync(zipPath)) done({ ok: true, detail: 'ok' });
      else done({ ok: false, detail: `压缩退出码 ${code}: ${err.slice(0, 300)}` });
    });
    // 10 分钟上限
    setTimeout(() => { child.kill(); done({ ok: false, detail: '压缩超时' }); }, 10 * 60 * 1000).unref?.();
  });
}

/** 时间戳文件名：2026-11-05T17-44-00 */
function stamp(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}T${p(now.getHours())}-${p(now.getMinutes())}-${p(now.getSeconds())}`;
}

/** 从备份文件名解析时间（用于轮转排序）。解析不出返回 0。 */
function stampOf(name) {
  const m = /archivist-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(name);
  if (!m) return 0;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
}

/**
 * 把 `extraPaths` 配置解析成「包里的名字 → 原始绝对路径」。
 *
 * 单独抽出来是为了备份与恢复用同一份映射：恢复时才知道该放回哪里，
 * 快照时也知道该给哪些路径留副本。重名就加 `-2`、`-3` 后缀。
 *
 * @param {string} botDir
 * @param {object} cfg
 * @returns {{name: string, abs: string}[]}
 */
export function extraTargets(botDir, cfg) {
  const raw = String(cfg?.extraPaths ?? '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => !s.startsWith('#'));
  const out = [];
  const used = new Set();
  for (const item of raw) {
    const abs = resolve(botDir, item);
    if (!existsSync(abs)) continue;
    let name = basename(abs);
    for (let i = 2; used.has(name); i++) name = `${basename(abs)}-${i}`;
    used.add(name);
    out.push({ name, abs });
  }
  return out;
}

/**
 * 读出当前装的扩展版本表（包名 → 版本）。
 *
 * 扩展依赖登记在 `<deploy>/extensions/package.json`，也就是 botDir 的
 * 上两级目录：`<data>/home/companion` → `<data>/home` → `<data>` → `extensions`。
 * 读不到就给空表（备份不该因为这个失败）。
 *
 * 同时读 node_modules 里实际的 package.json 版本——依赖表写的是范围（`^0.3.4`），
 * 真正装的是哪个版本要看落盘的那份。
 *
 * @param {string} botDir
 * @returns {Record<string, string>}
 */
export function readExtensionVersions(botDir) {
  const out = {};
  const extDir = resolve(join(botDir, '..', '..', 'extensions'));
  try {
    const pkg = JSON.parse(readFileSync(join(extDir, 'package.json'), 'utf8'));
    const deps = pkg.dependencies ?? {};
    for (const name of Object.keys(deps)) {
      let version = null;
      try {
        version = JSON.parse(readFileSync(join(extDir, 'node_modules', name, 'package.json'), 'utf8')).version;
      } catch {
        // 装在别处或没装：退回依赖表里写的范围
      }
      out[name] = version ?? String(deps[name]);
    }
  } catch {
    // 没有 extensions 目录（单机部署）就算了
  }
  return out;
}

/** 执行一次备份。
 * @param {object} opts
 * @param {string} opts.botDir
 * @param {string} opts.dataDir
 * @param {object} opts.cfg         worlds.archivist 的活引用
 * @param {(msg: string, data?: object) => void} opts.log
 * @returns {Promise<{ok: boolean, file?: string, bytes?: number, ms?: number, detail: string}>}
 */
export async function runBackup({ botDir, dataDir, cfg, log }) {
  const started = Date.now();
  const errors = [];
  const onError = (msg) => { errors.push(msg); if (errors.length <= 20) log(`跳过 ${msg}`); };

  // ---- 决定目标目录 ----
  // 与 world.js 的 destDir() 保持一致：默认放在部署目录（botDir）下，不在 data/ 里面。
  // 老部署如果已经在 <dataDir>/archivist 里攒了旧包，就继续用那里。
  const destDir = cfg.destDir?.trim() ? resolve(cfg.destDir.trim()) : defaultDestDir({ botDir, dataDir });
  try {
    mkdirSync(destDir, { recursive: true });
  } catch (e) {
    return { ok: false, detail: `无法创建备份目录 ${destDir}: ${e.message}` };
  }

  // ---- 暂存目录 ----
  const stage = join(tmpdir(), `coopanion-archivist-${randomUUID()}`);
  await mkdir(stage, { recursive: true });

  try {
    const done = [];

    // ---- 1. 工作区（workspace 主体 / .git / blobs 三个独立开关） ----
    const wantWorkspace = cfg.sources?.workspace ?? true;
    const wantGit = cfg.sources?.['workspace-git'] ?? false;
    const wantBlobs = cfg.sources?.['workspace-blobs'] ?? true;
    if (wantWorkspace || wantGit || wantBlobs) {
      const wsSrc = join(botDir, 'workspace');
      if (existsSync(wsSrc)) {
        const target = join(stage, 'workspace');
        await mkdir(target, { recursive: true });
        const skipped = new Set();
        if (!wantBlobs) skipped.add('blobs');
        if (!wantGit) skipped.add('.git');

        if (wantWorkspace && skipped.size === 0) {
          // 全量：一次性复制，最快
          await copyDir(wsSrc, target, onError);
          done.push('workspace(全量)');
        } else if (wantWorkspace) {
          // 主体：复制 workspace 的子项，跳过未勾选的
          for (const entry of await readdir(wsSrc, { withFileTypes: true }).catch(() => [])) {
            if (skipped.has(entry.name)) continue;
            const s = join(wsSrc, entry.name);
            const d = join(target, entry.name);
            if (entry.isDirectory()) await copyDir(s, d, onError);
            else if (entry.isFile()) await copyOne(s, d, onError);
          }
          const label = `workspace(${skipped.size ? '不含 ' + [...skipped].join('/') : '全量'})`;
          done.push(label);
        } else {
          // 不需要主体，只按勾选补 .git / blobs
          if (wantGit) {
            const gSrc = join(wsSrc, '.git');
            if (existsSync(gSrc)) {
              await copyDir(gSrc, join(target, '.git'), onError);
              done.push('git历史');
            }
          }
          if (wantBlobs) {
            const bSrc = join(wsSrc, 'blobs');
            if (existsSync(bSrc)) {
              await copyDir(bSrc, join(target, 'blobs'), onError);
              done.push('blobs');
            }
          }
        }
      } else {
        onError(`工作区不存在: ${wsSrc}`);
      }
    }

    // ---- 2. 扩展数据（自动扫描 data 目录，跳过可重建的临时状态）----
    if (cfg.sources?.data ?? true) {
      const target = join(stage, 'data');
      await mkdir(target, { recursive: true });
      let nFiles = 0;
      let nDirs = 0;

      let entries = [];
      try {
        entries = await readdir(dataDir, { withFileTypes: true });
      } catch (e) {
        onError(`读不了数据目录 ${dataDir}: ${e.code ?? e.message}`);
      }

      // 存放位置可能就在 data/ 里面（老版本的默认位置）。绝不能把它打进包：
      // zip 本身已经压过，再打一次几乎不变小，体积会逐份接近翻倍，直到占满磁盘。
      // 这里按绝对路径判定，比只比名字更稳——用户也可能把存放位置指到 data/ 的某个子目录。
      const isSelfDir = (abs) => isInside(abs, destDir);

      for (const entry of entries) {
        // 跳过不需要备份的目录（venv、浏览器 profile、运行日志等）
        if (entry.isDirectory()) {
          if (DATA_SKIP_DIRS.has(entry.name)) continue;
          const abs = join(dataDir, entry.name);
          if (isSelfDir(abs)) {
            log(`跳过自己的存放位置 ${abs}（否则备份会把自己打进去）`);
            continue;
          }
          // 其它子目录整包带走（有些扩展把数据放在自己的子目录里），
          // 但任意层级上的浏览器 profile 一律跳过。
          await copyDir(abs, join(target, entry.name), onError,
            (p, name, isDir) => isDir && (skipAnyDir(name) || isSelfDir(p)));
          nDirs++;
          continue;
        }
        if (!entry.isFile()) continue;
        // 跳过可重建的状态/缓存文件
        if (DATA_SKIP.has(entry.name)) continue;
        // 只收数据类文件，跳过归档产物与日志
        if (!/\.(json|jsonl|db|sqlite|yaml|yml|txt|md)$/i.test(entry.name)) continue;
        if (await copyOne(join(dataDir, entry.name), join(target, entry.name), onError)) nFiles++;
      }

      const parts = [];
      if (nFiles) parts.push(`${nFiles} 个文件`);
      if (nDirs) parts.push(`${nDirs} 个目录`);
      if (parts.length) done.push(`扩展数据(${parts.join(' + ')})`);
    }

    // ---- 2b. 用户指定的额外路径 ----
    const extraList = extraTargets(botDir, cfg);
    // 逐条报出「配了但不存在」的路径，别让它静默消失
    for (const raw of String(cfg.extraPaths ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
      if (raw.startsWith('#')) continue;
      if (!extraList.some((e) => e.abs === resolve(botDir, raw))) onError(`额外路径不存在: ${raw}`);
    }
    if (extraList.length) {
      const target = join(stage, 'extra');
      const mapping = {};
      let n = 0;
      for (const { name, abs } of extraList) {
        mapping[name] = abs;
        const st = statSync(abs);
        if (st.isDirectory()) {
          await copyDir(abs, join(target, name), onError);
          n++;
        } else if (st.isFile()) {
          if (await copyOne(abs, join(target, name), onError)) n++;
        }
      }
      // 记下「包里的名字 → 原始绝对路径」，恢复时才能放回原处
      // （光看名字只知道 basename，会一股脑倒在 botDir 下）
      if (n) {
        await writeFile(
          join(target, 'extra-map.json'), JSON.stringify(mapping, null, 2), 'utf8',
        );
        done.push(`额外路径(${n})`);
      }
    }

    // ---- 3. 配置与密钥 ----
    if (cfg.sources?.config ?? true) {
      const target = join(stage, 'config');
      await mkdir(target, { recursive: true });
      let n = 0;
      for (const f of CONFIG_FILES) {
        if (await copyOne(join(botDir, f), join(target, f), onError)) n++;
      }
      for (const d of CONFIG_DIRS) {
        const src = join(botDir, d);
        if (existsSync(src)) {
          await copyDir(src, join(target, d), onError);
          n++;
        }
      }
      if (n) done.push(`配置(${n}项)`);
    }

    // ---- 4. 扩展包（默认关，体积大） ----
    if (cfg.includeExtensions) {
      // 扩展在部署的上一级：<data>\extensions
      const extSrc = join(dirname(botDir), '..', 'extensions');
      const extAbs = resolve(extSrc);
      if (existsSync(extAbs)) {
        await copyDir(extAbs, join(stage, 'extensions'), onError);
        done.push('extensions');
      } else {
        onError(`扩展目录不存在: ${extAbs}`);
      }
    }

    if (!done.length) {
      return { ok: false, detail: `没有可备份的内容（勾选项都没匹配到文件）` };
    }

    // ---- 4b. 记下此刻装的扩展版本 ----
    // 恢复时用来比对：备份说的是 0.5.0 时代的数据，现在跑的是 0.6.0 的代码，
    // 旧格式配上新代码可能被静默误读。只存版本表，几十个包也就几 KB。
    const extVersions = readExtensionVersions(botDir);
    if (Object.keys(extVersions).length) {
      await writeFile(
        join(stage, 'EXTENSIONS.json'),
        JSON.stringify({ capturedAt: new Date().toISOString(), packages: extVersions }, null, 2),
        'utf8',
      );
    }

    // ---- 5. 写一份清单 ----
    const manifest = [
      `# Coopanion 归档清单`,
      ``,
      `- 时间: ${new Date().toISOString()}`,
      `- 主机: ${process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? 'unknown'}`,
      `- botDir: ${botDir}`,
      `- dataDir: ${dataDir}`,
      `- 内容: ${done.join('、')}`,
      `- 跳过: ${errors.length} 个文件（详见日志）`,
      ``,
      `## 恢复方式`,
      ``,
      `1. 解压本 zip`,
      `2. workspace/ → 复制回 <botDir>/workspace/`,
      `3. data/ → 复制回 <dataDir>/（各扩展的数据文件）`,
      `4. config/config.json → 复制回 <botDir>/config.json`,
      `5. config/.env → 复制回 <botDir>/.env`,
      `6. config/providers/ → 复制回 <botDir>/providers/`,
      `7. extra/ → 按原路径放回（用户指定的额外路径）`,
      `8. 重启 Coopanion`,
      ``,
      `注意：data/ 里不含体积大且可重建的运行时目录`,
      `（fish-sing 的 venv、socialmedia 的浏览器 profile、runs 日志等）。`,
      `恢复后扩展会在下次启动时自行重建它们。`,
      ``,
    ].join('\n');
    await writeFile(join(stage, 'MANIFEST.md'), manifest, 'utf8');

    // ---- 6. 压缩 ----
    const zipPath = join(destDir, `archivist-${stamp()}.zip`);
    const z = await compress(stage, zipPath);
    if (!z.ok) return { ok: false, detail: z.detail };

    const bytes = statSync(zipPath).size;

    // ---- 7. 轮转 ----
    const removed = await rotate(destDir, cfg.keepCount ?? 14, log);

    const ms = Date.now() - started;
    return {
      ok: true,
      file: zipPath,
      bytes,
      ms,
      detail: `已备份 ${done.join('、')}${errors.length ? `，跳过 ${errors.length} 个文件` : ''}${removed ? `，清理 ${removed} 份旧包` : ''}`,
    };
  } catch (e) {
    return { ok: false, detail: `备份异常: ${e.message}` };
  } finally {
    // 无论成败都清暂存目录
    await rm(stage, { recursive: true, force: true }).catch(() => {});
  }
}

/** 只保留最近 keep 份，返回删除数量。 */
async function rotate(destDir, keep, log) {
  let files;
  try {
    files = readdirSync(destDir).filter((f) => /^archivist-.*\.zip$/.test(f));
  } catch {
    return 0;
  }
  if (files.length <= keep) return 0;
  const sorted = files.map((f) => ({ f, t: stampOf(f) })).sort((a, b) => a.t - b.t);
  const drop = sorted.slice(0, sorted.length - keep);
  let n = 0;
  for (const { f } of drop) {
    try {
      await rm(join(destDir, f), { force: true });
      n++;
      log(`清理旧备份 ${f}`);
    } catch {}
  }
  return n;
}

/** 列出已有备份（给 WebUI / 工具用）。 */
export function listBackups(destDir) {
  if (!destDir) return [];
  try {
    return readdirSync(destDir)
      .filter((f) => /^archivist-.*\.zip$/.test(f))
      .map((f) => {
        const p = join(destDir, f);
        let bytes = 0;
        let at = 0;
        try { const st = statSync(p); bytes = st.size; at = st.mtimeMs; } catch {}
        return { name: f, path: p, bytes, at };
      })
      .sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
}
