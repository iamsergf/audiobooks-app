import AVFoundation
import SwiftUI

@main
struct AudiobooksApp: App {
    init() {
        // Категория .playback: звук идёт при выключенном звонке и продолжается
        // на заблокированном экране (вместе с UIBackgroundModes = audio в Info.plist).
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .spokenAudio)
        try? session.setActive(true)
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
