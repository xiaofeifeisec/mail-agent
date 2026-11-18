#!/usr/bin/env swift
// macos-record.swift —— 麦克风录音 shim。
//
// 从默认麦克风录 `seconds` 秒（默认 5）到指定路径的 AAC .m4a 文件。
//
// 【与上游 dsh-voice 的差异 —— 上游这个文件在 macOS 上编译不过】
//   上游用了 AVAudioSession。那是 iOS 专有 API，macOS 的 SDK 里根本没有，
//   编译直接报 "error: 'AVAudioSession' is unavailable in macOS"。
//   （上游作者把 iOS 的录音代码直接搬了过来。）
//   macOS 上对应的做法是直接用 AVAudioRecorder —— 它在 macOS 10.7+ 就有了，
//   不需要 session 分类设置。真正需要 TCC 授权的是麦克风本身，那部分由宿主
//   进程（终端 / IDE）负责申请。
//
// 用法: swift macos-record.swift <out-file.m4a> [seconds]

import Foundation
import AVFoundation

let args = CommandLine.arguments
guard args.count >= 2 else {
    FileHandle.standardError.write("usage: macos-record <out-file> [seconds]\n".data(using: .utf8)!)
    exit(2)
}

let outPath = args[1]
let seconds = args.count >= 3 ? (Double(args[2]) ?? 5.0) : 5.0
let url = URL(fileURLWithPath: outPath)

// 父目录可能不存在，先建好，省得调用方操心。
let parent = url.deletingLastPathComponent()
try? FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)

let settings: [String: Any] = [
    AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
    AVSampleRateKey: 44100,
    AVNumberOfChannelsKey: 1,
    AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
]

guard let recorder = try? AVAudioRecorder(url: url, settings: settings) else {
    FileHandle.standardError.write("record: cannot create recorder\n".data(using: .utf8)!)
    exit(1)
}

recorder.record(forDuration: seconds)
// record(forDuration:) 只是排了个定时停止，录音回调要靠 run loop 才会被投递。
RunLoop.main.run(until: Date().addingTimeInterval(seconds + 0.5))
recorder.stop()

print(outPath)
