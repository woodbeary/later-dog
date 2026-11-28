#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

impl Point {
    pub const fn new(x: f64, y: f64) -> Self {
        Point { x, y }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Segment {
    Move(Point),
    Line(Point),
    Cubic(Point, Point, Point),
    Close,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PathError {
    pub at: usize,
    pub reason: &'static str,
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl Reader<'_> {
    fn skip_separators(&mut self) {
        while self.at < self.bytes.len() && matches!(self.bytes[self.at], b' ' | b',' | b'\n' | b'\t' | b'\r') {
            self.at += 1;
        }
    }

    fn command(&mut self) -> Option<u8> {
        self.skip_separators();
        let byte = *self.bytes.get(self.at)?;
        if byte.is_ascii_alphabetic() {
            self.at += 1;
            return Some(byte);
        }
        None
    }

    fn has_number(&mut self) -> bool {
        self.skip_separators();
        self.bytes.get(self.at).is_some_and(|byte| byte.is_ascii_digit() || matches!(byte, b'-' | b'+' | b'.'))
    }

    fn number(&mut self) -> Result<f64, PathError> {
        self.skip_separators();
        let start = self.at;
        if matches!(self.bytes.get(self.at), Some(b'-' | b'+')) {
            self.at += 1;
        }
        let mut seen_dot = false;
        let mut seen_exponent = false;
        while let Some(&byte) = self.bytes.get(self.at) {
            match byte {
                b'0'..=b'9' => self.at += 1,
                b'.' if !seen_dot && !seen_exponent => {
                    seen_dot = true;
                    self.at += 1;
                }
                b'e' | b'E' if !seen_exponent => {
                    seen_exponent = true;
                    self.at += 1;
                    if matches!(self.bytes.get(self.at), Some(b'-' | b'+')) {
                        self.at += 1;
                    }
                }
                _ => break,
            }
        }
        std::str::from_utf8(&self.bytes[start..self.at])
            .ok()
            .and_then(|text| text.parse::<f64>().ok())
            .ok_or(PathError { at: start, reason: "expected a number" })
    }

    fn flag(&mut self) -> Result<bool, PathError> {
        self.skip_separators();
        match self.bytes.get(self.at) {
            Some(b'0') => {
                self.at += 1;
                Ok(false)
            }
            Some(b'1') => {
                self.at += 1;
                Ok(true)
            }
            _ => Err(PathError { at: self.at, reason: "expected an arc flag" }),
        }
    }

    fn point(&mut self, relative: bool, from: Point) -> Result<Point, PathError> {
        let x = self.number()?;
        let y = self.number()?;
        Ok(if relative { Point::new(from.x + x, from.y + y) } else { Point::new(x, y) })
    }
}

pub fn parse(data: &str) -> Result<Vec<Segment>, PathError> {
    let mut reader = Reader { bytes: data.as_bytes(), at: 0 };
    let mut segments = Vec::new();
    let mut current = Point::new(0.0, 0.0);
    let mut start = current;
    let mut last_control: Option<Point> = None;
    let mut last_quad: Option<Point> = None;
    let mut command = match reader.command() {
        Some(command) if command.eq_ignore_ascii_case(&b'M') => command,
        _ => return Err(PathError { at: reader.at, reason: "a path starts with a move" }),
    };
    loop {
        let relative = command.is_ascii_lowercase();
        let mut cubic_control = None;
        let mut quad_control = None;
        match command.to_ascii_uppercase() {
            b'M' => {
                current = reader.point(relative, current)?;
                start = current;
                segments.push(Segment::Move(current));
                command = if relative { b'l' } else { b'L' };
                while reader.has_number() {
                    current = reader.point(relative, current)?;
                    segments.push(Segment::Line(current));
                }
            }
            b'L' => {
                current = reader.point(relative, current)?;
                segments.push(Segment::Line(current));
            }
            b'H' => {
                let x = reader.number()?;
                current = Point::new(if relative { current.x + x } else { x }, current.y);
                segments.push(Segment::Line(current));
            }
            b'V' => {
                let y = reader.number()?;
                current = Point::new(current.x, if relative { current.y + y } else { y });
                segments.push(Segment::Line(current));
            }
            b'C' => {
                let first = reader.point(relative, current)?;
                let second = reader.point(relative, current)?;
                let end = reader.point(relative, current)?;
                segments.push(Segment::Cubic(first, second, end));
                cubic_control = Some(second);
                current = end;
            }
            b'S' => {
                let first = last_control.map_or(current, |control| Point::new(2.0 * current.x - control.x, 2.0 * current.y - control.y));
                let second = reader.point(relative, current)?;
                let end = reader.point(relative, current)?;
                segments.push(Segment::Cubic(first, second, end));
                cubic_control = Some(second);
                current = end;
            }
            b'Q' => {
                let control = reader.point(relative, current)?;
                let end = reader.point(relative, current)?;
                segments.push(quadratic(current, control, end));
                quad_control = Some(control);
                current = end;
            }
            b'T' => {
                let control = last_quad.map_or(current, |control| Point::new(2.0 * current.x - control.x, 2.0 * current.y - control.y));
                let end = reader.point(relative, current)?;
                segments.push(quadratic(current, control, end));
                quad_control = Some(control);
                current = end;
            }
            b'A' => {
                let rx = reader.number()?;
                let ry = reader.number()?;
                let rotation = reader.number()?;
                let large = reader.flag()?;
                let sweep = reader.flag()?;
                let end = reader.point(relative, current)?;
                segments.extend(arc(current, rx, ry, rotation, large, sweep, end));
                current = end;
            }
            b'Z' => {
                segments.push(Segment::Close);
                current = start;
            }
            _ => return Err(PathError { at: reader.at.saturating_sub(1), reason: "unknown command" }),
        }
        last_control = cubic_control;
        last_quad = quad_control;
        if let Some(next) = reader.command() {
            command = next;
            continue;
        }
        if reader.has_number() && !command.eq_ignore_ascii_case(&b'Z') {
            continue;
        }
        reader.skip_separators();
        if reader.at < reader.bytes.len() {
            return Err(PathError { at: reader.at, reason: "unexpected text" });
        }
        return Ok(segments);
    }
}

fn quadratic(from: Point, control: Point, end: Point) -> Segment {
    let first = Point::new(from.x + 2.0 / 3.0 * (control.x - from.x), from.y + 2.0 / 3.0 * (control.y - from.y));
    let second = Point::new(end.x + 2.0 / 3.0 * (control.x - end.x), end.y + 2.0 / 3.0 * (control.y - end.y));
    Segment::Cubic(first, second, end)
}

fn arc(from: Point, rx: f64, ry: f64, rotation_deg: f64, large: bool, sweep: bool, to: Point) -> Vec<Segment> {
    if from == to {
        return Vec::new();
    }
    let (mut rx, mut ry) = (rx.abs(), ry.abs());
    if rx == 0.0 || ry == 0.0 {
        return vec![Segment::Line(to)];
    }
    let phi = rotation_deg.to_radians();
    let (sin, cos) = phi.sin_cos();
    let dx = (from.x - to.x) / 2.0;
    let dy = (from.y - to.y) / 2.0;
    let x1 = cos * dx + sin * dy;
    let y1 = -sin * dx + cos * dy;
    let lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
    if lambda > 1.0 {
        let scale = lambda.sqrt();
        rx *= scale;
        ry *= scale;
    }
    let numerator = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
    let denominator = rx * rx * y1 * y1 + ry * ry * x1 * x1;
    let mut root = if denominator == 0.0 { 0.0 } else { (numerator / denominator).max(0.0).sqrt() };
    if large == sweep {
        root = -root;
    }
    let cx1 = root * rx * y1 / ry;
    let cy1 = -root * ry * x1 / rx;
    let cx = cos * cx1 - sin * cy1 + (from.x + to.x) / 2.0;
    let cy = sin * cx1 + cos * cy1 + (from.y + to.y) / 2.0;
    let angle = |ux: f64, uy: f64, vx: f64, vy: f64| {
        let dot = ux * vx + uy * vy;
        let length = (ux * ux + uy * uy).sqrt() * (vx * vx + vy * vy).sqrt();
        let value = (dot / length).clamp(-1.0, 1.0).acos();
        if ux * vy - uy * vx < 0.0 { -value } else { value }
    };
    let start_angle = angle(1.0, 0.0, (x1 - cx1) / rx, (y1 - cy1) / ry);
    let mut delta = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
    if !sweep && delta > 0.0 {
        delta -= std::f64::consts::TAU;
    } else if sweep && delta < 0.0 {
        delta += std::f64::consts::TAU;
    }
    let pieces = (delta.abs() / std::f64::consts::FRAC_PI_2).ceil().max(1.0) as usize;
    let step = delta / pieces as f64;
    let handle = 4.0 / 3.0 * (step / 4.0).tan();
    let on_ellipse = |theta: f64| {
        let (s, c) = theta.sin_cos();
        Point::new(cx + rx * c * cos - ry * s * sin, cy + rx * c * sin + ry * s * cos)
    };
    let derivative = |theta: f64| {
        let (s, c) = theta.sin_cos();
        Point::new(-rx * s * cos - ry * c * sin, -rx * s * sin + ry * c * cos)
    };
    let mut segments = Vec::with_capacity(pieces);
    for piece in 0..pieces {
        let a = start_angle + step * piece as f64;
        let b = a + step;
        let (p0, p3) = (on_ellipse(a), if piece + 1 == pieces { to } else { on_ellipse(b) });
        let (d0, d3) = (derivative(a), derivative(b));
        segments.push(Segment::Cubic(
            Point::new(p0.x + handle * d0.x, p0.y + handle * d0.y),
            Point::new(p3.x - handle * d3.x, p3.y - handle * d3.y),
            p3,
        ));
    }
    segments
}

pub fn bounds(segments: &[Segment]) -> Option<(Point, Point)> {
    let mut points = segments.iter().flat_map(|segment| match segment {
        Segment::Move(point) | Segment::Line(point) => vec![*point],
        Segment::Cubic(first, second, end) => vec![*first, *second, *end],
        Segment::Close => Vec::new(),
    });
    let first = points.next()?;
    Some(points.fold((first, first), |(low, high), point| {
        (Point::new(low.x.min(point.x), low.y.min(point.y)), Point::new(high.x.max(point.x), high.y.max(point.y)))
    }))
}
