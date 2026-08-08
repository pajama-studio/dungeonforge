use wasm_bindgen::prelude::*;

const DX: [i32; 4] = [1, -1, 0, 0];
const DY: [i32; 4] = [0, 0, 1, -1];

struct Mulberry32 {
    state: u32,
    draws: u32,
}

impl Mulberry32 {
    fn new(seed: u32) -> Self { Self { state: seed, draws: 0 } }

    fn next(&mut self) -> f64 {
        self.draws += 1;
        self.state = self.state.wrapping_add(0x6d2b79f5);
        let mut t = (self.state ^ (self.state >> 15)).wrapping_mul(1 | self.state);
        t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t)) ^ t;
        ((t ^ (t >> 14)) as f64) / 4_294_967_296.0
    }

    fn chance(&mut self, p: f64) -> bool { self.next() < p }
    fn index(&mut self, len: usize) -> usize {
        (self.next() * len as f64).floor() as usize
    }
}

fn hash2(seed: u32, i: i32, j: i32) -> f64 {
    let mut h = seed
        ^ (i as u32).wrapping_mul(374_761_393)
        ^ (j as u32).wrapping_mul(668_265_263);
    h = (h ^ (h >> 13)).wrapping_mul(1_274_126_177);
    ((h ^ (h >> 16)) as f64) / 4_294_967_296.0
}

fn value_noise2(seed: u32, x: f64, y: f64) -> f64 {
    fn sample(seed: u32, x: f64, y: f64) -> f64 {
        let ix = x.floor() as i32;
        let iy = y.floor() as i32;
        let fx = x - ix as f64;
        let fy = y - iy as f64;
        let sx = fx * fx * (3.0 - 2.0 * fx);
        let sy = fy * fy * (3.0 - 2.0 * fy);
        let a = hash2(seed, ix, iy);
        let b = hash2(seed, ix + 1, iy);
        let c = hash2(seed, ix, iy + 1);
        let d = hash2(seed, ix + 1, iy + 1);
        a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy
    }
    sample(seed, x, y) * 0.68 + sample(seed ^ 0x9e37_79b9, x * 2.13, y * 2.13) * 0.32
}

#[wasm_bindgen]
pub struct MazeCore {
    tiers: Vec<i8>,
    open: Vec<u8>,
    rng_draws: u32,
    dead_ends: u32,
    cycle_rank: u32,
    vertical_edges: u32,
    tier_span: u8,
}

#[wasm_bindgen]
impl MazeCore {
    #[wasm_bindgen(getter)]
    pub fn tiers(&self) -> Vec<i8> { self.tiers.clone() }
    #[wasm_bindgen(getter)]
    pub fn open(&self) -> Vec<u8> { self.open.clone() }
    #[wasm_bindgen(getter)]
    pub fn rng_draws(&self) -> u32 { self.rng_draws }
    #[wasm_bindgen(getter)]
    pub fn dead_ends(&self) -> u32 { self.dead_ends }
    #[wasm_bindgen(getter)]
    pub fn cycle_rank(&self) -> u32 { self.cycle_rank }
    #[wasm_bindgen(getter)]
    pub fn vertical_edges(&self) -> u32 { self.vertical_edges }
    #[wasm_bindgen(getter)]
    pub fn tier_span(&self) -> u8 { self.tier_span }
}

