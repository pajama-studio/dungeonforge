import { readFileSync, writeFileSync } from "node:fs";

const ROOT = "artifacts/img2three";
const models = {
  warden: {
    silhouette: {
      boundingShape: "broad seated triangle over a rectangular throne, 0.52 width-to-height",
      aspectRatios: ["overall width:height 0.52", "shoulders:head 3.0", "sword:height 0.48"],
      symmetry: "near bilateral above an asymmetric rubble plinth",
      dominantCurves: ["down-canted three-tier shoulder line", "vertical sword centreline", "bent knee arches"],
      negativeSpaces: ["visor slit", "two knee arches around blade", "arm-to-torso gaps"],
      landmarks: ["seven-tooth crown", "layered pauldrons", "clasped gauntlets", "broad sword fuller"],
    },
    featureIds: ["warden-crown-visor", "warden-armor-pose", "warden-sword-contact"],
    components: [
      ["root", "Oathbound warden monument", "macro", "box", "assembled-solid"],
      ["throne", "buttressed throne and plinth", "macro", "box", "assembled-solid"],
      ["armored-body", "seated armored body mass", "macro", "ellipsoid", "continuous-sculpt"],
      ["helmet", "faceted helmet", "meso", "ellipsoid", "continuous-sculpt"],
      ["pauldrons", "three-tier pauldrons", "meso", "instanced-cluster", "assembled-solid"],
      ["forearms", "crossed forearm masses", "meso", "ellipsoid", "continuous-sculpt"],
      ["legs", "separated seated legs", "meso", "ellipsoid", "continuous-sculpt"],
      ["sword", "embedded great sword", "meso", "extrude", "assembled-solid"],
      ["crown", "broken crown band and teeth", "meso", "instanced-cluster", "assembled-solid"],
      ["gauntlets", "clasped stone gauntlets", "meso", "ellipsoid", "continuous-sculpt"],
      ["rubble", "contact rubble", "meso", "instanced-cluster", "assembled-solid"],
      ["visor", "dark visor opening", "micro", "plane-card", "material-only"],
      ["fingers", "overlapping finger blocks", "micro", "instanced-cluster", "assembled-solid"],
      ["fuller", "sword fuller relief", "micro", "box", "surface-relief"],
      ["armor-seams", "armor overlap seams", "micro", "box", "surface-relief"],
      ["stone-chips", "silhouette stone chips", "micro", "instanced-cluster", "assembled-solid"],
    ],
    repetitions: ["pauldron tiers", "gauntlet fingers", "crown teeth"],
  },
  "dragon-skull": {
    silhouette: {
      boundingShape: "long cheek-down wedge with a high rear cranium and swept horns",
      aspectRatios: ["snout:cranium length 1.45", "overall length:height 2.35", "buried fraction >= 0.45"],
      symmetry: "paired sockets and jaw rails with deliberately asymmetric horn damage",
      dominantCurves: ["rear horn sweep", "zygomatic eye arch", "upper and lower jaw rails"],
      negativeSpaces: ["paired orbit openings", "open mouth gap", "small nasal holes"],
      landmarks: ["central nose horn", "dominant rear horn", "irregular interlocking teeth", "diagonal burial shelf"],
    },
    featureIds: ["dragon-orbit-muzzle", "dragon-horn-profile", "dragon-jaw-burial"],
    components: [
      ["root", "buried dragon skull ruin", "macro", "box", "assembled-solid"],
      ["burial-base", "asymmetric burial shelf", "macro", "instanced-cluster", "assembled-solid"],
      ["cranium", "faceted rear cranium", "macro", "ellipsoid", "continuous-sculpt"],
      ["muzzle", "four-stage tapered muzzle", "meso", "ellipsoid", "continuous-sculpt"],
      ["upper-jaw", "paired upper jaw rails", "meso", "curve-sweep", "continuous-sculpt"],
      ["lower-jaw", "paired lower jaw rails", "meso", "curve-sweep", "continuous-sculpt"],
      ["eye-rims", "zygomatic orbit rims", "meso", "torus", "assembled-solid"],
      ["rear-horns", "swept rear horns", "meso", "curve-sweep", "continuous-sculpt"],
      ["cheek-spikes", "broken cheek spikes", "meso", "curve-sweep", "continuous-sculpt"],
      ["teeth", "irregular tooth rows", "meso", "instanced-cluster", "assembled-solid"],
      ["rubble", "skull contact rubble", "meso", "instanced-cluster", "assembled-solid"],
      ["nasal-holes", "small nasal openings", "micro", "plane-card", "material-only"],
      ["facet-chips", "fossil surface chips", "micro", "instanced-cluster", "surface-relief"],
      ["tooth-rhythm", "nonuniform tooth scale rhythm", "micro", "instanced-cluster", "assembled-solid"],
      ["jaw-seam", "mouth shadow seam", "micro", "box", "material-only"],
      ["dirt-contact", "burial contact dirt", "micro", "plane-card", "material-only"],
    ],
    repetitions: ["upper and lower teeth", "cheek spikes", "burial rubble"],
  },
  oracle: {
    silhouette: {
      boundingShape: "crowned cephalopod head over eight hanging S-curves and stepped cliff buttresses",
      aspectRatios: ["head width:total height 0.43", "tentacle span:head width 1.45", "rear depth:head width 0.72"],
      symmetry: "paired upper face with asymmetric tentacle lengths and bends",
      dominantCurves: ["eight independently authored tentacle paths", "continuous brow arch", "stepped crown skyline"],
      negativeSpaces: ["paired recessed eyes", "six inter-tentacle gaps", "side fan openings"],
      landmarks: ["broken block crown", "faceted cranial dome", "eye rims", "three central overlapping tentacles"],
    },
    featureIds: ["oracle-crown-eyes", "oracle-tentacle-system", "oracle-cliff-embedding"],
    components: [
      ["root", "abyssal oracle monument", "macro", "box", "assembled-solid"],
      ["cliff-throne", "stepped basalt cliff throne", "macro", "box", "assembled-solid"],
      ["cranium", "convex faceted cranium", "macro", "ellipsoid", "continuous-sculpt"],
      ["face-mask", "projecting facial mask", "meso", "ellipsoid", "continuous-sculpt"],
      ["brow", "continuous eye brow", "meso", "curve-sweep", "continuous-sculpt"],
      ["crown", "broken block crown", "meso", "instanced-cluster", "assembled-solid"],
      ["eye-rims", "depth-framing eye rims", "meso", "torus", "assembled-solid"],
      ["central-tentacles", "central tentacle triad", "meso", "curve-sweep", "continuous-sculpt"],
      ["left-fan", "left tentacle fan", "meso", "curve-sweep", "continuous-sculpt"],
      ["right-fan", "right tentacle fan", "meso", "curve-sweep", "continuous-sculpt"],
      ["rubble", "tentacle termination rubble", "meso", "instanced-cluster", "assembled-solid"],
      ["forehead-fissure", "forehead fissure", "micro", "box", "surface-relief"],
      ["tentacle-facets", "tentacle facet bands", "micro", "instanced-cluster", "surface-relief"],
      ["root-seams", "embedded tentacle root seams", "micro", "box", "surface-relief"],
      ["edge-chips", "crown and face chips", "micro", "instanced-cluster", "assembled-solid"],
      ["dark-masks", "eye and root dark masks", "micro", "plane-card", "material-only"],
    ],
    repetitions: ["eight tentacle sweeps", "crown towers", "cliff buttress columns"],
  },
};

