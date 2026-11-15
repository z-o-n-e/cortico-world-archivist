/**
 * 归档扩展的配置项定义。
 *
 * 所有项都带 x-hot，改完立即生效（不需要重启 World）。
 * 目录类字段用 x-path kind='directory'，WebUI 会渲染「浏览」按钮。
 */

/** 中英文案。world.js 与 index.js 共用。 */
export const TITLES_ZH = {
  main: '备份设置',
  backupNow: '立即备份一次',
  backupNowNote: '拨到开 → 一分钟内开始备份，做完自动关回去。用来验证配置或临时留个快照。',
  intervalHours: '备份间隔',
  intervalHoursNote: '多久备份一次。进程重启后会检查是否超期，超了就立刻补一次。',
  hours: '小时',
  keepCount: '保留份数',
  keepCountNote: '备份是滚动的：超过这个数量就自动删掉最老的一份。',
  copies: '份',
  destDir: '存放位置',
  destDirNote: '备份 zip 存到哪个文件夹。留空 = 部署目录下的 archivist 文件夹（在 data/ 之外，不会被下一次备份打包进去）。建议放到另一块硬盘或网盘同步目录。',
  extraPaths: '额外要备份的路径',
  extraPathsNote: '一行一个，绝对路径或相对部署目录均可。给那些把数据放在子目录、或装在别处的扩展补漏。一般不用填。',
  includeExtensions: '连带扩展包',
  includeExtensionsNote: '把已安装的扩展也打包。体积大（几十 MB），一般不用——扩展可以从网上重新装。',
  sources: '备份内容',
  sourcesNote: '勾选要打包的东西。备份和恢复共用这份勾选：备份时打包哪些，恢复时就放回哪些。取消全部勾选会导致备份为空、直接失败。',
  statusTitle: '上次结果',
  statusNote: '这一组由扩展自动写入，不需要手动改。',
  lastRunAt: '上次备份时间',
  lastResult: '上次备份结果',
  // ---- 恢复 ----
  restoreTitle: '恢复（危险）',
  restoreNote: '把备份里的文件原样放回原位。⚠️ 覆盖面比「她的记忆」大得多：恢复会覆盖【所有扩展的数据目录与数据文件】（data/ 下各扩展存的记忆库、档案、卡片、表情包索引、词汇本等）、【所有 World 的配置】（config.json 里的每一个 Worlds 段，不只是本扩展）、以及【全部密钥】（.env、providers/ 选择器里的所有模型渠道 Key）。恢复前会先把当前状态存一份到存放位置下的 before-restore-<时间>/，万一后悔还能拿回来。恢复完成后必须重启 Coopanion。',
  restoreFile: '要恢复的备份',
  restoreFileNote: '选一个 .zip 备份文件。留空 = 用存放位置里最新的那一份。',
  restoreConfirm: '确认口令',
  restoreConfirmNote: '恢复会覆盖上面说的全部范围。确实要恢复，请在这里原样输入 RESTORE（或「恢复」两个字）。口令不对，下面的开关不会动作。',
  restoreNow: '立即恢复',
  restoreNowNote: '口令填对之后拨到开 → 一分钟内开始恢复，做完自动关回去。恢复期间请勿关闭 Coopanion。',
  lastRestoreAt: '上次恢复时间',
  lastRestoreResult: '上次恢复结果',
};

