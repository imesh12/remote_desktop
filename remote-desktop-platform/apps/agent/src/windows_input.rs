use crate::input::InputEvent;
use std::error::Error;
use std::fmt::{Display, Formatter};
use windows::Win32::Foundation::GetLastError;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYBD_EVENT_FLAGS,
    KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
    MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_RIGHTDOWN,
    MOUSEEVENTF_RIGHTUP, MOUSEINPUT, MOUSE_EVENT_FLAGS, VIRTUAL_KEY, VK_BACK, VK_CONTROL,
    VK_DELETE, VK_DOWN, VK_END, VK_ESCAPE, VK_HOME, VK_LEFT, VK_MENU, VK_NEXT, VK_PRIOR,
    VK_RETURN, VK_RIGHT, VK_SHIFT, VK_SPACE, VK_TAB, VK_UP,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, SetCursorPos, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
    SM_YVIRTUALSCREEN,
};

type Result<T> = std::result::Result<T, InputInjectionError>;

#[derive(Debug)]
pub struct InputInjector;

#[derive(Debug)]
pub enum InputInjectionError {
    UnsupportedMouseButton(u8),
    UnsupportedKey(String),
    WindowsApi {
        operation: &'static str,
        code: u32,
    },
}

impl Display for InputInjectionError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnsupportedMouseButton(button) => {
                write!(f, "unsupported mouse button: {button}")
            }
            Self::UnsupportedKey(key) => write!(f, "unsupported key: {key}"),
            Self::WindowsApi { operation, code } => {
                write!(f, "{operation} failed with Windows error code {code}")
            }
        }
    }
}

impl Error for InputInjectionError {}

impl InputInjector {
    pub fn new() -> Self {
        Self
    }

    pub fn apply(&self, event: InputEvent) -> Result<()> {
        match event {
            InputEvent::MouseMove { x, y } => self.move_cursor(x, y),
            InputEvent::MouseClick { button } => self.click_mouse(button),
            InputEvent::KeyDown { key } => self.send_key(&key, false),
            InputEvent::KeyUp { key } => self.send_key(&key, true),
        }
    }

    fn move_cursor(&self, normalized_x: f64, normalized_y: f64) -> Result<()> {
        let screen = ScreenBounds::load();
        let target_x = screen.left
            + ((normalized_x.clamp(0.0, 1.0) * f64::from(screen.width.saturating_sub(1))).round()
                as i32);
        let target_y = screen.top
            + ((normalized_y.clamp(0.0, 1.0) * f64::from(screen.height.saturating_sub(1))).round()
                as i32);

        unsafe {
            SetCursorPos(target_x, target_y).map_err(|_| Self::last_error("SetCursorPos"))?;
        }

        Ok(())
    }

    fn click_mouse(&self, button: u8) -> Result<()> {
        let flags = match button {
            0 => MOUSEEVENTF_LEFTDOWN | MOUSEEVENTF_LEFTUP,
            1 => MOUSEEVENTF_MIDDLEDOWN | MOUSEEVENTF_MIDDLEUP,
            2 => MOUSEEVENTF_RIGHTDOWN | MOUSEEVENTF_RIGHTUP,
            _ => return Err(InputInjectionError::UnsupportedMouseButton(button)),
        };

        self.send_mouse_input(flags)
    }

    fn send_mouse_input(&self, flags: MOUSE_EVENT_FLAGS) -> Result<()> {
        let input = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx: 0,
                    dy: 0,
                    mouseData: 0,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };

        unsafe {
            let sent = SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
            if sent != 1 {
                return Err(Self::last_error("SendInput(mouse)"));
            }
        }

        Ok(())
    }

    fn send_key(&self, key: &str, key_up: bool) -> Result<()> {
        if let Some(virtual_key) = named_virtual_key(key) {
            return self.send_virtual_key(virtual_key, key_up);
        }

        let mut chars = key.encode_utf16();
        let Some(character) = chars.next() else {
            return Err(InputInjectionError::UnsupportedKey(key.to_owned()));
        };

        if chars.next().is_some() {
            return Err(InputInjectionError::UnsupportedKey(key.to_owned()));
        }

        self.send_unicode_key(character, key_up)
    }

    fn send_unicode_key(&self, character: u16, key_up: bool) -> Result<()> {
        let mut flags = KEYEVENTF_UNICODE;
        if key_up {
            flags |= KEYEVENTF_KEYUP;
        }

        let input = INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(0),
                    wScan: character,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };

        unsafe {
            let sent = SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
            if sent != 1 {
                return Err(Self::last_error("SendInput(unicode)"));
            }
        }

        Ok(())
    }

    fn send_virtual_key(&self, key: VIRTUAL_KEY, key_up: bool) -> Result<()> {
        let mut flags = KEYBD_EVENT_FLAGS(0);
        if key_up {
            flags |= KEYEVENTF_KEYUP;
        }

        let input = INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: key,
                    wScan: 0,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };

        unsafe {
            let sent = SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
            if sent != 1 {
                return Err(Self::last_error("SendInput(keyboard)"));
            }
        }

        Ok(())
    }
    fn last_error(operation: &'static str) -> InputInjectionError {
    let code = windows::core::Error::from_win32().code().0 as u32;
    InputInjectionError::WindowsApi { operation, code }
}
}

#[derive(Debug)]
struct ScreenBounds {
    left: i32,
    top: i32,
    width: i32,
    height: i32,
}

impl ScreenBounds {
    fn load() -> Self {
        unsafe {
            Self {
                left: GetSystemMetrics(SM_XVIRTUALSCREEN),
                top: GetSystemMetrics(SM_YVIRTUALSCREEN),
                width: GetSystemMetrics(SM_CXVIRTUALSCREEN),
                height: GetSystemMetrics(SM_CYVIRTUALSCREEN),
            }
        }
    }
}

fn named_virtual_key(key: &str) -> Option<VIRTUAL_KEY> {
    match key {
        "Enter" => Some(VK_RETURN),
        "Backspace" => Some(VK_BACK),
        "Tab" => Some(VK_TAB),
        "Escape" => Some(VK_ESCAPE),
        " " => Some(VK_SPACE),
        "ArrowUp" => Some(VK_UP),
        "ArrowDown" => Some(VK_DOWN),
        "ArrowLeft" => Some(VK_LEFT),
        "ArrowRight" => Some(VK_RIGHT),
        "Delete" => Some(VK_DELETE),
        "Home" => Some(VK_HOME),
        "End" => Some(VK_END),
        "PageUp" => Some(VK_PRIOR),
        "PageDown" => Some(VK_NEXT),
        "Shift" => Some(VK_SHIFT),
        "Control" => Some(VK_CONTROL),
        "Alt" => Some(VK_MENU),
        _ => None,
    }
}
