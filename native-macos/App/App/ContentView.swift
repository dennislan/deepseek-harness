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
            // 标题栏独立占位:不与 WebView 重叠,网页内容不会被遮挡
            TitleBar()
                .frame(height: titleBarHeight)
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

private let titleBarHeight: CGFloat = 8

private struct TitleBar: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView { TitleBarView() }
    func updateNSView(_ nsView: NSView, context: Context) {
        // 强制固定高度:SwiftUI 的 frame 修饰符对 NSViewRepresentable 的
        // 约束在部分 macOS 版本上不可靠,直接设置 NSView frame 兜底。
        nsView.frame.size.height = titleBarHeight
    }
}

private final class TitleBarView: NSView {
    override var intrinsicContentSize: NSSize {
        NSSize(width: NSView.noIntrinsicMetric, height: titleBarHeight)
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        window?.isMovableByWindowBackground = true
    }

    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 {
            window?.performZoom(nil)
        } else {
            super.mouseDown(with: event)
        }
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        self
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)

        // 底部 1pt 分隔线,提示拖动区域边界
        NSColor.separatorColor.setFill()
        NSRect(x: 0, y: 0, width: bounds.width, height: 1).fill()
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
