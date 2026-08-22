use objc2::MainThreadMarker;
use objc2_app_kit::{NSAlert, NSApplication, NSApplicationActivationPolicy, NSView, NSSecureTextField, NSTextField};
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
        super::macos_prompt()
    }
}

#[cfg(target_os = "macos")]
fn macos_prompt() -> Result<PromptOutcome, HelperError> {
    let mtm = MainThreadMarker::new().ok_or_else(|| HelperError::new("CREDENTIAL_SETUP_FAILED"))?;
    let app = NSApplication::sharedApplication(mtm);
    app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);
    app.activateIgnoringOtherApps(true);

    let access = NSTextField::textFieldWithString(ns_string!(""), mtm);
    access.setPlaceholderString(Some(ns_string!("Access Key")));
    access.setFrame(NSRect::new(NSPoint::new(0.0, 55.0), NSSize::new(320.0, 28.0)));
    let secret = NSSecureTextField::textFieldWithString(ns_string!(""), mtm);
    secret.setPlaceholderString(Some(ns_string!("Secret Key")));
    secret.setFrame(NSRect::new(NSPoint::new(0.0, 15.0), NSSize::new(320.0, 28.0)));
    let fields = NSView::new(mtm);
    fields.setFrame(NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(320.0, 85.0)));
    fields.addSubview(&access);
    fields.addSubview(&secret);

    let alert = NSAlert::new(mtm);
    alert.setMessageText(ns_string!("连接 Lovart"));
    alert.setInformativeText(ns_string!("密钥仅保存到 IMVIA Studio 的系统凭据存储。"));
    alert.setAccessoryView(Some(&fields));
    alert.addButtonWithTitle(ns_string!("连接"));
    alert.addButtonWithTitle(ns_string!("取消"));
    let response = alert.runModal();
    let access_value = access.stringValue();
    let secret_value = secret.stringValue();
    access.setStringValue(ns_string!(""));
    secret.setStringValue(ns_string!(""));
    if response.0 != 1000 { return Ok(PromptOutcome::Cancelled); }
    CredentialPair::new(access_value.to_string(), secret_value.to_string()).map(PromptOutcome::Candidate)
}
