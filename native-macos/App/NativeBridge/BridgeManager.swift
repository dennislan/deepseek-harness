import Foundation
import WebKit
import UniformTypeIdentifiers
import UserNotifications
import os

/// Receives messages from the WKWebView JS bridge and forwards them to
/// macOS native APIs (file picker, directory picker, notifications, etc.).
class BridgeManager: NSObject, WKScriptMessageHandler {
    weak var webView: WKWebView?

    // MARK: - WKScriptMessageHandler

    func userContentController(_ userContentController: WKUserContentController,
                                didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else {
            logger.debug("无效消息体: \(String(describing: message.body))")
            return
        }

        let type = body["type"] as? String ?? ""
        let id = body["id"] as? String

        switch type {
        case "native:request":
            self.handleNativeRequest(body: body, messageId: id)
        case "native:get-env":
            handleGetEnv(body: body, messageId: id)
        case "native:open-url":
            if let urlStr = body["url"] as? String,
               let url = URL(string: urlStr) {
                NSWorkspace.shared.open(url)
            }
        default:
            logger.debug("未知桥接消息类型: \(type)")
        }
    }

    // MARK: - Handlers

    private func handleNativeRequest(body: [String: Any], messageId: String?) {
        let method = body["method"] as? String ?? ""
        let params = body["params"] as? [String: Any] ?? [:]

        switch method {
        case "directoryPicker":
            presentDirectoryPicker { [weak self] url in
                self?.respond(id: messageId, data: url?.absoluteString)
            }

        case "filePicker":
            let allowMultiple = params["multiple"] as? Bool ?? false
            presentFilePicker(multiple: allowMultiple) { [weak self] urls in
                self?.respond(id: messageId, data: urls.map { $0.absoluteString })
            }

        case "savePanel":
            let defaultName = params["defaultName"] as? String ?? "untitled"
            let initialDirectory = params["initialDirectory"] as? String
            presentSavePanel(defaultName: defaultName, initialDirectory: initialDirectory) { [weak self] url in
                self?.respond(id: messageId, data: url?.absoluteString)
            }

        case "showNotification":
            showNotification(
                title: params["title"] as? String ?? "DeepSeek Harness",
                body: params["body"] as? String ?? "",
                sound: params["sound"] as? Bool ?? true
            )
            respond(id: messageId, data: true)

        case "getDeviceInfo":
            let info: [String: Any] = [
                "platform": "macOS",
                "arch": getArch(),
                "osVersion": ProcessInfo.processInfo.operatingSystemVersionString,
                "hostname": ProcessInfo.processInfo.hostName,
                "homeDirectory": FileManager.default.homeDirectoryForCurrentUser.path
            ]
            respond(id: messageId, data: info)

        case "getEnvironment":
            let key = params["key"] as? String ?? ""
            let value = ProcessInfo.processInfo.environment[key]
            respond(id: messageId, data: value)

        case "alert":
            showAlert(title: params["title"] as? String ?? "提示",
                      message: params["message"] as? String ?? "")
            respond(id: messageId, data: true)

        case "confirm":
            confirmAlert(title: params["title"] as? String ?? "确认",
                         message: params["message"] as? String ?? "") { [weak self] accepted in
                self?.respond(id: messageId, data: accepted)
            }

        case "prompt":
            let message = params["message"] as? String ?? ""
            let defaultVal = params["default"] as? String ?? ""
            handlePrompt(prompt: message, defaultText: defaultVal) { [weak self] result in
                self?.respond(id: messageId, data: result)
            }

        default:
            respond(id: messageId, error: "未知方法: \(method)")
        }
    }

    private func handleGetEnv(body: [String: Any], messageId: String?) {
        let key = body["key"] as? String ?? ""
        let value = ProcessInfo.processInfo.environment[key]
        respond(id: messageId, data: value)
    }

    // MARK: - Response

