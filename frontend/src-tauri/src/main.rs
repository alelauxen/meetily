#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use log;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

/// Versão personalizada: além do terminal, grava o registro em
/// `<dados do app>/Meetily/logs/meetily.log` (no Windows: %APPDATA%\Meetily\logs),
/// porque no Windows o app não tem console e os erros se perdiam.
struct TeeWriter {
    file: Option<File>,
}

impl Write for TeeWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let _ = std::io::stderr().write_all(buf);
        if let Some(f) = self.file.as_mut() {
            let _ = f.write_all(buf);
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        let _ = std::io::stderr().flush();
        if let Some(f) = self.file.as_mut() {
            let _ = f.flush();
        }
        Ok(())
    }
}

/// Abre o arquivo de registro; se passar de 5 MB, guarda o anterior como meetily.old.log.
fn open_log_file() -> Option<File> {
    let mut dir: PathBuf = dirs::data_dir()?;
    dir.push("Meetily");
    dir.push("logs");
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join("meetily.log");
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > 5 * 1024 * 1024 {
            let _ = std::fs::rename(&path, dir.join("meetily.old.log"));
        }
    }
    OpenOptions::new().create(true).append(true).open(path).ok()
}

fn main() {
    // Nível padrão "info"; bibliotecas muito verbosas ficam só com avisos
    if std::env::var("RUST_LOG").is_err() {
        std::env::set_var(
            "RUST_LOG",
            "info,whisper_rs=warn,ort=warn,reqwest=warn,hyper=warn,tao=warn,wry=warn,tokio=warn",
        );
    }

    let writer = TeeWriter { file: open_log_file() };
    env_logger::Builder::from_default_env()
        .format_timestamp_millis()
        .target(env_logger::Target::Pipe(Box::new(writer)))
        .init();

    // Registra erros fatais (pânicos) também no arquivo
    std::panic::set_hook(Box::new(|info| {
        log::error!("PANIC: {}", info);
    }));

    log::info!("Starting application... (build {:?})", option_env!("MEETILY_PT_BUILD"));
    app_lib::run();
}
