/**
 * voice/selfcheck.ts —— 语音模块自检。
 *
 * 【为什么需要它】语音工具涉及系统命令、系统权限、Swift shim，任何一环没配好
 *   都会在真正用的时候才炸。这个脚本在开发阶段就能看出"哪里没就绪"。
 *
 * 【三层检查】
 *   1. 纯逻辑层：后端选择、路径守卫、fake 后端闭环 —— 不碰系统，可离线跑。
 *   2. 系统能力层：探测 say / swift / ffmpeg / whisper 是否就位。
 *   3. 真实链路层：真的合成一段语音（可选，需要 --speak）。
 *
 * 【用法】
 *   npx tsx src/voice/selfcheck.ts          # 前两层
 *   npx tsx src/voice/selfcheck.ts --speak  # 加上真实合成
 *
 * 【为什么用 async main 而不是顶层 await】
 *   项目里没有 package.json 声明 "type": "module"，tsx 会按 CommonJS 加载，
 *   而顶层 await 在 CJS 下不支持。包一层 async main 让脚本在两种模块格式下
 *   都能跑，不需要为此新增 package.json。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AudioStore } from './audio.js';
import { FakeSttBackend, FakeTtsBackend, SayTtsBackend } from './backends/index.js';
import { probeBackends } from './probe.js';
import { selectSttBackend, selectTtsBackend } from './selection.js';
import { shellRun } from './shell.js';
import { speak, transcribe } from './tools.js';
import { resolveConfig } from './types.js';

const ROOT = process.cwd();
const BUNDLE = join(ROOT, 'voice', 'build', 'VoiceSTT.app');
const RECORD_BIN = join(ROOT, 'voice', 'build', 'macos-record');

let failures = 0;

function ok(label: string, detail = ''): void {
  console.log(`  ✓ ${label}${detail !== '' ? ` — ${detail}` : ''}`);
}

function bad(label: string, detail = ''): void {
  failures += 1;
  console.log(`  ✗ ${label}${detail !== '' ? ` — ${detail}` : ''}`);
}

function section(title: string): void {
  console.log(`\n${title}`);
}

/**
 * 可选组件的检查。
 *
 * 【为什么可选组件不算失败】whisper.cpp / piper / edge-tts 都是**可选**的：
 * 装了能用离线神经模型，不装照样能用 macos 内置后端。把"没装可选组件"报成
 * 失败会掩盖真正的问题（必需要件没就绪时才是失败）。
 */
function optional(label: string, available: boolean, hint: string): void {
  if (available) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  · ${label} — 未安装（可选）${hint !== '' ? `；${hint}` : ''}`);
  }
}

async function main(): Promise<void> {
  // ---- 1. 纯逻辑层 -----------------------------------------------------
  section('1. 纯逻辑层');

  // 后端选择：钉死就选钉死的。
  {
    const config = resolveConfig({ stt: { backend: 'macos' }, tts: { backend: 'say' } });
    const probes = probeBackends(config, BUNDLE);
    const stt = selectSttBackend(config.stt, probes);
    const tts = selectTtsBackend(config.tts, probes);
    stt.kind === 'ok' && stt.id === 'macos' ? ok('STT 选择：钉死的 macos 生效') : bad('STT 选择', JSON.stringify(stt));
    tts.kind === 'ok' && tts.id === 'say' ? ok('TTS 选择：钉死的 say 生效') : bad('TTS 选择', JSON.stringify(tts));
  }

  // 自动选择：云端绝不能被自动选中。
  {
    const probes = probeBackends(resolveConfig(undefined), BUNDLE);
    const stt = selectSttBackend({}, probes);
    const tts = selectTtsBackend({}, probes);
    const sttId = stt.kind === 'ok' ? stt.id : 'none';
    const ttsId = tts.kind === 'ok' ? tts.id : 'none';
    sttId !== 'openai' ? ok('自动 STT 不选云端', `实际=${sttId}`) : bad('自动 STT 选中了云端');
    ttsId !== 'edge-tts' ? ok('自动 TTS 不选云端', `实际=${ttsId}`) : bad('自动 TTS 选中了云端');
  }

  // 路径守卫：越界的路径必须被挡掉。
  {
    const store = new AudioStore('/tmp/voice-selftest-root');
    let blocked = false;
    try {
      store.resolve('../../etc/passwd');
    } catch {
      blocked = true;
    }
    blocked ? ok('路径守卫挡住了 ../ 逃逸') : bad('路径守卫失效');
  }

  // fake 后端闭环：speak 的产物能被 transcribe 读回来。
  {
    const store = new AudioStore('/tmp/voice-selftest-root');
    await store.ensure();
    const out = await speak(
      { tts: new FakeTtsBackend(), audioPath: () => store.pathFor('roundtrip', 'json') },
      { text: '邮件已处理完毕' },
    );
    const back = await transcribe(
      {
        stt: new FakeSttBackend(),
        record: async () => { throw new Error('不该被调用'); },
        commit: async (file, name) => store.commit(file, name),
      },
      { source: { file: out.audioRef.path } },
    );
    back.transcript === '邮件已处理完毕'
      ? ok('fake 闭环：speak → transcribe 原文返回')
      : bad('fake 闭环', `得到 "${back.transcript}"`);
  }

  // ---- 2. 系统能力层 ---------------------------------------------------
  section('2. 系统能力层');

  const config = resolveConfig(undefined);
  const probes = probeBackends(config, BUNDLE);

  probes.say ? ok('say 可用（macOS 内置 TTS）') : bad('say 不可用', 'macOS 自带，一般不会缺');
  probes.macos ? ok('swift 运行时可用') : bad('swift 不可用');
  probes.mic ? ok('麦克风录音路径可用') : bad('麦克风录音路径不可用', '需要 ffmpeg 或 swift shim');
  probes.macosSttBundle
    ? ok('语音识别 bundle 已构建')
    : bad('语音识别 bundle 未构建', '跑 ./voice/build.sh');

  optional('whisper.cpp 可用（离线 STT）', probes.whisperLocal, '不装也能用 macos 后端');
  optional('piper 可用（离线神经 TTS）', probes.piper, '不装也能用 say 后端');
  optional('edge-tts 可用（云端 TTS）', probes.edgeTts, '云端后端永不自动选中');

  existsSync(RECORD_BIN) ? ok('录音 shim 已构建') : bad('录音 shim 未构建', '跑 ./voice/build.sh');

  // ---- 3. 真实链路层 ---------------------------------------------------
  section('3. 真实链路层');

  if (process.argv.includes('--speak')) {
    if (!probes.say) {
      bad('跳过真实合成', 'say 不可用');
    } else {
      const store = new AudioStore('/tmp/voice-selftest-root');
      await store.ensure();
      try {
        const out = await speak(
          { tts: new SayTtsBackend(shellRun), audioPath: () => store.pathFor('selftest', 'm4a') },
          { text: '语音工具自检通过' },
        );
        existsSync(out.audioRef.path)
          ? ok('say 真实合成成功', out.audioRef.path)
          : bad('say 合成没有产出文件');
      } catch (error) {
        bad('say 真实合成失败', error instanceof Error ? error.message : String(error));
      }
    }
  } else {
    console.log('  · 真实合成已跳过（加 --speak 开启）');
  }

  // ---- 汇总 -------------------------------------------------------------
  console.log('');
  if (failures === 0) {
    console.log('✓ 全部检查通过');
  } else {
    console.log(`✗ ${failures} 项检查未通过`);
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error('自检脚本异常:', error);
  process.exit(1);
});
