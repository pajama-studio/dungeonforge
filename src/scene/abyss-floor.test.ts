import { describe, expect, it } from "vitest";
import { abyssFloorHeight, ABYSS_FLOOR } from "./abyss-floor";

// Captured from the inline implementation in buildEnvironment() BEFORE it was
// extracted, so this pins the refactor to the shape the world already had
// rather than to a copy of the new code. A deliberate change to the field
// changes these numbers, which is the point: it has to be deliberate.
const GOLDEN: [seed: number, x: number, z: number, relief: number][] = [
  [1, 0, 0, -7.41282020932],
  [1, 12.5, -37.5, -6.572075202507],
  [1, -450, -450, 5.409009887128],
  [1, 450, 450, 5.529929789484],
  [1, 137.5, 62.5, -1.378630367987],
  [1, -212.5, 300, -3.172734877552],
  [1, 87.5, -175, -5.453329714175],
  [1, -25, 25, -7.408705852024],
  [1, 375, -412.5, 1.065384624356],
  [1, 250, 150, -7.245675783865],
  [808, 0, 0, -1.858885711048],
  [808, 12.5, -37.5, -3.655944025591],
  [808, -450, -450, 4.106790763011],
  [808, 450, 450, 4.338928954868],
  [808, 137.5, 62.5, -0.663152117255],
  [808, -212.5, 300, -5.692202122665],
  [808, 87.5, -175, 1.286168710458],
  [808, -25, 25, -1.49524526056],
  [808, 375, -412.5, 1.935396717955],
  [808, 250, 150, -1.294929144316],
  [20260811, 0, 0, 2.017006761417],
  [20260811, 12.5, -37.5, -0.651926059742],
  [20260811, -450, -450, 3.658850878349],
  [20260811, 450, 450, 4.297164468759],
  [20260811, 137.5, 62.5, -0.624501945454],
  [20260811, -212.5, 300, -1.524705426760],
  [20260811, 87.5, -175, -4.432543691399],
  [20260811, -25, 25, 0.399911385050],
  [20260811, 375, -412.5, -1.770028023118],
  [20260811, 250, 150, -1.616410885513],
];

describe("abyss floor height field", () => {
  it("reproduces the relief the bedrock mesh was built with", () => {
    for (const [seed, x, z, expected] of GOLDEN) {
      expect(abyssFloorHeight(seed, x, z)).toBeCloseTo(expected, 9);
    }
  });

  it("is a pure function of seed and position", () => {
    for (let i = 0; i < 50; i++) {
      const x = (i * 37) % 900 - 450;
      const z = (i * 53) % 900 - 450;
      expect(abyssFloorHeight(808, x, z)).toBe(abyssFloorHeight(808, x, z));
    }
  });

  it("gives different seeds different floors", () => {
    let differences = 0;
    for (let i = 0; i < 40; i++) {
      const x = (i * 41) % 900 - 450;
      const z = (i * 67) % 900 - 450;
      if (Math.abs(abyssFloorHeight(1, x, z) - abyssFloorHeight(2, x, z)) > 1e-6) differences++;
    }
    expect(differences).toBeGreaterThan(30);
  });

  it("stays inside the amplitude the terrain budget assumes", () => {
    const limit = ABYSS_FLOOR.plateauAmplitude / 2 +
      ABYSS_FLOOR.weatherAmplitude / 2 + ABYSS_FLOOR.microAmplitude / 2;
    for (let i = 0; i < 400; i++) {
      const x = (i * 13) % 900 - 450;
      const z = (i * 29) % 900 - 450;
      expect(Math.abs(abyssFloorHeight(808, x, z))).toBeLessThanOrEqual(limit);
    }
  });
});
