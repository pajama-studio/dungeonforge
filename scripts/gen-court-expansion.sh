#!/usr/bin/env bash
# Twenty more inhabitants for the drowned court.
#
# Same style contract as the existing sixteen, quoted verbatim from
# catalog/drowned-court.json so the new arrivals cut from the same rock: they
# will stand in the same rooms, and a statue that reads as a different material
# is worse than no statue.
#
# Deliberately not more hooded figures. The court already has a chorister, a
# penitent, an anchorite and a bishop; what it lacks is silhouette variety —
# things that are wide, coiled, pinned, fused or simply wrong-shaped. Each
# prompt below leads with the SHAPE, because that is what survives at the
# distance these are seen from.
#
# 30 credits per model + 20 per texture = 50 each, 1000 for the set.
set -euo pipefail

OUT="${1:-tripo-out/court-expansion}"
mkdir -p "$OUT"

STYLE="colossal weathered stone statue, ancient eroded granite monument,
hand-painted stylized stone, chunky faceted carved planes, moss and cracks,
dark grey stone, near-neutral and desaturated, matte, no pedestal, no ground
plane, Lovecraftian drowned-city mood"

gen() {
  local slug="$1" subject="$2"
  if [ -f "$OUT/$slug.done" ]; then echo "  = $slug (already done)"; return; fi
  tripo make "$subject, $STYLE" \
    --model tripo-v3.1 --for game-pc --then texture \
    --name "court-$slug" --out "$OUT/$slug" \
    --yes --quiet --no-open --json > "$OUT/$slug.json" 2> "$OUT/$slug.log" \
    && { touch "$OUT/$slug.done"; echo "  + $slug"; } \
    || echo "  FAILED $slug (see $OUT/$slug.log)"
}

gen conch-herald          "a herald whose entire head is a great spiral conch shell, one arm raised mid-proclamation"
gen mourning-colossus     "an enormous seated figure with both hands pressed over its face, shoulders hunched in grief"
gen lamprey-saint         "a standing saint whose mouth is a circular lamprey ring of teeth, arms folded in benediction"
gen coral-cardinal        "a robed cardinal so overgrown with branching coral that the robe and the coral are one mass"
gen abyssal-midwife       "a crouching figure cradling a huge clutch of eggs against its belly, protective and hunched"
gen rib-lantern-bearer    "a gaunt figure holding out a lantern woven from its own ribs, chest cavity open"
gen fused-twins           "two figures fused back to back at the spine, facing opposite directions, arms interlocked"
gen spiral-ascetic        "an ascetic whose body twists into a tall helix from the waist up, arms wrapped around itself"
gen carapace-magistrate   "a seated magistrate with a crab carapace for a head, claws resting on the arms of a throne"
gen thousand-mouth-pillar "a thick column entirely covered in open screaming mouths of different sizes"
gen kelp-shepherd         "a hooded shepherd trailing long ropes of kelp from its arms and staff, leaning into a current"
gen eyeless-navigator     "a navigator holding a sextant to a face with no eyes at all, head tilted upward"
gen gill-choir            "one broad body carrying three heads on separate necks, gills open along every throat"
gen drowned-bride         "a veiled bride whose veil has turned to stone mid-billow, spread wide behind her"
gen anchor-martyr         "a figure pinned to the ground beneath an enormous ship anchor, one arm reaching out"
gen tentacle-scribe       "a hunched scribe bent over a tablet, every finger a writhing tentacle"
gen nautilus-reliquary    "a kneeling figure holding a huge nautilus shell above its head like an offering"
gen bloated-oracle        "a grossly swollen seated oracle, skin split into plates, tiny head atop a vast body"
gen hookjaw-warden        "an armoured warden whose lower jaw is an enormous curved hook, spear planted"
gen starspawn-fledgling   "a small winged cephalopod creature crouched with folded wings, too many limbs tucked under"

echo
tripo balance