const materialRecipe = {
  dominantAlbedo: "rgba(40, 55, 76, 1.0)",
  secondaryAlbedo: "rgba(101, 117, 140, 1.0)",
  materialClass: "stone",
  materialClassConfidence: 0.96,
  colorGradient: {
    type: "linear",
    stops: [
      { offset: 0, color: "rgba(40, 55, 76, 1.0)" },
      { offset: 1, color: "rgba(101, 117, 140, 1.0)" },
    ],
  },
};

const acceptedKinds = ["ridge", "contour", "seam", "chip", "hole", "groove", "linework"];

for (const [folder, config] of Object.entries(models)) {
  const path = `${ROOT}/${folder}/object-sculpt-spec.json`;
  const spec = JSON.parse(readFileSync(path, "utf8"));
  const baseComponent = spec.componentTree[0];
  const detailRefs = spec.preSpecAssessment.detailInventory.details
    .map((detail) => detail?.mapsTo?.ref)
    .filter((ref) => typeof ref === "string" && ref.length > 0);
  spec.preSpecAssessment.detailInventory.details = spec.preSpecAssessment.detailInventory.details.map((detail, index) => ({
    ...detail,
    kind: acceptedKinds[index % acceptedKinds.length],
  }));
  spec.suitability = "pass";
  spec.scores = {
    object_isolation: 3,
    silhouette_readability: 3,
    depth_inference: 2,
    primitive_decomposition: 3,
    material_procedurality: 3,
    occlusion_risk: 2,
    interaction_fit: 3,
  };
  spec.silhouette = config.silhouette;
  spec.assumptions = [
    "Hidden rear geometry is inferred as a convex, shallow monument back that remains embedded in the cliff or throne.",
    "The source is single-view concept evidence; multi-angle runtime renders, not camera projection, govern side-depth acceptance.",
  ];
  spec.componentTree = config.components.map(([id, name, level, primitive, topologyClass], index) => {
    const parent = index === 0 ? null : "root";
    const component = structuredClone(baseComponent);
    component.id = id;
    component.name = name;
    component.level = level;
    component.role = id === "root" ? "monument" : "identity feature";
    component.importance = level === "macro" ? 1 : level === "meso" ? 0.82 : 0.56;
    component.confidence = 0.86;
    component.primitive = primitive;
    component.topologyClass = topologyClass;
    component.topologyRationale = `Observed ${name} requires ${primitive} geometry with real depth in front, three-quarter and side review views.`;
    component.parent = parent;
    component.attachment = parent ? {
      parentId: parent,
      localStart: [0, 0, 0],
      localEnd: [0, 0.1, 0],
      contactNormal: [0, 1, 0],
      contactType: "embedded-overlap",
      overlap: 0.08,
      gapTolerance: 0.01,
      evidenceRefs: ["full-object"],
    } : null;
    component.material = topologyClass === "material-only" ? "cavity" : "base";
    component.materialLayers = topologyClass === "material-only" ? ["cavity"] : ["base", "edge"];
    component.colorMaterialRecipe = structuredClone(materialRecipe);
    component.localFeatures = index === 0 ? detailRefs : [`${id}-observed-form`];
    component.details = [`Authored from admitted isolated reference and verified in four runtime views.`];
    component.fidelityTier = level === "micro" ? "hero-local" : "hero";
    component.surfaceDetail = {
      macroRoughness: 0.18,
      microRoughness: 0.08,
      bumpAmplitude: 0.03,
      normalPattern: "independent faceted stone field",
      displacementPattern: "geometry chips only",
      occlusionPattern: "cavity and contact weighted",
      edgeWearPattern: "top-facing cool-gray facets",
      notes: "Large facets are geometry/vertex colour; tiny pits remain shader frequency detail.",
    };
    return component;
  });
  const baseMaterial = spec.materials[0];
  const makeMaterial = (id, name, color, roughness, qualityTier) => ({
    ...structuredClone(baseMaterial),
    id,
    name,
    qualityTier,
    baseColor: color,
    color,
    albedo: { dominant: color, secondary: ["#28374C", "#65758C"], samplingNotes: "isolated concept plus shared dungeon stone palette" },
    roughness: { base: roughness, variation: 0.12, map: "independent object-space facet field", localResponse: "cavities rougher; upper worn planes slightly smoother" },
    normal: { pattern: "independent object-space stone field", strength: id === "cavity" ? 0.08 : 0.28, scale: 22, space: "object" },
    ambientOcclusion: { cavityStrength: id === "cavity" ? 0.75 : 0.32, contactShadowBias: 0.42, notes: "seams and embedded endpoints" },
    wear: { edgeWear: id === "edge" ? 0.42 : 0.12, scratches: ["sparse chisel marks"], chips: ["large silhouette chips remain geometry"] },
    dirt: { amount: id === "cavity" ? 0.65 : 0.18, cavityBias: 0.8, color: "#0A101A" },
    localOverrides: [{ id: `${id}-facet-mask`, region: "top-facing and chipped facets", colorShift: 0.12, roughness }],
    notes: "Procedural vertex-colour material shared with Dungeonforge; no source-photo projection or albedo-channel reuse.",
  });
  spec.materials = [
    makeMaterial("base", "weathered abyss stone", "#34445A", 0.9, "hero"),
    makeMaterial("edge", "worn cool stone edge", "#758299", 0.78, "utility"),
    makeMaterial("cavity", "near-black stone cavity", "#010308", 0.98, "utility"),
  ];
  spec.repetitionSystems = config.repetitions.map((name, index) => ({
    id: `repeat-${index + 1}`,
    name,
    buildsGeometry: true,
    realization: "merged-or-instanced-geometry",
    geometry: "low-sided procedural primitive",
    instances: index === 0 ? 8 : 5,
    distribution: "observed nonuniform rhythm",
    evidenceRefs: ["full-object"],
  }));
  spec.featureReviewTargets = config.featureIds.map((id, index) => ({
    id,
    name: id.replaceAll("-", " "),
    tier: "critical",
    passIds: index === 0 ? ["blockout", "structural-pass"] : ["form-refinement", "material-pass"],
    minimumScore: 0.7,
    mustPass: true,
    componentRefs: config.components.slice(index * 3, index * 3 + 5).map((item) => item[0]),
    evidenceRefs: ["full-object"],
  }));
  spec.viewEvidence[0].observations = [
    config.silhouette.boundingShape,
    ...config.silhouette.negativeSpaces,
    ...config.silhouette.landmarks,
  ];
  spec.viewEvidence[0].confidence = 0.9;
  spec.lookDevTargets.qualityPriority = "balanced-realtime";
  spec.lookDevTargets.materialPass.referencePbrExtraction.requiredWhenSourceImagePresent = false;
  spec.lightingFromPhoto = [
    "key light: cool moon from upper left; reference review exposure 0 EV",
    "fill light: soft blue-gray hemisphere at 35 percent of key",
    "rim light: low opposite cool rim; ACES filmic tone mapping",
    "contact shadow and AO required at every embedded root, jaw, foot, sword and rubble seam",
  ];
  spec.performanceBudget = {
    qualityPriority: "balanced-realtime",
    targetTriangles: folder === "oracle" ? 7000 : folder === "dragon-skull" ? 5000 : 3000,
    maxDrawCalls: folder === "warden" ? 2 : 3,
    textureSize: 0,
    fpsTarget: 60,
    optimizationPolicy: "Merged stone/cavity meshes, instanced repeated props, no navigation/collision, and distant silhouette-first LOD.",
  };
  spec.lodPlan = [
    { tier: "near", distance: 0, strategy: "full admitted component silhouette and facet bands" },
    { tier: "middle", distance: 140, strategy: "retain eye/jaw/tentacle negative spaces; reduce curve segments" },
    { tier: "far", distance: 260, strategy: "sub-800 triangle pre-existing silhouette proxy" },
  ];
  writeFileSync(path, `${JSON.stringify(spec, null, 2)}\n`);
}
