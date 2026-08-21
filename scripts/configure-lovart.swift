import AppKit
import Darwin
import Foundation
import Security

let keychainService = "ai.imvia.studio.lovart"
let keychainAccount = "credentials"
let command = CommandLine.arguments.dropFirst().first ?? "configure"

func keychainQuery() -> [String: Any] {
    [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: keychainService,
        kSecAttrAccount as String: keychainAccount,
    ]
}

func readCredentials() -> (String, String)? {
    var query = keychainQuery()
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
          let data = result as? Data,
          let object = try? JSONSerialization.jsonObject(with: data),
          let payload = object as? [String: String],
          let accessKey = payload["accessKey"],
          let secretKey = payload["secretKey"],
          !accessKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
          !secretKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        return nil
    }
    return (accessKey, secretKey)
}

func saveCredentials(accessKey: String, secretKey: String) -> Bool {
    guard let data = try? JSONSerialization.data(withJSONObject: ["accessKey": accessKey, "secretKey": secretKey]) else {
        return false
    }
    let query = keychainQuery()
    let existingStatus = SecItemCopyMatching(query as CFDictionary, nil)
    if existingStatus == errSecSuccess {
        return SecItemUpdate(query as CFDictionary, [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            kSecAttrSynchronizable as String: false,
        ] as CFDictionary) == errSecSuccess
    }
    guard existingStatus == errSecItemNotFound else { return false }
    var item = query
    item[kSecValueData as String] = data
    item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    item[kSecAttrSynchronizable as String] = false
    return SecItemAdd(item as CFDictionary, nil) == errSecSuccess
}

if command == "read" {
    if let (accessKey, secretKey) = readCredentials(),
       let data = try? JSONSerialization.data(withJSONObject: ["accessKey": accessKey, "secretKey": secretKey]),
       let output = String(data: data, encoding: .utf8) {
        print(output)
        exit(EXIT_SUCCESS)
    }
    print("{}")
    exit(EXIT_FAILURE)
}

let application = NSApplication.shared
application.setActivationPolicy(.accessory)

let accessLabel = NSTextField(labelWithString: "Access key")
let secretLabel = NSTextField(labelWithString: "Secret key")
let accessField = NSSecureTextField(frame: NSRect(x: 100, y: 42, width: 300, height: 24))
let secretField = NSSecureTextField(frame: NSRect(x: 100, y: 6, width: 300, height: 24))
accessLabel.frame = NSRect(x: 0, y: 42, width: 90, height: 24)
secretLabel.frame = NSRect(x: 0, y: 6, width: 90, height: 24)

let form = NSView(frame: NSRect(x: 0, y: 0, width: 400, height: 72))
form.addSubview(accessLabel)
form.addSubview(secretLabel)
form.addSubview(accessField)
form.addSubview(secretField)

let alert = NSAlert()
alert.messageText = "Connect Lovart"
alert.informativeText = "Your keys stay in this Mac's local Keychain and are never sent to chat."
alert.accessoryView = form
alert.addButton(withTitle: "Connect")
alert.addButton(withTitle: "Cancel")

application.activate(ignoringOtherApps: true)
let response = alert.runModal()
let accessKey = accessField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
let secretKey = secretField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
let valid = response == .alertFirstButtonReturn && !accessKey.isEmpty && !secretKey.isEmpty
let succeeded = valid && saveCredentials(accessKey: accessKey, secretKey: secretKey)
accessField.stringValue = ""
secretField.stringValue = ""

if succeeded {
    print("Lovart credentials saved.")
    exit(EXIT_SUCCESS)
}
if response != .alertFirstButtonReturn {
    print("Lovart connection cancelled.")
} else if !valid {
    print("Lovart keys are required.")
} else {
    print("Lovart credentials could not be saved.")
}
exit(EXIT_FAILURE)
