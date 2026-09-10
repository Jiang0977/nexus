use crate::pen::Pen;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cell(char, Occupancy, Pen, String);

#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub(crate) enum Occupancy {
    Single,
    WideHead,
    WideTail,
}

impl Occupancy {
    pub(crate) fn width(&self) -> u8 {
        match self {
            Occupancy::Single => 1,
            Occupancy::WideHead => 2,
            Occupancy::WideTail => 0,
        }
    }
}

impl Cell {
    pub(crate) fn new(ch: char, occupancy: Occupancy, pen: Pen) -> Self {
        Cell(ch, occupancy, pen, String::new())
    }

    pub(crate) fn blank(pen: Pen) -> Self {
        Self::new(' ', Occupancy::Single, pen)
    }

    pub fn is_default(&self) -> bool {
        self.0 == ' ' && self.1 == Occupancy::Single && self.2.is_default() && self.3.is_empty()
    }

    pub fn char(&self) -> char {
        self.0
    }

    pub fn chars(&self) -> impl Iterator<Item = char> + '_ {
        std::iter::once(self.0).chain(self.3.chars())
    }

    pub(crate) fn combine(&mut self, ch: char) -> bool {
        if self.3.len() + ch.len_utf8() > 1024 {
            return false;
        }
        self.3.push(ch);
        true
    }

    pub(crate) fn occupancy(&self) -> Occupancy {
        self.1
    }

    pub fn width(&self) -> u8 {
        self.1.width()
    }

    pub fn pen(&self) -> &Pen {
        &self.2
    }

    pub(crate) fn set(&mut self, ch: char, occupancy: Occupancy, pen: Pen) {
        self.0 = ch;
        self.1 = occupancy;
        self.2 = pen;
        self.3.clear();
    }
}

impl Default for Cell {
    fn default() -> Self {
        Self::blank(Pen::default())
    }
}
