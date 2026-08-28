import AppKit
import Darwin
import Foundation

let operation = CommandLine.arguments.dropFirst().first ?? ""
guard ["status", "configure", "read", "clear"].contains(operation), CommandLine.arguments.count == 2 else { exit(64) }

let protocolVersion = 1
let legacyFileName = "lovart-credentials-v1.json"
let profileDirectory = "provider-credentials-v1"

func emit(_ value: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(value), let data = try? JSONSerialization.data(withJSONObject: value) else { exit(1) }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
}

func failure(_ code: String, exitCode: Int32 = 1) -> Never {
    emit(["v": protocolVersion, "type": "result", "status": "setup_required", "code": code])
    exit(exitCode)
}

func readJSONLine() -> [String: Any]? {
    guard let line = readLine(), !line.isEmpty, line.utf8.count <= 16 * 1024,
          let data = line.data(using: .utf8), let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    return value
}

func matches(_ value: String, _ pattern: String) -> Bool {
    value.range(of: pattern, options: .regularExpression) != nil
}

struct CredentialField {
    let id: String
    let label: String
    let required: Bool
}

func parseFields(_ value: Any?) -> [CredentialField]? {
    guard let raw = value as? [[String: Any]], !raw.isEmpty, raw.count <= 32 else { return nil }
    var seen = Set<String>()
    var fields: [CredentialField] = []
    for item in raw {
        guard Set(item.keys).isSubset(of: ["id", "label", "secret", "required"]),
              let id = item["id"] as? String, matches(id, "^[a-z][a-z0-9._-]{0,63}$"), !seen.contains(id),
              let label = item["label"] as? String, !label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, label.utf8.count <= 128,
              item["secret"] is Bool, let required = item["required"] as? Bool else { return nil }
        seen.insert(id)
        fields.append(CredentialField(id: id, label: label.trimmingCharacters(in: .whitespacesAndNewlines), required: required))
    }
    return fields
}

guard let request = readJSONLine(), request["v"] as? Int == protocolVersion,
      request["type"] as? String == "request", request["op"] as? String == operation else { failure("UPSTREAM_SECURITY_REJECTED") }

let profileId = request["profile_id"] as? String
let rawFields = request["fields"]
guard (profileId == nil && rawFields == nil) || (profileId != nil && matches(profileId!, "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$") && profileId != "." && profileId != "..") else {
    failure("UPSTREAM_SECURITY_REJECTED")
}
let parsedFields = rawFields == nil ? nil : parseFields(rawFields)
guard rawFields == nil || parsedFields != nil, operation != "configure" || profileId == nil || parsedFields != nil else {
    failure("UPSTREAM_SECURITY_REJECTED")
}
let legacy = profileId == nil
let fields = parsedFields ?? [
    CredentialField(id: "access_key", label: "Access Key", required: true),
    CredentialField(id: "secret_key", label: "Secret Key", required: true),
]

func dataDirectoryURL() -> URL? {
    let environment = ProcessInfo.processInfo.environment
    if let directory = environment["IMVIA_DATA_DIR"], (directory as NSString).isAbsolutePath { return URL(fileURLWithPath: directory, isDirectory: true) }
    guard let home = environment["HOME"] else { return nil }
    return URL(fileURLWithPath: home).appendingPathComponent("IMVIA Studio", isDirectory: true)
}

func credentialURL() -> URL? {
    guard let base = dataDirectoryURL() else { return nil }
    if let profileId { return base.appendingPathComponent(profileDirectory, isDirectory: true).appendingPathComponent("\(profileId).json") }
    return base.appendingPathComponent(legacyFileName)
}

func readValues() -> [String: String]? {
    guard let url = credentialURL(), let data = try? Data(contentsOf: url),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    let source: [String: Any]
    if legacy { source = object } else { guard let values = object["values"] as? [String: Any] else { return nil }; source = values }
    var output: [String: String] = [:]
    for (key, value) in source {
        guard matches(key, "^[a-z][a-z0-9._-]{0,63}$"), let string = value as? String else { return nil }
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        output[key] = trimmed
    }
    if legacy && (output["access_key"] == nil || output["secret_key"] == nil) { return nil }
    return output.isEmpty ? nil : output
}

func writeValues(_ values: [String: String]) {
    guard let url = credentialURL() else { failure("CREDENTIAL_STORE_DENIED") }
    do {
        let directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: NSNumber(value: 0o700)])
        try FileManager.default.setAttributes([.posixPermissions: NSNumber(value: 0o700)], ofItemAtPath: directory.path)
        let object: [String: Any] = legacy ? values : ["values": values]
        let data = try JSONSerialization.data(withJSONObject: object)
        let temporary = directory.appendingPathComponent(".\(url.lastPathComponent).\(UUID().uuidString).tmp")
        let fileDescriptor = Darwin.open(temporary.path, O_WRONLY | O_CREAT | O_EXCL, S_IRUSR | S_IWUSR)
        guard fileDescriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        var replaced = false
        defer { if !replaced { try? FileManager.default.removeItem(at: temporary) } }
        let handle = FileHandle(fileDescriptor: fileDescriptor, closeOnDealloc: true)
        do {
            try handle.write(contentsOf: data)
            try handle.synchronize()
            try handle.close()
        } catch {
            try? handle.close()
            throw error
        }
        guard Darwin.rename(temporary.path, url.path) == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        replaced = true
    } catch { failure("CREDENTIAL_STORE_DENIED") }
}

