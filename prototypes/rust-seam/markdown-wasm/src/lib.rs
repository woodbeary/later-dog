use markdown::{to_mdast, Constructs, ParseOptions};

const HEADER_BYTES: usize = 8;

fn parse_options() -> ParseOptions {
    ParseOptions {
        constructs: Constructs {
            math_flow: true,
            math_text: true,
            ..Constructs::gfm()
        },
        ..ParseOptions::gfm()
    }
}

fn handed_over(mut bytes: Vec<u8>) -> *mut u8 {
    let pointer = bytes.as_mut_ptr();
    std::mem::forget(bytes);
    pointer
}

#[no_mangle]
pub extern "C" fn reserve(capacity: usize) -> *mut u8 {
    handed_over(Vec::with_capacity(capacity))
}

#[no_mangle]
pub unsafe extern "C" fn release(pointer: *mut u8, capacity: usize) {
    drop(Vec::from_raw_parts(pointer, 0, capacity));
}

#[no_mangle]
pub unsafe extern "C" fn parse(pointer: *const u8, length: usize) -> *mut u8 {
    let text = std::str::from_utf8_unchecked(std::slice::from_raw_parts(pointer, length));
    let tree = to_mdast(text, &parse_options())
        .ok()
        .and_then(|tree| serde_json::to_vec(&tree).ok())
        .unwrap_or_default();
    let mut answer = Vec::with_capacity(HEADER_BYTES + tree.len());
    answer.extend_from_slice(&(tree.len() as u32).to_le_bytes());
    answer.extend_from_slice(&((HEADER_BYTES + tree.len()) as u32).to_le_bytes());
    answer.extend_from_slice(&tree);
    handed_over(answer)
}
