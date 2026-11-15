import { ArchivistWorld } from './world.js';
import { defaults } from './config.js';

export const ARCHIVIST = {
  id: 'archivist',
  // 名字只影响界面；id 与包名保持不变，配置段 worlds.archivist 才不会被搬走。
  label: '备份与恢复',
  defaults,
  // 配置表单在 World 实例的 webUi().config 里注册（纯 JSON Schema，无需构建产物）。
  create: (ctx) => new ArchivistWorld({ ctx }),
  describe: {
    tools: [],
    events: [],
  },
};

export default ARCHIVIST;
