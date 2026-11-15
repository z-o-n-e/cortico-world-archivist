/**
 * 归档扩展的 World 实现。
 *
 * 设计为「零上下文成本」：
 *  - envPromptVars() 返回 null → 不进系统前缀
 *  - tools() 返回 [] → 零工具，不进工具表
 *  - 只做后台定时备份，外加面板上的手动备份 / 恢复
 */
import { join, resolve } from 'node:path';
import { runBackup, listBackups, defaultDestDir } from './backup.js';
import { runRestore } from './restore.js';
import { configGroups, normalizeSources, TITLES_ZH, TITLES_EN } from './config.js';
import { fileLogger } from './log.js';

const DEFAULT_DEST_SUBDIR = 'archivist';

/** 轮询间隔：面板开关靠它兑现，短一点手感好，代价只是读一次配置。 */
const TICK_MS = 15_000;

/** 恢复到「确认口令」：输对才动作，防手滑。 */
const CONFIRM_TOKENS = new Set(['RESTORE', '恢复']);

/** 口令校验（宽松大小写，严格用词）。 */
export function confirmed(raw) {
  const t = String(raw ?? '').trim();
  return CONFIRM_TOKENS.has(t.toUpperCase()) || CONFIRM_TOKENS.has(t);
}

export class ArchivistWorld {
  constructor({ ctx }) {
    this.ctx = ctx;
    this.timer = null;
    this.running = null;     // 正在跑的备份 Promise，防重入
    this.restoring = null;   // 正在跑的恢复 Promise，防重入
    this.lastRun = { at: '', result: '', bytes: 0 };
    this.lastRestore = { at: '', result: '' };
    this.started = false;

    // 老配置里可能留着改过名的源 id，或缺了新加的源：构造时先修好，
    // 这样 WebUI 一读配置就是对的（缺键会把勾选框画成「没勾」，一保存就真关了）。
    try {
      if (normalizeSources(ctx.cfg)) {
        ctx.persist?.({ sources: { ...ctx.cfg.sources } });
      }
    } catch (e) {
      this.logWarn(`源配置修正失败 ${e.message}`);
    }
  }

  get id() {
    return 'archivist';
  }

  /** 不进前缀。 */
  envPromptVars() {
    return null;
  }

  /** 零工具。 */
  tools() {
    return [];
  }

  /**
   * 配置表单由这里注册（不走 definition.config）。
   * config 里的组是纯 JSON Schema，WebUI 直接渲染，不需要构建产物。
   */
  webUi(language) {
    const lang = language === 'en' ? 'en' : 'zh';
    return { config: configGroups(lang === 'en' ? TITLES_EN : TITLES_ZH, lang) };
  }

  /**
   * 目标目录（配置留空时的默认存放位置）。
   *
   * 默认放在**部署目录**（botDir）下，不再放在 data/ 里面。
   * 原因：`data/` 会被「扩展数据」整目录扫描，放在里面等于让每一份新备份
   * 把之前的 zip 也打进去——zip 已经压过，再打一次几乎不变小，体积逐份接近翻倍。
   *
   * 老部署升级上来时，`<dataDir>/archivist` 里可能已经有一堆旧包。
   * 这时如果它非空，就继续用它：突然换地方会让「保留份数」的轮转在新目录里
   * 从零开始，旧包再也清不掉。backup.js 的跳过判定按绝对路径做，两个位置都安全。
   */
  destDir() {
    const raw = this.ctx.cfg.destDir;
    if (raw && String(raw).trim()) return String(raw).trim();
    return defaultDestDir({ botDir: this.ctx.botDir, dataDir: this.ctx.dataDir });
  }

  /** 下一次该备份的时间（毫秒时间戳）；没有历史则立即。 */
  nextDueAt() {
    const hours = Math.max(1, Number(this.ctx.cfg.intervalHours) || 24);
    const last = this.ctx.cfg.lastRunAt ? Date.parse(this.ctx.cfg.lastRunAt) : NaN;
    if (!Number.isFinite(last)) return Date.now();
    return last + hours * 3600_000;
  }

  /**
   * 日志器：写一份到 <存放位置>/archivist.log，同时打一份到控制台。
   *
   * `WorldContext` 没有 `log` 字段（api 6 不给），所以框架的日志通道扩展用不了；
   * 而「备份静默失败」是这类工具最坏的失败方式，宁可自己写个文件。
   * 存放位置改了会自动换文件。
   */
  get logger() {
    let dest;
    try {
      dest = this.destDir();
    } catch {
      dest = join(this.ctx.dataDir, DEFAULT_DEST_SUBDIR);
    }
    if (!this._logger || this._loggerDir !== dest) {
      this._loggerDir = dest;
      this._logger = fileLogger(join(dest, 'archivist.log'), (text) => console.info(text));
    }
    return this._logger;
  }

  log(message, data) {
    try {
      this.logger.info(message, data);
    } catch {
      // 日志不该影响干活
    }
  }

  logWarn(message, data) {
    try {
      this.logger.warn(message, data);
    } catch {
      // 同上
    }
  }

  async start() {
    if (this.started) return;
    this.started = true;

    // 启动时先补一次：上次备份已经超期（或从没备份过）就立刻做
    const due = this.nextDueAt();
    if (Date.now() >= due) {
      this.log('启动检查：备份已超期，立即执行');
      void this.backup('启动补备份').catch(() => {});
    } else {
      this.log(`启动检查：距下次备份还有 ${Math.round((due - Date.now()) / 60000)} 分钟`);
    }

    // 每 TICK_MS 跑一次 tick()：检查是否到点 + 兑现面板上的两个开关
    this.timer = setInterval(() => { void this.tick().catch(() => {}); }, TICK_MS);
    this.timer.unref?.();
  }

