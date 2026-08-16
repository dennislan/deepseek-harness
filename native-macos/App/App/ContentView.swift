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
        ZStack {
            if isReady, let url = displayURL {
                WebViewContainer(url: url, bridge: bridge)
                    .ignoresSafeArea()
            } else {
                VStack(spacing: 16) {
                    // 深色模式显示浅色 logo（LogoLight），浅色模式显示深色 logo（LogoDark）
                    Image(colorScheme == .dark ? "LogoLight" : "LogoDark")
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .frame(width: 128, height: 128)
                    Text("DeepSeek Harness")
                        .font(.title2)
                        .fontWeight(.semibold)
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
        .background(BackgroundRepresentable())
        .overlay(alignment: .top) {
            TitleBarRepresentable()
                .frame(height: 28)
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
}

/// 背景层：保持默认 mouseDownCanMoveWindow = false，
/// 窗口背景区域不可拖动，仅标题栏视图可拖动。
private final class BackgroundView: NSView {}

private struct BackgroundRepresentable: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView { BackgroundView() }
    func updateNSView(_ nsView: NSView, context: Context) {}
}

/// 标准高度标题栏视图：仅该区域允许拖动窗口。
/// hiddenTitleBar 窗口无系统拖拽区，重写 mouseDownCanMoveWindow = true
/// 使此独立 NSView 独占拖拽能力；位于 WebView 之上的 overlay，
/// 不被 WKWebView 吞掉 mouseDown。
private final class TitleBarView: NSView {
    override var mouseDownCanMoveWindow: Bool { true }
}

private struct TitleBarRepresentable: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView { TitleBarView() }
    func updateNSView(_ nsView: NSView, context: Context) {}
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

    func makeCoordinator() -> Coordinator { Coordinator() }

    class Coordinator: NSObject, WKNavigationDelegate {
        func webView(_ webView: WKWebView, decidePolicyFor navAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            if let url = navAction.request.url, url.scheme != "http", url.scheme != "https" {
                NSWorkspace.shared.open(url)
                decisionHandler(.cancel)
            } else {
                decisionHandler(.allow)
            }
        }
        func webView(_ webView: WKWebView, didFail nav: WKNavigation!, withError error: Error) {
            NSLog("[DSH] WebView error: \(error.localizedDescription)")
        }
        func webView(_ webView: WKWebView, didFinish nav: WKNavigation!) {
            NSLog("[DSH] Page loaded: \(webView.url?.absoluteString ?? "?")")
        }
    }
}
