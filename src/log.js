/**
 * 归档扩展自己的日志。
 *
 * 为什么不走框架：`WorldContext` 没有 `log` 字段（api 6 只给 cfg/botDir/dataDir/persist 这些），
 * 所以扩展里 `ctx.log?.info?.(...)` 全是空转——备份静默失败也没人知道。
 *
 * 这里直接往备份目录里写一个纯文本 `archivist.log`：
 *  - 和 zip 放一起，用户找得到、出了问题能直接发出来
 *  - 追加写，单文件，超过 maxBytes 就从头截断（不留历史，这不是审计日志）
 *  - 任何一步失败都吞掉：日志写不进去不能反过来搞坏备份
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { dirname } from 'node:path';

const MAX_BYTES = 512 * 1024;

/** 一行：`2026-11-05T19:00:00.000Z WARN  message {json}`。 */
function line(level, message, data) {
  const tail = data === undefined ? '' : ` ${safeJson(data)}`;
  return `${new Date().toISOString()} ${level.padEnd(5)} ${message}${tail}\n`;
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * 造一个把日志写进 file 的记录器。
 * @param {string} file               日志文件绝对路径（目录不存在会自动建）
 * @param {(msg:string)=>void} [echo] 同时输出到控制台（可选）
 */
export function fileLogger(file, echo) {
  let ready = false;

  const write = (level, message, data) => {
    const text = line(level, message, data);
    // 控制台永远留一份：core.log 里至少还能看到
    if (echo) echo(text.trimEnd());
    void (async () => {
      try {
        if (!ready) {
          await mkdir(dirname(file), { recursive: true });
          await trim(file);
          ready = true;
        }
        await appendFile(file, text, 'utf8');
      } catch {
        ready = false; // 下次再试，包括目录被删掉的情况
      }
    })();
  };

  return {
    file,
    info: (message, data) => write('INFO', message, data),
    warn: (message, data) => write('WARN', message, data),
  };
}

/** 太大就只留最后一半。 */
async function trim(file) {
  try {
    if (statSync(file).size <= MAX_BYTES) return;
    const text = await readFile(file, 'utf8');
    await writeFile(file, text.slice(-Math.floor(MAX_BYTES / 2)), 'utf8');
  } catch {
    // 文件不存在或读不了：不用管
  }
}
