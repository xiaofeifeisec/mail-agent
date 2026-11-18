/**
 * voice/audio.ts —— ② 音频文件的落盘与路径守卫。
 *
 * 【定位】语音工具产出的音频文件统一放一个根目录（默认 ~/.dsh/voice）。这个
 *         文件负责：算出根目录、生成新文件路径、把文件提交进根目录、校验路径
 *         没有跑出去。
 *
 * 【为什么必须有路径守卫】根目录里的文件路径会被带进"给模型看"的返回值里。
 *         如果不做约束，一个精心构造的路径（../../etc/passwd）就可能让上层
 *         把根目录之外的文件读出来。resolve() 的作用就是把这种路径挡掉。
 *
 * 【与上游 dsh-voice 的差异】
 *   上游用 `@deepseek-ai/dsh-home-paths` 的 resolveDshHome()/expandHomePath()
 *   来定位 `~/.dsh`。本项目没有那套框架，这里用 os.homedir() 自己实现，
 *   并保持相同的行为：`~` 展开、默认目录 `~/.dsh/voice`。
 */
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';

/** 默认音频根目录：~/.dsh/voice。 */
export function defaultAudioDir(): string {
  return join(homedir(), '.dsh', 'voice');
}

/** 展开路径开头的 `~`。 */
export function expandHomePath(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

/**
 * 算出真正生效的音频根目录。
 *
 * @param configured - 配置里指定的目录；空字符串表示用默认
 */
export function resolveAudioDir(configured: string | undefined): string {
  const raw = configured !== undefined && configured !== '' ? configured : defaultAudioDir();
  return expandHomePath(raw);
}

/** 按扩展名判断 MIME 类型。 */
export function mimeForPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.m4a': return 'audio/mp4';
    case '.aiff': case '.aif': return 'audio/aiff';
    case '.wav': return 'audio/wav';
    case '.mp3': return 'audio/mpeg';
    case '.caf': return 'audio/x-caf';
    case '.txt': case '.json': return 'text/plain';
    default: return 'application/octet-stream';
  }
}

/**
 * 音频文件仓库。
 *
 * 【路径约束】所有对外暴露的路径方法都先过 resolve()，它保证结果落在根目录内。
 */
export class AudioStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  /** 仓库根目录。 */
  get rootDir(): string {
    return this.root;
  }

  /** 确保根目录存在（首次写入前调用）。 */
  async ensure(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  /**
   * 把一个路径解析成根目录内的绝对路径。
   *
   * @throws 路径逃出根目录时抛错
   */
  resolve(rel: string): string {
    const candidate = isAbsolute(rel) ? resolve(rel) : resolve(this.root, rel);
    const root = resolve(this.root);
    if (candidate === root || candidate.startsWith(`${root}${sep}`)) return candidate;
    throw new Error(`voice: audio path escapes the audio root: ${rel}`);
  }

  /**
   * 把一个文件提交进根目录。
   *
   * @param srcPath - 源文件路径
   * @param name - 目标文件名（只取 basename，防止 ../ 逃逸）
   */
  async commit(
    srcPath: string,
    name: string,
    extra?: { readonly durationMs?: number },
  ): Promise<{ readonly path: string; readonly mime: string; readonly durationMs?: number }> {
    const safeName = basename(name);
    await this.ensure();
    const dest = join(this.root, safeName);
    await copyFile(srcPath, dest);
    return {
      path: dest,
      mime: mimeForPath(dest),
      ...(extra?.durationMs !== undefined ? { durationMs: extra.durationMs } : {}),
    };
  }

  /** 在根目录下预留一个尚未写入的文件路径。 */
  pathFor(kind: string, ext: string): string {
    return join(this.root, `${kind}.${ext.replace(/^\./, '')}`);
  }

  /** 某个引用指向的文件是否还存在。 */
  async exists(refPath: string): Promise<boolean> {
    try {
      const info = await stat(this.resolve(refPath));
      return info.isFile();
    } catch {
      return false;
    }
  }
}

/** 某个路径是否位于根目录之下。 */
export function isUnderRoot(root: string, candidate: string): boolean {
  const r = resolve(root);
  const c = resolve(candidate);
  return c === r || c.startsWith(`${r}${sep}`);
}

/** 绝对路径转成相对根目录的短路径（用于展示）。 */
export function relOf(root: string, absolute: string): string {
  const r = resolve(root);
  const c = resolve(absolute);
  if (c === r) return '';
  if (c.startsWith(`${r}${sep}`)) return c.slice(r.length + 1);
  return dirname(c) === r ? basename(c) : c;
}
