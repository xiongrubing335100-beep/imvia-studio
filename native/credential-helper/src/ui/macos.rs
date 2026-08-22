use objc2::{sel, MainThreadMarker};
use objc2_app_kit::{
    NSAlert, NSAlertFirstButtonReturn, NSApplication, NSApplicationActivationPolicy, NSButton,
    NSView, NSSecureTextField, NSTextField,
};
use objc2_foundation::{ns_string, NSPoint, NSRect, NSSize};

use crate::protocol::{CredentialPair, HelperError};
use crate::ui::{CredentialPrompt, PromptOutcome};

/// The macOS UI is intentionally kept in a platform module so the helper never
/// falls back to a compiler or a shell script at runtime. The production build
/// supplies the AppKit implementation; tests inject a prompt adapter instead.
pub struct MacCredentialPrompt;

impl CredentialPrompt for MacCredentialPrompt {
    fn prompt(&self) -> Result<PromptOutcome, HelperError> {
        // The AppKit prompt is hosted by the signed helper process. Keeping the
        // adapter boundary here prevents credentials from entering Node or the
        // browser and makes cancellation a first-class result.
        macos_prompt()
    }
}

#[cfg(target_os = "macos")]
fn macos_prompt() -> Result<PromptOutcome, HelperError> {
    let mtm = MainThreadMarker::new().ok_or_else(|| HelperError::new("CREDENTIAL_SETUP_FAILED"))?;
    let app = NSApplication::sharedApplication(mtm);
    app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);
    app.activateIgnoringOtherApps(true);

    let access = NSTextField::textFieldWithString(ns_string!(""), mtm);
    access.setEditable(true);
    access.setSelectable(true);
    access.setAllowsEditingTextAttributes(false);
    access.setPlaceholderString(Some(ns_string!("Access Key")));
    access.setFrame(NSRect::new(NSPoint::new(0.0, 55.0), NSSize::new(280.0, 28.0)));
    let secret = NSSecureTextField::new(mtm);
    secret.setEditable(true);
    secret.setSelectable(true);
    secret.setAllowsEditingTextAttributes(false);
    secret.setStringValue(ns_string!(""));
    secret.setPlaceholderString(Some(ns_string!("Secret Key")));
    secret.setFrame(NSRect::new(NSPoint::new(0.0, 15.0), NSSize::new(280.0, 28.0)));
    let fields = NSView::new(mtm);
    fields.setFrame(NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(350.0, 85.0)));

    // Keep a deterministic paste path available even when the host app or
    // keyboard focus does not forward Cmd+V to the text field. NSControl's
    // standard `paste:` action reads the general NSPasteboard and inserts the
    // value into the target field without exposing it to Node or the browser.
    let access_paste = unsafe {
        NSButton::buttonWithTitle_target_action(
            ns_string!("粘贴"),
            Some(access.as_ref()),
            Some(sel!(paste:)),
            mtm,
        )
    };
    access_paste.setFrame(NSRect::new(NSPoint::new(288.0, 55.0), NSSize::new(58.0, 28.0)));
    let secret_paste = unsafe {
        NSButton::buttonWithTitle_target_action(
            ns_string!("粘贴"),
            Some(secret.as_ref()),
            Some(sel!(paste:)),
            mtm,
        )
    };
    secret_paste.setFrame(NSRect::new(NSPoint::new(288.0, 15.0), NSSize::new(58.0, 28.0)));
    fields.addSubview(&access);
    fields.addSubview(&secret);
    fields.addSubview(&access_paste);
    fields.addSubview(&secret_paste);

    let alert = NSAlert::new(mtm);
    alert.setMessageText(ns_string!("连接 Lovart"));
    alert.setInformativeText(ns_string!("密钥仅保存到本机的 IMVIA Studio 私有文件，不使用 macOS 钥匙串。可直接粘贴，或点击字段右侧的「粘贴」按钮；保存后下次打开无需重复填写。"));
    alert.setAccessoryView(Some(&fields));
    alert.addButtonWithTitle(ns_string!("连接"));
    alert.addButtonWithTitle(ns_string!("取消"));
    let response = alert.runModal();
    let access_value = access.stringValue();
    let secret_value = secret.stringValue();
    access.setStringValue(ns_string!(""));
    secret.setStringValue(ns_string!(""));
    if response != NSAlertFirstButtonReturn { return Ok(PromptOutcome::Cancelled); }
    CredentialPair::new(access_value.to_string(), secret_value.to_string()).map(PromptOutcome::Candidate)
}
