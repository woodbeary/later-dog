use std::io::{self, BufRead};
#[cfg(target_os = "linux")]
use tao::platform::unix::WindowExtUnix;
use tao::{
    dpi::LogicalSize,
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder},
    window::WindowBuilder,
};
use wry::WebViewBuilder;
#[cfg(target_os = "linux")]
use wry::WebViewBuilderExtUnix;

fn main() {
    let arguments: Vec<String> = std::env::args().collect();
    let url = arguments.get(1).expect("wry-shell <url> <probe.js>").clone();
    let probe = std::fs::read_to_string(arguments.get(2).expect("wry-shell <url> <probe.js>")).expect("probe file");
    let event_loop = EventLoopBuilder::<String>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    std::thread::spawn(move || {
        for line in io::stdin().lock().lines().map_while(Result::ok) {
            if proxy.send_event(line).is_err() {
                break;
            }
        }
    });
    let window = WindowBuilder::new()
        .with_title("later.dog shell prototype")
        .with_inner_size(LogicalSize::new(1440.0, 900.0))
        .build(&event_loop)
        .expect("window");
    let script = format!("window.__report = (line) => window.ipc.postMessage(line);\n{probe}");
    let page = WebViewBuilder::new()
        .with_url(&url)
        .with_initialization_script(&script)
        .with_ipc_handler(|request| println!("SHELL {}", request.body()));
    #[cfg(target_os = "linux")]
    let webview = page.build_gtk(window.default_vbox().expect("gtk container")).expect("webview");
    #[cfg(not(target_os = "linux"))]
    let webview = page.build(&window).expect("webview");
    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(script) => {
                let _ = webview.evaluate_script(&script);
            }
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => *control_flow = ControlFlow::Exit,
            _ => {}
        }
    });
}