  /**
   * 一次轮询。
   * 抽成独立方法是为了能测：定时器不好等，测试可以直接 await 它。
   */
  async tick() {
    // ① 到点备份（恢复进行中不抢文件）
    if (!this.restoring && Date.now() >= this.nextDueAt()) {
      await this.backup('定时').catch(() => {});
    }

    // ② 面板上「立即备份」被拨到 true → 执行一次后自动拨回 false
    if (this.ctx.cfg.backupNow === true) {
      this.ctx.persist({ backupNow: false });
      if (this.restoring) this.log('恢复进行中，跳过这次手动备份');
      else await this.backup('面板手动').catch(() => {});
    }

    // ③ 面板上「立即恢复」被拨到 true → 先核口令，再动作
    if (this.ctx.cfg.restoreNow === true) {
      this.ctx.persist({ restoreNow: false });
      if (!confirmed(this.ctx.cfg.restoreConfirm)) {
        const detail = '确认口令不对，已拒绝恢复。请原样输入 RESTORE（或「恢复」）后再拨开关。';
        this.logWarn(detail);
        this.lastRestore = { at: new Date().toISOString(), result: detail };
        this.ctx.persist({ lastRestoreAt: this.lastRestore.at, lastRestoreResult: detail });
      } else if (this.running) {
        this.log('备份进行中，跳过这次恢复');
      } else {
        await this.restore('面板手动').catch(() => {});
      }
    }
  }

  async stop() {
    this.started = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // 等正在跑的备份/恢复结束（最多 30 秒）
    if (this.running) {
      await Promise.race([this.running, new Promise((r) => setTimeout(r, 30_000))]).catch(() => {});
    }
    if (this.restoring) {
      await Promise.race([this.restoring, new Promise((r) => setTimeout(r, 30_000))]).catch(() => {});
    }
  }

  /** 执行一次备份（防重入）。 */
  async backup(reason = '手动') {
    if (this.running) return this.running;

    this.running = (async () => {
      this.log(`开始备份（${reason}）`);
      const r = await runBackup({
        botDir: this.ctx.botDir,
        dataDir: this.ctx.dataDir,
        cfg: this.ctx.cfg,
        log: (m, d) => this.logWarn(m, d),
      });

      // 记录结果，供面板和工具读
      const at = new Date().toISOString();
      this.lastRun = { at, result: r.detail, bytes: r.bytes ?? 0 };
      this.ctx.persist({ lastRunAt: at, lastResult: r.detail });

      if (r.ok) {
        this.log(`备份完成 ${r.file}（${(r.bytes / 1024 / 1024).toFixed(1)} MB，${r.ms} ms）`);
      } else {
        this.logWarn(`备份失败 ${r.detail}`);
      }
      return r;
    })().finally(() => {
      this.running = null;
    });

    return this.running;
  }

  /** 要恢复的备份文件：配置里选了就用它，留空则取最新的那一份。 */
  zipFile() {
    const raw = this.ctx.cfg.restoreFile;
    const picked = raw && String(raw).trim();
    if (picked) return resolve(picked);
    const latest = listBackups(this.destDir())[0];
    return latest ? latest.path : null;
  }

  /** 执行一次恢复（防重入，且与备份互斥）。 */
  async restore(reason = '手动') {
    if (this.restoring) return this.restoring;
    if (this.running) {
      return { ok: false, detail: '备份正在跑，等它结束再恢复。' };
    }

    this.restoring = (async () => {
      const zipPath = this.zipFile();
      const at = new Date().toISOString();
      if (!zipPath) {
        const detail = '没有找到可恢复的备份：存放位置里没有 archivist-*.zip，也没有手动指定文件。';
        this.logWarn(detail);
        this.lastRestore = { at, result: detail };
        this.ctx.persist({ lastRestoreAt: at, lastRestoreResult: detail });
        return { ok: false, detail };
      }

      this.log(`开始恢复（${reason}）← ${zipPath}`);
      const r = await runRestore({
        botDir: this.ctx.botDir,
        dataDir: this.ctx.dataDir,
        cfg: this.ctx.cfg,
        zipPath,
        log: (m, d) => this.log(m, d),
      });

      this.lastRestore = { at, result: r.detail };
      this.ctx.persist({ lastRestoreAt: at, lastRestoreResult: r.detail });

      if (r.ok) this.log(`恢复完成：${r.detail}`);
      else this.logWarn(`恢复失败 ${r.detail}`);
      return r;
    })().finally(() => {
      this.restoring = null;
    });

    return this.restoring;
  }

  /** 面板数据（仅供内部与日志使用，不注册 WebUI 面板）。 */
  status() {
    const dest = this.destDir();
    const list = listBackups(dest);
    return {
      destDir: dest,
      count: list.length,
      latest: list[0] ?? null,
      totalBytes: list.reduce((s, x) => s + x.bytes, 0),
      backups: list.slice(0, 20),
      lastRun: this.lastRun,
      lastRestore: this.lastRestore,
      restoreFile: this.zipFile(),
      nextDueAt: new Date(this.nextDueAt()).toISOString(),
      running: Boolean(this.running),
      restoring: Boolean(this.restoring),
      sources: this.ctx.cfg.sources ?? {},
      keepCount: this.ctx.cfg.keepCount,
      intervalHours: this.ctx.cfg.intervalHours,
    };
  }
}
