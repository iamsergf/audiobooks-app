import SwiftUI
import WebKit

/// Показывает веб-интерфейс приложения с сервера.
/// Cookie (покупки) и localStorage (прогресс прослушивания) сохраняются между запусками.
struct WebView: UIViewRepresentable {
    let url: URL
    let reloadToken: Int
    let onLoaded: () -> Void
    let onError: (String) -> Void
    let onSettings: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        // Страница вызывает window.webkit.messageHandlers.native.postMessage("settings").
        config.userContentController.add(context.coordinator, name: "native")

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.parent = self
        let key = "\(url.absoluteString)#\(reloadToken)"
        guard context.coordinator.loadedKey != key else { return }
        context.coordinator.loadedKey = key
        webView.load(URLRequest(url: url, timeoutInterval: 20))
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        var parent: WebView
        var loadedKey: String?

        init(_ parent: WebView) { self.parent = parent }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            parent.onLoaded()
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            report(error)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            report(error)
        }

        private func report(_ error: Error) {
            // -999: переход отменён (например, начата новая загрузка) — не ошибка.
            guard (error as NSError).code != NSURLErrorCancelled else { return }
            parent.onError(error.localizedDescription)
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            if message.body as? String == "settings" { parent.onSettings() }
        }

        // alert() со страницы.
        func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
            guard let presenter = webView.window?.rootViewController else { return completionHandler() }
            (presenter.presentedViewController ?? presenter).present(alert, animated: true)
        }
    }
}
