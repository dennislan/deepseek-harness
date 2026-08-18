import SwiftUI
import WebKit

struct ContentView: View {
    let server: DshServer
    let bridge: BridgeManager
    @Environment(\.colorScheme) private var colorScheme
    @State private var displayURL: URL?
    @State private var isReady = false
    @State private var statusText: String = "Loading..."
    @State private var statusObserver: NSObjectProtocol?
    @State private var urlObserver: NSObjectProtocol?

    var body: some View {
        VStack(spacing: 0) {
            content
        }
        .onAppear {
            // Listen for status changes
            statusObserver = NotificationCenter.default.addObserver(
                forName: DshServer.statusChanged,
                object: nil,
                queue: .main
            ) { _ in
                Task { @MainActor in
                    let s = await server.status
                    statusText = await server.statusText
                    if s == .running {
                        let u = await server.url
                        displayURL = u
                        isReady = (u != nil)
                    } else if case .failed = s {
                        // Keep showing the error in statusText
                        isReady = false
                    }
                }
            }
            // Listen for URL changes (more direct)
            urlObserver = NotificationCenter.default.addObserver(
                forName: DshServer.urlChanged,
                object: nil,
                queue: .main
            ) { _ in
                Task { @MainActor in
                    let u = await server.url
                    displayURL = u
                    isReady = (u != nil)
                }
            }
        }
        .onDisappear {
            if let statusObserver {
                NotificationCenter.default.removeObserver(statusObserver)
            }
            if let urlObserver {
                NotificationCenter.default.removeObserver(urlObserver)
            }
            statusObserver = nil
            urlObserver = nil
        }
    }

    /// 内容区:服务就绪后显示 WebView,否则显示加载状态。
    @ViewBuilder
    private var content: some View {
        if isReady, let url = displayURL {
            WebViewContainer(url: url, bridge: bridge)
        } else {
            VStack(spacing: 16) {
                // 深色模式显示浅色 logo（LogoLight），浅色模式显示深色 logo（LogoDark）
                Image(colorScheme == .dark ? "LogoLight" : "LogoDark")
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(width: 128, height: 128)
                // Text("DeepSeek Harness")
                //     .font(.title2)
                //     .fontWeight(.semibold)
                ProgressView()
                    .scaleEffect(0.8)
                Text(statusText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

struct WebViewContainer: NSViewRepresentable {
    let url: URL
    let bridge: BridgeManager

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.userContentController.add(bridge, name: "nativeBridge")
        let prefs = WKWebpagePreferences()
        prefs.allowsContentJavaScript = true
        config.defaultWebpagePreferences = prefs
        config.preferences.javaScriptCanOpenWindowsAutomatically = true
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        // createWebViewWithConfiguration（target="_blank" / window.open 等）属于 WKUIDelegate，
        // 不设置则外部新窗口链接不会触发，导致点击无反应。
        webView.uiDelegate = context.coordinator
        bridge.webView = webView

        let bridgeJS = """
            (function() {
                window.__DSH_NATIVE_REQUESTS = window.__DSH_NATIVE_REQUESTS || {};
                window.nativeBridge = {
                    request: function(method, params) {
                        return new Promise(function(resolve, reject) {
                            var id = 'dsh_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
                            window.__DSH_NATIVE_REQUESTS[id] = { resolve: resolve, reject: reject };
                            window.webkit.messageHandlers.nativeBridge.postMessage({
                                type: 'native:request', id: id, method: method, params: params || {}
                            });
                        });
                    },
                    callSync: function(method, params) {
                        window.webkit.messageHandlers.nativeBridge.postMessage({
                            type: 'native:request', id: null, method: method, params: params || {}
                        });
                        return true;
                    }
                };
                window.__dshHandleNativeResponse = function(msg) {
                    if (msg.id && window.__DSH_NATIVE_REQUESTS[msg.id]) {
                        var req = window.__DSH_NATIVE_REQUESTS[msg.id];
                        delete window.__DSH_NATIVE_REQUESTS[msg.id];
                        if (msg.error) req.reject(new Error(msg.error));
                        else req.resolve(msg.data);
                    }
                };
                console.log('[DSH] Native bridge injected');
            })();
        """
        config.userContentController.addUserScript(
            WKUserScript(source: bridgeJS, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )
        return webView
    }

    func updateNSView(_ nsView: WKWebView, context: Context) {
        if nsView.url?.absoluteString != url.absoluteString {
            nsView.load(URLRequest(url: url))
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(bridge: bridge) }

    class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        private let bridge: BridgeManager

        init(bridge: BridgeManager) {
            self.bridge = bridge
        }

        // 指向应用外站点（非 localhost）的链接在系统浏览器打开，
        // 避免应用内 harness UI 被外部页面顶替。
        private func isExternal(_ url: URL) -> Bool {
            guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return false }
            guard let host = url.host?.lowercased() else { return false }
            return host != "localhost" && host != "127.0.0.1" && host != "::1" && !host.hasSuffix(".localhost")
        }

        func webView(_ webView: WKWebView, decidePolicyFor navAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = navAction.request.url else { decisionHandler(.allow); return }
            let scheme = url.scheme?.lowercased() ?? ""
            // 非 http/https（mailto:、file: 等）交给系统处理
            if scheme != "http" && scheme != "https" {
                NSWorkspace.shared.open(url)
                decisionHandler(.cancel)
                return
            }
            // 外部链接（非 localhost）统一在系统默认浏览器打开，避免顶替应用内 harness UI。
            // 不限 navigationType：覆盖点击、程序化跳转与 window.open 等触发方式。
            if isExternal(url) {
                NSWorkspace.shared.open(url)
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }

        // target="_blank" 等新窗口链接：无内嵌窗口，转交系统浏览器打开
        func webView(_ webView: WKWebView,
                     createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction,
                     windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = navigationAction.request.url {
                NSWorkspace.shared.open(url)
            }
            return nil
        }

        func webView(_ webView: WKWebView, didFail nav: WKNavigation!, withError error: Error) {
            NSLog("[DSH] WebView error: \(error.localizedDescription)")
        }
        func webView(_ webView: WKWebView, didFinish nav: WKNavigation!) {
            NSLog("[DSH] Page loaded: \(webView.url?.absoluteString ?? "?")")
        }

        // JS window.alert() → macOS NSAlert
        func webView(_ webView: WKWebView,
                     runJavaScriptAlertPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo,
                     completionHandler: @escaping () -> Void) {
            bridge.handleAlert(message: message, completion: completionHandler)
        }

        // JS window.confirm() → macOS NSAlert with OK/Cancel
        func webView(_ webView: WKWebView,
                     runJavaScriptConfirmPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo,
                     completionHandler: @escaping (Bool) -> Void) {
            bridge.handleConfirm(message: message, completion: completionHandler)
        }

        // JS window.prompt() → macOS NSAlert with text input
        func webView(_ webView: WKWebView,
                     runJavaScriptTextInputPanelWithPrompt prompt: String,
                     defaultText: String?,
                     initiatedByFrame frame: WKFrameInfo,
                     completionHandler: @escaping (String?) -> Void) {
            bridge.handlePrompt(prompt: prompt, defaultText: defaultText ?? "", completion: completionHandler)
        }
    }
}
