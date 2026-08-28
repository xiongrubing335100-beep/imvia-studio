use std::collections::BTreeMap;

use objc2::{define_class, msg_send, sel, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObject, NSObjectProtocol};
use objc2_app_kit::{
    NSAlert, NSAlertFirstButtonReturn, NSApplication, NSApplicationActivationPolicy, NSButton,
    NSPasteboard, NSPasteboardTypeString, NSSecureTextField, NSView,
};
use objc2_foundation::{ns_string, NSPoint, NSRect, NSSize, NSString};

use crate::protocol::{CredentialField, CredentialValues, HelperError};
use crate::ui::{CredentialPrompt, PromptOutcome};

pub struct MacCredentialPrompt;

#[derive(Clone)]
struct PasteControllerIvars { field: Retained<NSSecureTextField> }

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = PasteControllerIvars]
    struct PasteController;

    impl PasteController {
        #[unsafe(method(pasteValue:))]
        fn paste_value(&self, _sender: Option<&AnyObject>) {
            let pasteboard_type = unsafe { NSPasteboardTypeString };
            if let Some(value) = NSPasteboard::generalPasteboard().stringForType(pasteboard_type) {
                self.ivars().field.setStringValue(&value);
            }
        }
    }

    unsafe impl NSObjectProtocol for PasteController {}
);

impl PasteController {
    fn new(field: Retained<NSSecureTextField>, mtm: MainThreadMarker) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(PasteControllerIvars { field });
        unsafe { msg_send![super(this), init] }
    }
}

impl CredentialPrompt for MacCredentialPrompt {
    fn prompt(&self, fields: &[CredentialField]) -> Result<PromptOutcome, HelperError> { macos_prompt(fields) }
}

fn macos_prompt(descriptors: &[CredentialField]) -> Result<PromptOutcome, HelperError> {
    let mtm = MainThreadMarker::new().ok_or_else(|| HelperError::new("CREDENTIAL_SETUP_FAILED"))?;
    let app = NSApplication::sharedApplication(mtm);
    app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);
    app.activateIgnoringOtherApps(true);

    let row_height = 40.0;
    let view_height = descriptors.len() as f64 * row_height + 10.0;
    let fields_view = NSView::new(mtm);
    fields_view.setFrame(NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(350.0, view_height)));
    let mut controls = Vec::with_capacity(descriptors.len());
    let mut paste_controllers = Vec::with_capacity(descriptors.len());
    for (index, descriptor) in descriptors.iter().enumerate() {
        let y = view_height - ((index + 1) as f64 * row_height);
        let control = NSSecureTextField::new(mtm);
        control.setEditable(true);
        control.setSelectable(true);
        control.setAllowsEditingTextAttributes(false);
        control.setSendsActionOnEndEditing(false);
        control.setStringValue(ns_string!(""));
        let placeholder = NSString::from_str(descriptor.label.trim());
        control.setPlaceholderString(Some(&placeholder));
        control.setFrame(NSRect::new(NSPoint::new(0.0, y), NSSize::new(280.0, 28.0)));
        let controller = PasteController::new(control.clone(), mtm);
        let paste = unsafe {
            NSButton::buttonWithTitle_target_action(ns_string!("粘贴"), Some(controller.as_ref()), Some(sel!(pasteValue:)), mtm)
        };
        paste.setFrame(NSRect::new(NSPoint::new(288.0, y), NSSize::new(58.0, 28.0)));
        fields_view.addSubview(&control);
        fields_view.addSubview(&paste);
        controls.push(control);
        paste_controllers.push(controller);
    }

    let alert = NSAlert::new(mtm);
    alert.setMessageText(ns_string!("连接 API 提供商"));
    alert.setInformativeText(ns_string!("凭据仅保存到本机的 IMVIA Studio 私有文件，不使用 macOS 钥匙串。"));
    alert.setAccessoryView(Some(&fields_view));
    alert.addButtonWithTitle(ns_string!("连接"));
    alert.addButtonWithTitle(ns_string!("取消"));
    loop {
        let response = alert.runModal();
        if response != NSAlertFirstButtonReturn {
            for control in &controls { control.setStringValue(ns_string!("")); }
            return Ok(PromptOutcome::Cancelled);
        }
        let values = descriptors.iter().zip(&controls).map(|(descriptor, control)| {
            (descriptor.id.clone(), control.stringValue().to_string())
        }).collect::<BTreeMap<_, _>>();
        match CredentialValues::new(values, descriptors) {
            Ok(candidate) => {
                for control in &controls { control.setStringValue(ns_string!("")); }
                drop(paste_controllers);
                return Ok(PromptOutcome::Candidate(candidate));
            }
            Err(_) => alert.setInformativeText(ns_string!("请填写所有必填凭据字段。凭据仅保存到本机的 IMVIA Studio 私有文件。")),
        }
    }
}