    func respond(id: String?, data: Any? = nil, error: String? = nil) {
        guard let id = id else { return }
        var payload: [String: Any] = ["id": id, "type": "native:response"]
        if let data = data { payload["data"] = data }
        if let error = error { payload["error"] = error }

        guard let json = try? JSONSerialization.data(withJSONObject: payload),
              let str = String(data: json, encoding: .utf8) else { return }

        let js = "window.__dshHandleNativeResponse(\(str.replacingOccurrences(of: "\n", with: "")))"
        webView?.evaluateJavaScript(js) { _, err in
            if let err = err {
                logger.error("Bridge respond error: \(err.localizedDescription)")
            }
        }
    }

    // MARK: - Native Capabilities

    func presentDirectoryPicker(completion: @escaping (URL?) -> Void) {
        let panel = NSOpenPanel()
        panel.title = "选择目录"
        panel.canCreateDirectories = true
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.directoryURL = FileManager.default.homeDirectoryForCurrentUser
        panel.begin { response in
            completion(response == .OK ? panel.url : nil)
        }
    }

    func presentFilePicker(multiple: Bool, completion: @escaping ([URL]) -> Void) {
        let panel = NSOpenPanel()
        panel.title = "选择文件"
        panel.canCreateDirectories = false
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = multiple
        panel.directoryURL = FileManager.default.homeDirectoryForCurrentUser
        panel.begin { response in
            completion(response == .OK ? panel.urls : [])
        }
    }

    func presentSavePanel(defaultName: String, initialDirectory: String?,
                          completion: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.title = "保存文件"
        panel.nameFieldStringValue = defaultName
        if let dir = initialDirectory, let url = URL(string: dir) {
            panel.directoryURL = url
        } else {
            panel.directoryURL = FileManager.default.homeDirectoryForCurrentUser
        }
        panel.begin { response in
            completion(response == .OK ? panel.url : nil)
        }
    }

    func showNotification(title: String, body: String, sound: Bool) {
        let center = UNUserNotificationCenter.current()
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        if sound {
            content.sound = .default
        }
        let request = UNNotificationRequest(identifier: UUID().uuidString,
                                            content: content,
                                            trigger: nil)
        center.add(request)
    }

    func showAlert(title: String, message: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.alertStyle = .informational
        alert.addButton(withTitle: "确定")
        alert.runModal()
    }

    // WKUIDelegate 回调入口：JS window.alert()
    func handleAlert(message: String, completion: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = "JavaScript 提示"
        alert.informativeText = message
        alert.alertStyle = .informational
        alert.addButton(withTitle: "确定")
        alert.runModal()
        completion()
    }

    // WKUIDelegate 回调入口：JS window.confirm()
    func handleConfirm(message: String, completion: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = "确认"
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.addButton(withTitle: "确定")
        alert.addButton(withTitle: "取消")
        let response = alert.runModal()
        completion(response == .alertFirstButtonReturn)
    }

    // WKUIDelegate 回调入口：JS window.prompt()
    func handlePrompt(prompt: String, defaultText: String, completion: @escaping (String?) -> Void) {
        let alert = NSAlert()
        alert.messageText = "输入"
        alert.informativeText = prompt
        alert.alertStyle = .informational
        let textInput = NSTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 24))
        textInput.stringValue = defaultText
        textInput.bezelStyle = .roundedBezel
        alert.accessoryView = textInput
        alert.addButton(withTitle: "确定")
        alert.addButton(withTitle: "取消")
        let response = alert.runModal()
        if response == .alertFirstButtonReturn {
            completion(textInput.stringValue.isEmpty ? nil : textInput.stringValue)
        } else {
            completion(nil)
        }
    }

    func confirmAlert(title: String, message: String, completion: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.addButton(withTitle: "确定")
        alert.addButton(withTitle: "取消")
        let response = alert.runModal()
        completion(response == .alertFirstButtonReturn)
    }
}

// MARK: - Helpers

private func getArch() -> String {
    var size: size_t = 0
    sysctlbyname("hw.machine", nil, &size, nil, 0)
    var machine = [CChar](repeating: 0, count: Int(size))
    sysctlbyname("hw.machine", &machine, &size, nil, 0)
    let arch = String(cString: machine)
    return arch == "arm64" ? "arm64" : "x86_64"
}

// MARK: - Logger

private let logger = os.Logger(subsystem: "com.deepseek.harness", category: "bridge")