#[wasm_bindgen]
pub fn generate_maze_core(
    size: u32,
    seed: u32,
    newest: f64,
    braid: f64,
    loops: f64,
    height_amp: f64,
    mound_height: f64,
    volume_bias: &[i8],
) -> MazeCore {
    let m = size.clamp(7, 23) as usize;
    assert_eq!(volume_bias.len(), m * m);
    let ci = m >> 1;
    let index = |x: usize, y: usize| y * m + x;
    let tier_target = |x: usize, y: usize| -> i8 {
        let noise = value_noise2(seed ^ 0x51ab, x as f64 * 0.46, y as f64 * 0.46) * height_amp;
        let dx = x as f64 - ci as f64;
        let dy = y as f64 - 1.2;
        let temple_distance = (dx * dx + dy * dy).sqrt();
        let mound = (mound_height - temple_distance * 0.48).max(0.0);
        (noise + mound - 0.4 + volume_bias[index(x, y)] as f64).round().clamp(0.0, 7.0) as i8
    };

    let mut rng = Mulberry32::new(seed);
    let mut tiers = vec![-1_i8; m * m];
    let mut open = vec![0_u8; m * m * 4];
    let connect = |x: usize, y: usize, d: usize, open: &mut [u8]| {
        let nx = (x as i32 + DX[d]) as usize;
        let ny = (y as i32 + DY[d]) as usize;
        open[index(x, y) * 4 + d] = 1;
        open[index(nx, ny) * 4 + (d ^ 1)] = 1;
    };

    let start = index(ci, m - 1);
    tiers[start] = tier_target(ci, m - 1).min(2);
    let mut active = vec![start];
    while !active.is_empty() {
        let pick = if rng.chance(newest) {
            active.len() - 1
        } else {
            rng.index(active.len())
        };
        let current = active[pick];
        let cx = current % m;
        let cy = current / m;
        let mut dirs = [0_usize; 4];
        let mut dir_count = 0;
        for d in 0..4 {
            let nx = cx as i32 + DX[d];
            let ny = cy as i32 + DY[d];
            if nx < 0 || ny < 0 || nx >= m as i32 || ny >= m as i32 { continue; }
            if tiers[index(nx as usize, ny as usize)] < 0 {
                dirs[dir_count] = d;
                dir_count += 1;
            }
        }
        if dir_count == 0 {
            active.remove(pick);
            continue;
        }
        let d = dirs[rng.index(dir_count)];
        let nx = (cx as i32 + DX[d]) as usize;
        let ny = (cy as i32 + DY[d]) as usize;
        let current_tier = tiers[current];
        tiers[index(nx, ny)] = tier_target(nx, ny)
            .min(current_tier + 1)
            .max(current_tier - 1)
            .clamp(0, 7);
        connect(cx, cy, d, &mut open);
        active.push(index(nx, ny));
    }

    for y in 0..m {
        for x in 0..m {
            let cell = index(x, y);
            let degree: u8 = open[cell * 4..cell * 4 + 4].iter().sum();
            if degree != 1 || !rng.chance(braid) { continue; }
            let mut options = [0_usize; 4];
            let mut count = 0;
            for d in 0..4 {
                if open[cell * 4 + d] != 0 { continue; }
                let nx = x as i32 + DX[d];
                let ny = y as i32 + DY[d];
                if nx < 0 || ny < 0 || nx >= m as i32 || ny >= m as i32 { continue; }
                if (tiers[index(nx as usize, ny as usize)] - tiers[cell]).abs() <= 1 {
                    options[count] = d;
                    count += 1;
                }
            }
            if count > 0 { connect(x, y, options[rng.index(count)], &mut open); }
        }
    }
    for y in 0..m {
        for x in 0..m {
            for d in [0_usize, 2_usize] {
                let nx = x as i32 + DX[d];
                let ny = y as i32 + DY[d];
                if nx >= m as i32 || ny >= m as i32 { continue; }
                if open[index(x, y) * 4 + d] != 0 { continue; }
                if (tiers[index(nx as usize, ny as usize)] - tiers[index(x, y)]).abs() <= 1
                    && rng.chance(loops)
                {
                    connect(x, y, d, &mut open);
                }
            }
        }
    }

    let mut dead_ends = 0;
    let mut edges = 0;
    let mut vertical_edges = 0;
    let mut min_tier = 7_i8;
    let mut max_tier = 0_i8;
    for y in 0..m {
        for x in 0..m {
            let cell = index(x, y);
            let degree: u8 = open[cell * 4..cell * 4 + 4].iter().sum();
            if degree == 1 { dead_ends += 1; }
            min_tier = min_tier.min(tiers[cell]);
            max_tier = max_tier.max(tiers[cell]);
            for d in [0_usize, 2_usize] {
                if open[cell * 4 + d] == 0 { continue; }
                edges += 1;
                let nx = (x as i32 + DX[d]) as usize;
                let ny = (y as i32 + DY[d]) as usize;
                if tiers[index(nx, ny)] != tiers[cell] { vertical_edges += 1; }
            }
        }
    }
    MazeCore {
        tiers,
        open,
        rng_draws: rng.draws,
        dead_ends,
        cycle_rank: edges + 1 - (m * m) as u32,
        vertical_edges,
        tier_span: (max_tier - min_tier) as u8,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn core_is_connected_and_tier_safe() {
        for seed in [1, 7, 42, 999, 2_026_080_6] {
            let core = generate_maze_core(15, seed, 0.7, 0.45, 0.08, 3.0, 3.7, &[0; 225]);
            assert!(core.open.iter().any(|v| *v != 0));
            assert!(core.tiers.iter().all(|t| (0..=7).contains(t)));
            assert!(core.cycle_rank > 0);
        }
    }
}