if operation == "status" {
    let connected = readValues() != nil
    emit(["v": protocolVersion, "type": "result", "status": connected ? "connected" : "setup_required", "code": connected ? "CONNECTED" : "SETUP_REQUIRED"])
    exit(0)
}

if operation == "read" {
    guard let values = readValues() else { failure("SETUP_REQUIRED") }
    if legacy {
        emit(["v": protocolVersion, "type": "result", "status": "connected", "code": "CONNECTED",
              "credentials": ["access_key": values["access_key"]!, "secret_key": values["secret_key"]!]])
    } else {
        emit(["v": protocolVersion, "type": "result", "status": "connected", "code": "CONNECTED", "values": values])
    }
    exit(0)
}

if operation == "clear" {
    if let url = credentialURL() {
        do { if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) } }
        catch { failure("CREDENTIAL_STORE_DENIED") }
    }
    emit(["v": protocolVersion, "type": "result", "status": "setup_required", "code": "SETUP_REQUIRED"])
    exit(0)
}

final class PasteController: NSObject {
    let field: NSSecureTextField
    init(field: NSSecureTextField) { self.field = field }
    @objc func pasteValue(_ sender: Any?) {
        if let value = NSPasteboard.general.string(forType: .string) { field.stringValue = value }
    }
}

func configure() {
    let application = NSApplication.shared
    application.setActivationPolicy(.accessory)
    application.activate(ignoringOtherApps: true)
    let rowHeight: CGFloat = 40
    let viewHeight = CGFloat(fields.count) * rowHeight + 10
    let view = NSView(frame: NSRect(x: 0, y: 0, width: 350, height: viewHeight))
    var controls: [NSSecureTextField] = []
    var controllers: [PasteController] = []
    for (index, descriptor) in fields.enumerated() {
        let y = viewHeight - CGFloat(index + 1) * rowHeight
        let field = NSSecureTextField(string: "")
        field.placeholderString = descriptor.label
        field.isEditable = true
        field.isSelectable = true
        field.frame = NSRect(x: 0, y: y, width: 280, height: 28)
        let controller = PasteController(field: field)
        let paste = NSButton(title: "粘贴", target: controller, action: #selector(PasteController.pasteValue(_:)))
        paste.bezelStyle = .rounded
        paste.frame = NSRect(x: 288, y: y, width: 58, height: 28)
        view.addSubview(field)
        view.addSubview(paste)
        controls.append(field)
        controllers.append(controller)
    }
    let alert = NSAlert()
    alert.messageText = legacy ? "连接 Lovart" : "连接 API 提供商"
    alert.informativeText = "凭据仅保存到本机的 IMVIA Studio 私有文件，不使用 macOS 钥匙串。"
    alert.accessoryView = view
    alert.addButton(withTitle: "连接")
    alert.addButton(withTitle: "取消")
    while true {
        guard alert.runModal() == .alertFirstButtonReturn else {
            controls.forEach { $0.stringValue = "" }
            emit(["v": protocolVersion, "type": "result", "status": "setup_required", "code": "SETUP_CANCELLED"])
            exit(0)
        }
        var values: [String: String] = [:]
        for (descriptor, control) in zip(fields, controls) {
            let value = control.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            if !value.isEmpty { values[descriptor.id] = value }
        }
        guard fields.allSatisfy({ !$0.required || values[$0.id] != nil }), !values.isEmpty else {
            alert.informativeText = "请填写所有必填凭据字段。凭据仅保存到本机的 IMVIA Studio 私有文件。"
            continue
        }
        if legacy {
            emit(["v": protocolVersion, "type": "candidate", "access_key": values["access_key"]!, "secret_key": values["secret_key"]!])
        } else {
            emit(["v": protocolVersion, "type": "candidate", "values": values])
        }
        guard let verdict = readJSONLine(), verdict["v"] as? Int == protocolVersion,
              verdict["type"] as? String == "verdict", let accepted = verdict["accepted"] as? Bool,
              let code = verdict["code"] as? String, code.utf8.count <= 64 else { failure("UPSTREAM_SECURITY_REJECTED") }
        if accepted {
            writeValues(values)
            emit(["v": protocolVersion, "type": "result", "status": "connected", "code": "CONNECTED"])
        } else {
            emit(["v": protocolVersion, "type": "result", "status": "setup_required", "code": code])
        }
        controls.forEach { $0.stringValue = "" }
        _ = controllers
        exit(0)
    }
}

configure()
