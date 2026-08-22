use objc2::{define_class, msg_send, sel, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSAlert, NSAlertFirstButtonReturn, NSApplication, NSApplicationActivationPolicy, NSButton,
    NSPasteboard, NSPasteboardTypeString, NSView, NSSecureTextField, NSTextField,
};
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObject, NSObjectProtocol};
use objc2_foundation::{ns_string, NSPoint, NSRect, NSSize};

use crate::protocol::{CredentialPair, HelperError};
use crate::ui::{CredentialPrompt, PromptOutcome};

/// The macOS UI is intentionally kept in a platform module so the helper never
/// falls back to a compiler or a shell script at runtime. The production build
/// supplies the AppKit implementation; tests inject a prompt adapter instead.
pub struct MacCredentialPrompt;

/// Target for the accessory-view paste buttons.
///
/// The buttons must not target the text fields directly. Sending the generic
/// `paste:` action to an `NSTextField` is host-dependent and, in the helper's
/// AppKit process, could make the native prompt exit instead of inserting the
/// clipboard text. A small Objective-C target keeps the dialog alive and
/// performs the paste explicitly into the retained field.
#[derive(Clone)]
struct PasteControllerIvars {
    access: Retained<NSTextField>,
    secret: Retained<NSSecureTextField>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = PasteControllerIvars]
    struct PasteController;

    impl PasteController {
        #[unsafe(method(pasteAccess:))]
        fn paste_access(&self, _sender: Option<&AnyObject>) {
            let pasteboard_type = unsafe { NSPasteboardTypeString };
            if let Some(value) = NSPasteboard::generalPasteboard().stringForType(pasteboard_type) {
                self.ivars().access.setStringValue(&value);
            }
        }

        #[unsafe(method(pasteSecret:))]
        fn paste_secret(&self, _sender: Option<&AnyObject>) {
            let pasteboard_type = unsafe { NSPasteboardTypeString };
            if let Some(value) = NSPasteboard::generalPasteboard().stringForType(pasteboard_type) {
                self.ivars().secret.setStringValue(&value);
            }
        }
    }

    unsafe impl NSObjectProtocol for PasteController {}
);

impl PasteController {
    fn new(
        access: Retained<NSTextField>,
        secret: Retained<NSSecureTextField>,
        mtm: MainThreadMarker,
    ) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(PasteControllerIvars { access, secret });
        // SAFETY: PasteController subclasses NSObject and does not override init.
        unsafe { msg_send![super(this), init] }
    }
}

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
    // keyboard focus does not forward Cmd+V to the text field. The controller
    // reads the general NSPasteboard in this process and inserts the value
    // without exposing it to Node or the browser.
    let paste_controller = PasteController::new(access.clone(), secret.clone(), mtm);
    let access_paste = unsafe {
        NSButton::buttonWithTitle_target_action(
            ns_string!("粘贴"),
            Some(paste_controller.as_ref()),
            Some(sel!(pasteAccess:)),
            mtm,
        )
    };
    access_paste.setFrame(NSRect::new(NSPoint::new(288.0, 55.0), NSSize::new(58.0, 28.0)));
    let secret_paste = unsafe {
        NSButton::buttonWithTitle_target_action(
            ns_string!("粘贴"),
            Some(paste_controller.as_ref()),
            Some(sel!(pasteSecret:)),
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
