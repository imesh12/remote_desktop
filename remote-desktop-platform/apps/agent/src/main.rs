mod input;

#[cfg(windows)]
mod windows_input;

use input::InputEvent;
use tokio::io::{self, AsyncBufReadExt, BufReader};

#[cfg(windows)]
use windows_input::InputInjector;

#[cfg(windows)]
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    println!(
        "Remote desktop agent input injector is ready. Waiting for newline-delimited JSON input events on stdin."
    );

    let injector = InputInjector::new();
    let mut lines = BufReader::new(io::stdin()).lines();

    while let Some(line) = lines.next_line().await? {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        match serde_json::from_str::<InputEvent>(trimmed) {
            Ok(event) => {
                if let Err(error) = injector.apply(event) {
                    eprintln!("Failed to inject input: {error}");
                }
            }
            Err(error) => {
                eprintln!("Failed to parse input event: {error}");
            }
        }
    }

    Ok(())
}

#[cfg(not(windows))]
fn main() {
    eprintln!("The Rust input injector is available only on Windows.");
}
