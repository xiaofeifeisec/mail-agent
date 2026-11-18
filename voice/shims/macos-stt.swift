#!/usr/bin/env swift
// macos-stt.swift —— 语音识别 shim（macOS SFSpeechRecognizer）。
//
// 把一个音频文件转写成文本，结果写到指定输出文件。
//
// 【与上游 dsh-voice 的差异 —— 上游这个文件在 macOS 上会崩】
//   1. 上游是普通命令行二进制。macOS 的 TCC（隐私授权）规定：访问语音识别的
//      进程必须在 Info.plist 里声明 NSSpeechRecognitionUsageDescription。命令行
//      二进制没有 Info.plist，直接跑会被系统 SIGABRT 杀掉（崩溃报告里写的是
//      "attempted to access privacy-sensitive data without a usage description"）。
//      所以这个 shim 必须被打成 .app bundle，由 host 通过 LaunchServices 启动。
//   2. LaunchServices 启动的进程拿不到 argv 和环境变量，所以参数走 bundle 内
//      一个固定的 job 文件：<bundle>/Contents/Resources/job.json。
//
// 用法: swift macos-stt.swift [job-json]
// job-json: {"input": "<音频路径>", "output": "<结果文本路径>"}

import Foundation
import Speech

struct Job: Codable {
    var input: String
    var output: String
}

/// 定位 job 文件：argv[1] → 环境变量 → bundle 内固定位置。
func resolveJobPath() -> String {
    if CommandLine.arguments.count >= 2 {
        return CommandLine.arguments[1]
    }
    if let fromEnv = ProcessInfo.processInfo.environment["VOICE_STT_JOB"] {
        return fromEnv
    }
    // 可执行文件路径形如 <X>.app/Contents/MacOS/VoiceSTT，向上三级到 .app 根。
    let exe = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
    let bundleRoot = exe.deletingLastPathComponent()   // .../Contents/MacOS
        .deletingLastPathComponent()                   // .../Contents
        .deletingLastPathComponent()                   // .../VoiceSTT.app
    return bundleRoot.appendingPathComponent("Contents/Resources/job.json").path
}

let jobPath = resolveJobPath()

func write(_ text: String, to path: String) {
    if let data = text.data(using: .utf8) {
        try? data.write(to: URL(fileURLWithPath: path))
    }
}

guard let raw = try? Data(contentsOf: URL(fileURLWithPath: jobPath)) else {
    FileHandle.standardError.write("cannot read job file: \(jobPath)\n".data(using: .utf8)!)
    exit(2)
}
guard let job = try? JSONDecoder().decode(Job.self, from: raw) else {
    FileHandle.standardError.write("cannot parse job file: \(jobPath)\n".data(using: .utf8)!)
    exit(2)
}
guard FileManager.default.fileExists(atPath: job.input) else {
    let message = "input audio not found: \(job.input)"
    write("FAIL: " + message, to: job.output)
    FileHandle.standardError.write(("FAIL: " + message + "\n").data(using: .utf8)!)
    exit(1)
}

// 识别是异步回调，用信号量把回调同步化，避免主线程提前退出。
let semaphore = DispatchSemaphore(value: 0)
var transcript = ""
var failure: String?

SFSpeechRecognizer.requestAuthorization { status in
    switch status {
    case .authorized:
        break
    case .denied:
        failure = "speech recognition denied — grant 语音识别 permission in 系统设置 › 隐私与安全性 › 语音识别"
        semaphore.signal()
        return
    case .restricted:
        failure = "speech recognition restricted on this machine"
        semaphore.signal()
        return
    case .notDetermined:
        failure = "speech recognition authorization was never resolved"
        semaphore.signal()
        return
    @unknown default:
        failure = "unknown authorization status \(status.rawValue)"
        semaphore.signal()
        return
    }

    guard let recognizer = SFSpeechRecognizer(), recognizer.isAvailable else {
        failure = "no speech recognizer available on this machine"
        semaphore.signal()
        return
    }

    let request = SFSpeechURLRecognitionRequest(url: URL(fileURLWithPath: job.input))
    request.shouldReportPartialResults = false
    // 关掉自动标点：短指令场景下它常把结果改得面目全非。
    request.addsPunctuation = false

    recognizer.recognitionTask(with: request) { result, error in
        if let error = error {
            failure = "recognition failed: \(error.localizedDescription)"
            semaphore.signal()
            return
        }
        if let result = result, result.isFinal {
            transcript = result.bestTranscription.formattedString
            semaphore.signal()
        }
    }
}

semaphore.wait()

if let failure = failure {
    // 失败信息也写进输出文件 —— host 是通过 LaunchServices 启动的，拿不到 stderr。
    write("FAIL: " + failure, to: job.output)
    FileHandle.standardError.write(("FAIL: " + failure + "\n").data(using: .utf8)!)
    exit(1)
}

write(transcript, to: job.output)
