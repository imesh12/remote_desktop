use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum InputEvent {
    MouseMove { x: f64, y: f64 },
    MouseClick { button: u8 },
    KeyDown { key: String },
    KeyUp { key: String },
}
