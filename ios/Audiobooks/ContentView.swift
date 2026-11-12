import SwiftUI

/// Адрес сервера по умолчанию. В симуляторе localhost — это ваш Mac.
/// Для настоящего телефона укажите адрес развёрнутого сервера (https://...).
let defaultServerURL = "http://localhost:3000"

struct ContentView: View {
    @AppStorage("serverURL") private var serverURL = defaultServerURL
    @State private var loadError: String?
    @State private var showSettings = false
    @State private var reloadToken = 0

    private var url: URL? {
        guard let url = URL(string: serverURL.trimmingCharacters(in: .whitespaces)),
              let scheme = url.scheme, ["http", "https"].contains(scheme), url.host != nil
        else { return nil }
        return url
    }

    var body: some View {
        ZStack {
            Theme.surface.ignoresSafeArea()

            if let url {
                WebView(
                    url: url,
                    reloadToken: reloadToken,
                    onLoaded: { loadError = nil },
                    onError: { loadError = $0 },
                    onSettings: { showSettings = true }
                )
                .opacity(loadError == nil ? 1 : 0)
            }

            if url == nil || loadError != nil {
                ConnectionErrorView(
                    address: serverURL,
                    message: url == nil ? "Адрес сервера указан неверно." : loadError ?? "",
                    retry: { loadError = nil; reloadToken += 1 },
                    changeServer: { showSettings = true }
                )
            }
        }
        .tint(Theme.accent)
        .sheet(isPresented: $showSettings) {
            ServerSettingsView(serverURL: $serverURL) {
                loadError = nil
                reloadToken += 1
            }
        }
    }
}

/// Цвета совпадают с веб-интерфейсом (public/style.css) в светлой и тёмной теме.
enum Theme {
    static let surface = dynamic(light: 0xFFFFFF, dark: 0x22201D)
    static let accent = dynamic(light: 0xB4522B, dark: 0xE08A5F)

    private static func dynamic(light: Int, dark: Int) -> Color {
        Color(UIColor { traits in
            let hex = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(
                red: CGFloat((hex >> 16) & 0xFF) / 255,
                green: CGFloat((hex >> 8) & 0xFF) / 255,
                blue: CGFloat(hex & 0xFF) / 255,
                alpha: 1
            )
        })
    }
}

struct ConnectionErrorView: View {
    let address: String
    let message: String
    let retry: () -> Void
    let changeServer: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "wifi.exclamationmark")
                .font(.system(size: 44))
                .foregroundStyle(.secondary)
            Text("Нет связи с сервером")
                .font(.title3.bold())
            Text(address)
                .font(.footnote.monospaced())
                .foregroundStyle(.secondary)
            if !message.isEmpty {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            Button("Повторить", action: retry)
                .buttonStyle(.borderedProminent)
            Button("Изменить адрес сервера", action: changeServer)
        }
        .padding(32)
    }
}

struct ServerSettingsView: View {
    @Binding var serverURL: String
    let onSave: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var draft = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://books.example.com", text: $draft)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("Адрес сервера")
                } footer: {
                    Text("Адрес, по которому запущен сервер приложения (node server.js). В симуляторе подойдёт http://localhost:3000, на телефоне нужен адрес, доступный из сети.")
                }
                Section {
                    Button("Вернуть адрес по умолчанию") { draft = defaultServerURL }
                }
            }
            .navigationTitle("Сервер")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Отмена") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Сохранить") {
                        serverURL = draft.trimmingCharacters(in: .whitespaces)
                        onSave()
                        dismiss()
                    }
                }
            }
            .onAppear { draft = serverURL }
        }
    }
}
