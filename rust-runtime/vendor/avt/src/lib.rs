mod buffer;
mod cell;
mod charset;
mod color;
mod line;
pub mod parser;
mod pen;
mod tabs;
pub mod terminal;
pub mod util;
mod vt;
mod width;
pub use cell::Cell;
pub use charset::Charset;
pub use color::Color;
pub use line::Line;
pub use pen::Pen;
pub use vt::Vt;

pub fn char_width(ch: char) -> u8 {
    width::char_width(ch)
}