export const TITLES_EN = {
  main: 'Backup settings',
  backupNow: 'Back up now',
  backupNowNote: 'Switch on → a backup starts within a minute and the switch flips back. Useful for testing config or taking an ad-hoc snapshot.',
  intervalHours: 'Backup interval',
  intervalHoursNote: 'How often to back up. On restart, an overdue backup runs immediately.',
  hours: 'hours',
  keepCount: 'Copies to keep',
  keepCountNote: 'Rolling: the oldest archive is deleted once this many exist.',
  copies: 'files',
  destDir: 'Destination',
  destDirNote: 'Folder for the zip files. Empty = the archivist folder in the deployment directory, outside data/, so backups never pack themselves. Prefer another disk or a synced folder.',
  extraPaths: 'Extra paths to back up',
  extraPathsNote: 'One per line; absolute, or relative to the deployment directory. For extensions that keep data in a subfolder or elsewhere. Usually unnecessary.',
  includeExtensions: 'Include extensions',
  includeExtensionsNote: 'Also pack installed extensions. Large and downloadable, so usually unnecessary.',
  sources: 'What to back up',
  sourcesNote: 'Pick what goes into the archive. Backup and restore share this list: what is archived is what gets put back. Unchecking everything makes the backup fail as empty.',
  statusTitle: 'Last result',
  statusNote: 'Written by the extension; no need to edit.',
  lastRunAt: 'Last backup',
  lastResult: 'Backup result',
  // ---- restore ----
  restoreTitle: 'Restore (dangerous)',
  restoreNote: 'Puts archived files back where they belong. ⚠️ This covers far more than her memories: it overwrites ALL extension data (the memory stores, archives, cards, sticker index and vocabulary that every extension keeps under data/), ALL World configuration (every Worlds section in config.json, not just this extension), and ALL API keys (.env plus every model channel under providers/). The current state is first copied to before-restore-<time>/ inside the destination folder, so a mistake is recoverable. Coopanion must be restarted afterwards.',
  restoreFile: 'Archive to restore',
  restoreFileNote: 'Pick a .zip archive. Empty = the newest one in the destination folder.',
  restoreConfirm: 'Confirmation code',
  restoreConfirmNote: 'Restoring overwrites everything listed above. To proceed, type RESTORE here exactly. The switch below does nothing without it.',
  restoreNow: 'Restore now',
  restoreNowNote: 'With the code in place, switch on → the restore starts within a minute and the switch flips back. Do not quit Coopanion while it runs.',
  lastRestoreAt: 'Last restore',
  lastRestoreResult: 'Restore result',
};

/**
 * 一个可勾选的源。
 * @typedef {{ id: string, rel: string, root: 'bot'|'data', defaultOn: boolean, title: string, note: string }} SourceDecl
 */

/**
 * 可勾选备份的源。顺序就是 WebUI 里的显示顺序。
 *
 * 每一项都写中英两套文案：这套扩展是给别人的部署装的，他们的界面可能是英文。
 * 说明里不写「多大」「几个文件」这类本机实测数——换台机器就不对了；
 * 也不写只有这个部署才懂的具体东西，别人看不懂。
 */
export const SOURCES = [
  // ---- workspace 里的东西（botDir 下） ----
  {
    id: 'workspace',
    rel: 'workspace',
    root: 'bot',
    defaultOn: true,
    title: '工作区全部',
    note: '她的画像、自述、日记、笔记、交接档案、卡片——体积最大，也最要紧',
    enTitle: 'Whole workspace',
    enNote: 'Her persona, self-narrative, diary, notes, handoffs and cards — the largest part, and the one that matters most.',
  },
  {
    id: 'workspace-git',
    rel: 'workspace/.git',
    root: 'bot',
    defaultOn: false,
    title: '工作区 git 历史',
    note: '她每次写作的完整版本历史。能回滚到任意一天，但体积大、压缩率低。要不要历史二选一即可',
    enTitle: 'Workspace git history',
    enNote: 'Full version history of everything she wrote; lets you roll back to any day. Large and compresses poorly, so keep either history or no history.',
  },
  {
    id: 'workspace-blobs',
    rel: 'workspace/blobs',
    root: 'bot',
    defaultOn: true,
    title: '工作区附件（blobs）',
    note: '她保存的图片、音频等二进制文件——她自己画过、收到、存下来的那些东西，丢了没法重新生成。体积一般不大，默认勾上',
    enTitle: 'Workspace attachments (blobs)',
    enNote: 'Images, audio and other binary files she saved — things she drew, received or kept. Once lost they cannot be regenerated. Usually small, so it is on by default.',
  },
  // ---- 扩展数据（dataDir 下，自动扫描） ----
  {
    id: 'data',
    rel: '',
    root: 'data',
    defaultOn: true,
    title: '扩展数据（data/ 下的文件）',
    note: '自动扫描 data 目录里所有扩展存的数据：记忆库、档案、卡片、表情包索引、词汇本……装了什么扩展就备份什么，不用手动配。仅跳过可重建的临时状态、缓存与浏览器 profile，以及备份自己的存放位置。',
    enTitle: 'Extension data (files under data/)',
    enNote: 'Scans the data folder for whatever the installed extensions store: memory databases, archives, cards, sticker index, vocabulary… Nothing to configure — only rebuildable runtime state, caches, browser profiles and the backup folder itself are skipped.',
  },
  // ---- 配置 ----
  {
    id: 'config',
    rel: '',
    root: 'bot',
    defaultOn: true,
    title: '配置与密钥',
    note: 'config.json、.env、providers/ 下的模型渠道配置。注意这是整套配置：恢复时 config.json 里【所有 World 的配置】和【全部渠道密钥】都会一起回到备份时的样子',
    enTitle: 'Config and secrets',
    enNote: 'config.json, .env, and the model channel configs under providers/. Note that this is the whole thing: restoring puts back EVERY World section in config.json and EVERY channel key as of the backup.',
  },
];

