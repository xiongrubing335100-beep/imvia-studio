import AppKit
import Darwin
import Security

let keychainService = "ai.imvia.studio.lovart-readonly"
let accessKeyAccount = "access-key"
let secretKeyAccount = "secret-key"

func storeAccessKey(_ value: Data) -> Bool {
    let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: keychainService,
        kSecAttrAccount as String: accessKeyAccount,
    ]
    let existingStatus = SecItemCopyMatching(query as CFDictionary, nil)
    if existingStatus == errSecSuccess {
        return SecItemUpdate(
            query as CFDictionary,
            [kSecValueData as String: value] as CFDictionary
        ) == errSecSuccess
    }
    guard existingStatus == errSecItemNotFound else { return false }
    var item = query
    item[kSecValueData as String] = value
    return SecItemAdd(item as CFDictionary, nil) == errSecSuccess
}

func storeSecretKey(_ value: Data) -> Bool {
    let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: keychainService,
        kSecAttrAccount as String: secretKeyAccount,
    ]
    let existingStatus = SecItemCopyMatching(query as CFDictionary, nil)
    if existingStatus == errSecSuccess {
        return SecItemUpdate(
            query as CFDictionary,
            [kSecValueData as String: value] as CFDictionary
        ) == errSecSuccess
    }
    guard existingStatus == errSecItemNotFound else { return false }
    var item = query
    item[kSecValueData as String] = value
    return SecItemAdd(item as CFDictionary, nil) == errSecSuccess
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
alert.messageText = "Configure Lovart read-only credentials"
alert.informativeText = "Credentials are stored only in the fixed IMVIA macOS Keychain items."
alert.accessoryView = form
alert.addButton(withTitle: "Save")
alert.addButton(withTitle: "Cancel")

application.activate(ignoringOtherApps: true)
let response = alert.runModal()
var succeeded = false

if response == .alertFirstButtonReturn,
   !accessField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
   !secretField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
    var accessData = accessField.stringValue.data(using: .utf8) ?? Data()
    var secretData = secretField.stringValue.data(using: .utf8) ?? Data()

    let accessStored = storeAccessKey(accessData)
    accessData.resetBytes(in: accessData.startIndex..<accessData.endIndex)
    accessField.stringValue = ""

    var secretStored = false
    if accessStored {
        secretStored = storeSecretKey(secretData)
    }
    secretData.resetBytes(in: secretData.startIndex..<secretData.endIndex)
    secretField.stringValue = ""

    succeeded = accessStored && secretStored
}

accessField.stringValue = ""
secretField.stringValue = ""

if succeeded {
    print("Lovart read-only credentials saved.")
    exit(EXIT_SUCCESS)
} else {
    print("Lovart read-only credential configuration failed. You may safely rerun this helper.")
    exit(EXIT_FAILURE)
}