/**
 * data 目录里不必备份的文件 —— 都是「可以重建的临时状态或缓存」。
 *
 * 判定标准：删掉之后，扩展下次启动能自己重建，且不会丢任何她积累的内容。
 * 不在这份名单里的 JSON 一律备份，这样装了新扩展时自动被覆盖。
 */
export const DATA_SKIP = new Set([
  // 进程/运行状态，重启即重建
  'core-state.json',
  'state.json',
  'proactive-state.json',
  // 桥接与后端选择的运行期快照
  'fatfish-bridge.json',
  'memory-backend.json',
  // 去重与观测缓存
  'vision-seen.json',
  'qqbot-known-messages.json',
  // 远端目录/余额缓存，联网即刷新
  'workbuddy-catalog.json',
  'workbuddy-balance.json',
  'bottle-font-catalog.json',
  // 运行流水（属于 session，不属于长期记忆；且有 usage/runs 专门记录）
  'session-main.jsonl',
  'usage.jsonl',
  'vision-accounting.jsonl',
  // 反向代理 token，敏感且可重生成
  'reverse-token.txt',
]);

/** data 目录里不必备份的目录 —— 体积大，且都能重建或重新获取。 */
export const DATA_SKIP_DIRS = new Set([
  'fish-sing',      // TTS 运行时（venv，几 GB）
  'socialmedia',    // 浏览器 profile（几百 MB）
  'dream',          // 做梦的 ego 空间状态
  'ego',            // ego 运行目录（含 rounds 临时文件）
  'runs',           // 运行日志
  'pnpm',           // 包管理器缓存
  'blobs',          // 二进制仓库（已在 workspace 里单独处理）
  'media',          // 图片缓存（几百张、近百 MB，可重新抓取）
  'figures',        // 手办/立绘素材（十几 MB）
  'emoji',          // 表情包图片（已由 qqbot 的索引+kb 描述，图片可重新收藏）
  'qq-video',       // 视频缓存
  'emote-pics-popup', // 弹窗临时资源
  'bilibili-video', // 视频素材缓存
  'archivist',      // 老版本的默认存放位置。留着这一条，免得升级后把旧包又打进去
]);

/**
 * 目录名命中就算跳过 —— 在任意层级的子目录上都生效。
 *
 * `DATA_SKIP_DIRS` 只比对 data/ 的顶层，所以像 `stroll/douyin-profile`
 * 这种嵌在扩展自己的目录里的浏览器 profile 会整包被带走（几十 MB，
 * 全是可以重建的缓存，打包时还容易撞上 EBUSY）。
 */
export const DATA_SKIP_ANY_DIR = new Set([
  'douyin-profile',
  'browser-profile',
  'chrome-profile',
  '*-profile',
]);

/**
 * 判断某个目录名（任意层级）是否该跳过。
 * 支持 `*-profile` 这种后缀式通配。
 * @param {string} name
 */
export function skipAnyDir(name) {
  if (DATA_SKIP_ANY_DIR.has(name)) return true;
  return name.endsWith('-profile');
}

/** config 源要打包的具体文件（相对 botDir）。 */
export const CONFIG_FILES = [
  'config.json',
  '.env',
];

/** config 源要打包的目录（相对 botDir），递归。 */
export const CONFIG_DIRS = [
  'providers',
];

/** 配置默认值。 */
export function defaults() {
  const sources = {};
  for (const s of SOURCES) sources[s.id] = s.defaultOn;
  return {
    enabled: false,
    intervalHours: 24,
    keepCount: 14,
    destDir: '',
    sources,
    extraPaths: '',
    includeExtensions: false,
    backupNow: false,
    // ---- 恢复 ----
    restoreNow: false,
    restoreFile: '',
    restoreConfirm: '',
    lastRestoreAt: '',
    lastRestoreResult: '',
    lastRunAt: '',
    lastResult: '',
  };
}

/**
 * 老版本用过、现在没有了的源 id → 现在的 id。
 *
 * 配置文件是「写下去就不再动」的，源改名后旧键会一直留在 cfg.sources 里。
 * 缺键比旧键更麻烦：面板读到 undefined 会把勾选框画成「没勾」，
 * 用户一保存就真的把它关掉了。所以启动时按默认值补齐。
 */
export const SOURCE_RENAMES = {
  memory: 'data',
};

/**
 * 就地修正 cfg.sources：旧 id 改名、缺的按默认值补上、多余的键删掉。
 * @returns {boolean} 是否改过（改过就该 persist 一次）
 */
export function normalizeSources(cfg) {
  const current = cfg.sources && typeof cfg.sources === 'object' ? cfg.sources : null;
  const next = current ? { ...current } : {};
  let changed = !current;

  for (const [oldId, newId] of Object.entries(SOURCE_RENAMES)) {
    if (!(oldId in next)) continue;
    if (!(newId in next)) next[newId] = next[oldId];
    delete next[oldId];
    changed = true;
  }
  for (const decl of SOURCES) {
    if (decl.id in next) continue;
    next[decl.id] = decl.defaultOn;
    changed = true;
  }
  // 只留声明过的 id：将来删掉某个源时，旧键不会又把面板画歪
  const declared = new Set(SOURCES.map((s) => s.id));
  for (const key of Object.keys(next)) {
    if (!declared.has(key)) {
      delete next[key];
      changed = true;
    }
  }

  if (changed) cfg.sources = next;
  return changed;
}

/** 把配置声明成 WebUI 表单。`language` 决定勾选项用中文还是英文文案。 */
export function configGroups(titles, language = 'zh') {
  const en = language === 'en';
  const sourcesProps = {};
  for (const s of SOURCES) {
    sourcesProps[`worlds.archivist.sources.${s.id}`] = {
      type: 'boolean',
      title: en ? s.enTitle ?? s.title : s.title,
      description: en ? s.enNote ?? s.note : s.note,
      'x-hot': true,
    };
  }
  return [
    {
      id: 'world:archivist',
      owner: 'world:archivist',
      schema: {
        type: 'object',
        title: titles.main,
        properties: {
          'worlds.archivist.backupNow': {
            type: 'boolean',
            title: titles.backupNow,
            description: titles.backupNowNote,
            'x-hot': true,
          },
          'worlds.archivist.intervalHours': {
            type: 'integer',
            title: titles.intervalHours,
            description: titles.intervalHoursNote,
            minimum: 1,
            maximum: 168,
            'x-suffix': titles.hours,
            'x-hot': true,
          },
          'worlds.archivist.keepCount': {
            type: 'integer',
            title: titles.keepCount,
            description: titles.keepCountNote,
            minimum: 1,
            maximum: 365,
            'x-suffix': titles.copies,
            'x-hot': true,
          },
          'worlds.archivist.destDir': {
            type: 'string',
            title: titles.destDir,
            description: titles.destDirNote,
            'x-path': { kind: 'directory' },
            'x-hot': true,
          },
          'worlds.archivist.extraPaths': {
            type: 'string',
            title: titles.extraPaths,
            description: titles.extraPathsNote,
            'x-hot': true,
          },
          'worlds.archivist.includeExtensions': {
            type: 'boolean',
            title: titles.includeExtensions,
            description: titles.includeExtensionsNote,
            'x-hot': true,
          },
        },
      },
    },
    {
      id: 'world:archivist:sources',
      owner: 'world:archivist',
      schema: {
        type: 'object',
        title: titles.sources,
        description: titles.sourcesNote,
        properties: sourcesProps,
      },
    },
    {
      id: 'world:archivist:restore',
      owner: 'world:archivist',
      schema: {
        type: 'object',
        title: titles.restoreTitle,
        description: titles.restoreNote,
        properties: {
          'worlds.archivist.restoreFile': {
            type: 'string',
            title: titles.restoreFile,
            description: titles.restoreFileNote,
            'x-path': { kind: 'file', extensions: ['zip'] },
            'x-hot': true,
          },
          'worlds.archivist.restoreConfirm': {
            type: 'string',
            title: titles.restoreConfirm,
            description: titles.restoreConfirmNote,
            'x-warning': true,
            'x-hot': true,
          },
          'worlds.archivist.restoreNow': {
            type: 'boolean',
            title: titles.restoreNow,
            description: titles.restoreNowNote,
            'x-warning': true,
            'x-hot': true,
          },
        },
      },
    },
    {
      id: 'world:archivist:status',
      owner: 'world:archivist',
      schema: {
        type: 'object',
        title: titles.statusTitle,
        description: titles.statusNote,
        properties: {
          'worlds.archivist.lastRunAt': {
            type: 'string',
            title: titles.lastRunAt,
          },
          'worlds.archivist.lastResult': {
            type: 'string',
            title: titles.lastResult,
          },
          'worlds.archivist.lastRestoreAt': {
            type: 'string',
            title: titles.lastRestoreAt,
          },
          'worlds.archivist.lastRestoreResult': {
            type: 'string',
            title: titles.lastRestoreResult,
          },
        },
      },
    },
  ];
}
